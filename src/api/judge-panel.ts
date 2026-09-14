/**
 * 趣AI味 · v0.9.3 多网关合议庭（Judge Panel）
 * ---------------------------------------------------------
 * 背景（2026-09-12 实测）：单裁判判别力不足——glm-5.2 与 deepseek-v4-pro 对
 * 人工评审确认「可过真人审查」的稿子分别打 62/85/90 与 68/82/68（双模型
 * 交叉均值也无法恢复判别力），且单模型 temperature=0 采样方差达 29 分。
 * 「换宽评模型」已证伪：宽严是「模型×文本」交互属性，不是固定旋钮。
 *
 * 合议庭设计（借鉴内容评审的人工合议机制）：
 *  1. 多网关独立裁判：每席一个独立 {baseUrl, apiKey, model}——不同推理栈、
 *     不同训练分布，偏置不相关；
 *  2. 痕迹交叉定罪：只有 ≥2 席在痕迹语义上重合的指控才进入修订清单——
 *     单席的孤证（模型偏置/抽风）降权，两票重合的才是真痕迹；
 *  3. 分数聚合用中位数（抗离群），并返回「席间分歧度」供上层判断可信度；
 *  4. 席位故障不连坐：单席失败/超时只是少一票，三席全挂才抛错回退单裁判。
 *
 * 通道清单（2026-09-12 宿主 curl 实测）：
 *  · SenseNova https://token.sensenova.cn/v1（5 模型，429 限流需冷却）
 *  · AMD https://developer.amd.com.cn/radeon/api/v1（DeepSeek-V4-Flash，1.0s）
 *  · NVIDIA https://integrate.api.nvidia.com/v1（z-ai/glm-5.3-flash，2.7s；
 *    glm-5.2 已 410 下线；kimi-k3 超时未确认）
 *  · OpenRouter stealth/ox-alpha 已 404（改 glm-5.3-flash 但 Key 402 余额不足）
 */

import { ApiConfig } from "./llm-config";
import { chat } from "./llm-chat";
import { errMsg } from "./llm-judge";

/** 合议庭单席：独立网关 + 模型 + 该席权重 */
export interface JudgeSeat {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 席位权重（默认 1；主力通道可设更高） */
  weight?: number;
  /** 思考型模型 token 预算（glm 系 ≥4000 才有 content） */
  maxTokens?: number;
}

/** 合议庭聚合结果 */
export interface PanelResult {
  /** 加权中位数分（0-100） */
  score: number;
  /** ≥2 席重合的痕迹（喂修订轮的定向清单） */
  critique: string[];
  /** 每席明细（可见化：哪席打了多少分、留了什么痕迹） */
  seats: { id: string; score: number | null; critique: string[]; error?: string }[];
  /** 席间分歧度：满分差（0=完全一致，越大越不可信）。null=有效票 <2 */
  spread: number | null;
  /** 有效席数 */
  validCount: number;
}

/** 痕迹语义归一：不同裁判对同一问题的表述差异（「句长均匀」vs「句子长度过于一致」）
 *  归并到同一罪名桶，交叉计数才有效。窄桶设计：只归并高频同义词，不强行聚类。 */
const CRITIQUE_NORMALIZERS: [RegExp, string][] = [
  [/句长|句子长度|长短.*均匀|节奏.*平|均匀|长度一致/, "句长过于均匀"],
  [/过渡词|连接词|衔接词|首先.*其次|总而言之|综上所述/, "过渡词/套话残留"],
  [/对仗|排比|平行结构|工整/, "对仗工整/排比"],
  [/书面|书面化|学术腔|公文体|措辞.*正式/, "词汇书面化"],
  [/标点|符号规整|标点.*一致|全角/, "标点过于规整"],
  [/虚构|编造|杜撰|例子.*假|事例.*不存在/, "虚构人物事例"],
  [/口语.*模仿|口语化.*痕迹|刻意.*口语|装.*口语/, "口语化模仿痕迹"],
  [/逻辑.*顺|顺序.*乱|跳跃|承接/, "逻辑顺序问题"],
  [/重复|复读|雷同|重复使用/, "用词重复"],
];

function normalizeCritique(c: string): string {
  for (const [re, bucket] of CRITIQUE_NORMALIZERS) {
    if (re.test(c)) return bucket;
  }
  return c.length <= 12 ? c : "其他痕迹";
}

/** 痕迹交叉：桶内票数 ≥minVotes（默认 2）才入选。返回桶名（带原表述示例）。 */
function crossVoteCritiques(
  seatCritiques: { id: string; critique: string[] }[],
  minVotes = 2,
): string[] {
  const buckets = new Map<string, { votes: Set<string>; example: string }>();
  for (const seat of seatCritiques) {
    for (const c of seat.critique) {
      const bucket = normalizeCritique(c);
      const entry = buckets.get(bucket) ?? { votes: new Set<string>(), example: c };
      entry.votes.add(seat.id);
      if (entry.votes.size === 1) entry.example = c;
      buckets.set(bucket, entry);
    }
  }
  const out: string[] = [];
  for (const [, { votes, example }] of buckets) {
    if (votes.size >= minVotes) {
      out.push(votes.size === seatCritiques.length ? example : `${example}（${votes.size}/${seatCritiques.length} 席指出）`);
    }
  }
  return out.slice(0, 5);
}

/** 加权中位数：按权重展开后取中位 */
function weightedMedian(scores: { score: number; weight: number }[]): number {
  const expanded: number[] = [];
  for (const { score, weight } of scores) {
    const w = Math.max(1, Math.round(weight));
    for (let i = 0; i < w; i++) expanded.push(score);
  }
  expanded.sort((a, b) => a - b);
  const m = Math.floor(expanded.length / 2);
  return expanded.length % 2 ? expanded[m] : Math.round((expanded[m - 1] + expanded[m]) / 2);
}

/**
 * 合议庭审判：各席独立评（痕迹+分数）→ 痕迹交叉 ≥2 票定罪 → 分数加权中位。
 * 席间串行调用（跨网关并发易触发各家限流；单席 ≤90s 超时内建）。
 * systemOverride 透传（朱雀语义层提示词复用）。
 */
export async function judgeByPanel(
  text: string,
  seats: JudgeSeat[],
  systemOverride?: string,
): Promise<PanelResult> {
  if (seats.length === 0) throw new Error("合议庭无席位");
  const results: PanelResult["seats"] = [];
  for (const seat of seats) {
    const cfg: ApiConfig = {
      enabled: true,
      baseUrl: seat.baseUrl,
      apiKey: seat.apiKey,
      model: seat.model,
      temperature: 0,
      deepMode: false,
      judgeModel: "",
      altModel: "",
      style: "casual",
    };
    try {
      const r = await chat(
        cfg,
        [
          {
            role: "system",
            content:
              systemOverride ||
              "你是 AI 文本检测员。第一步：逐条列出这段中文文本残留的 AI 写作痕迹（如：句长过于均匀/过渡词残留/对仗工整/词汇书面化/标点过于规整/虚构人物事例/口语化模仿痕迹等），最多 5 条，每条不超过 15 个字，一行一条。第二步：最后一行单独输出一个 0 到 100 的整数，表示这段文本有多像 AI 写的（100=绝对是AI生成，0=绝对是人写的）。按真实判断打分，不要刻意从严或从宽。除了痕迹清单和最后的数字，不要输出任何其他内容。",
          },
          { role: "user", content: text },
        ],
        { temperature: 0, maxTokens: seat.maxTokens ?? 8000, model: seat.model },
      );
      // 复用 judgeWithCritique 的解析器（需要喂完整响应体——直接内联解析避免重复请求）
      const body = (r.content || r.reasoning || "").trim();
      const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let score: number | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/^(?:\D*?)(\d{1,3})(?:\D*)$/);
        if (m) {
          const s = parseInt(m[1], 10);
          if (s >= 0 && s <= 100) {
            score = s;
            break;
          }
        }
      }
      if (score === null && r.reasoning) {
        const nums = r.reasoning.match(/\d+/g);
        if (nums && nums.length) {
          score = Math.max(0, Math.min(100, parseInt(nums[nums.length - 1], 10)));
        }
      }
      if (score === null) throw new Error("无有效分数");
      let scoreLineIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\D*?\d{1,3}\D*$/.test(lines[i])) {
          scoreLineIdx = i;
          break;
        }
      }
      const critique = lines
        .slice(0, scoreLineIdx === -1 ? lines.length : scoreLineIdx)
        .map((l) => l.replace(/^[\d①②③④⑤][.、）)]?\s*/, "").slice(0, 30))
        .filter((l) => l && !/^\d+$/.test(l))
        .slice(0, 5);
      results.push({ id: seat.id, score, critique });
    } catch (e) {
      // 席位故障不连坐：记录错误，继续下一席
      results.push({ id: seat.id, score: null, critique: [], error: errMsg(e).slice(0, 80) });
    }
  }
  const valid = results.filter((r) => r.score !== null);
  if (valid.length === 0) {
    throw new Error(`合议庭全部席位失败：${results.map((r) => `${r.id}:${r.error}`).join("；")}`);
  }
  const seatById = new Map(seats.map((s) => [s.id, s]));
  const score = weightedMedian(
    valid.map((r) => ({ score: r.score as number, weight: seatById.get(r.id)?.weight ?? 1 })),
  );
  const critique = crossVoteCritiques(valid.map((r) => ({ id: r.id, critique: r.critique })));
  const sortedScores = valid.map((r) => r.score as number).sort((a, b) => a - b);
  const spread =
    sortedScores.length >= 2 ? sortedScores[sortedScores.length - 1] - sortedScores[0] : null;
  return { score, critique, seats: results, spread, validCount: valid.length };
}
