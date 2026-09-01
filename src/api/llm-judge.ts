/**
 * 趣AI味 · LLM 评判：带痕迹评分、中位数稳健聚合、双模型交叉
 */

import { ApiConfig } from "./llm-config";
import { chat } from "./llm-chat";

/* ----------------------------- 评判 ----------------------------- */

export interface JudgeResult {
  score: number;
  /** 检测员指出的残留 AI 痕迹（最多 5 条），喂给修订轮做定向消除 */
  critique: string[];
}

/** 带痕迹的评判：先列痕迹再打分。让模型"给出依据再下结论"，
 *  打分自洽性远高于裸打分（裸打同一文本能 10~72 乱跳）。
 *  systemOverride：自定义检测员提示词（朱雀语义层用它换上"篇章层检测"战术）。 */
export async function judgeWithCritique(
  text: string,
  cfg: ApiConfig,
  modelOverride?: string,
  systemOverride?: string,
): Promise<JudgeResult> {
  const { content, reasoning } = await chat(
    cfg,
    [
      {
        role: "system",
        content: systemOverride ||
          "你是 AI 文本检测员。第一步：逐条列出这段中文文本残留的 AI 写作痕迹（如：句长过于均匀/过渡词残留/对仗工整/词汇书面化/标点过于规整/虚构人物事例/口语化模仿痕迹等），最多 5 条，每条不超过 15 个字，一行一条。第二步：最后一行单独输出一个 0 到 100 的整数，表示这段文本有多像 AI 写的（100=绝对是AI生成，0=绝对是人写的）。按真实判断打分，不要刻意从严或从宽。除了痕迹清单和最后的数字，不要输出任何其他内容。",
      },
      { role: "user", content: text },
    ],
    { temperature: 0, maxTokens: 8000, model: modelOverride },
  );

  const parse = (body: string): JudgeResult | null => {
    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // 从后往前找"独立成行的 0-100 整数"作为分数行
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^(?:\D*?)(\d{1,3})(?:\D*)$/);
      if (m) {
        const score = parseInt(m[1], 10);
        if (score >= 0 && score <= 100) {
          const critique = lines
            .slice(0, i)
            .map((l) => l.replace(/^[\d①②③④⑤][.、）)]?\s*/, "").slice(0, 30))
            .filter((l) => l && !/^\d+$/.test(l))
            .slice(0, 5);
          return { score, critique };
        }
      }
    }
    return null;
  };

  const fromContent = content ? parse(content) : null;
  if (fromContent) return fromContent;
  // 思考型模型偶发 content 空：从 reasoning 兜底取最后的数字
  const nums = reasoning.match(/\d+/g);
  if (nums && nums.length) {
    return { score: Math.max(0, Math.min(100, parseInt(nums[nums.length - 1], 10))), critique: [] };
  }
  throw new Error("评判失败：模型未给出数字");
}

export interface StableJudgeResult {
  score: number;
  /** 交叉模型的痕迹清单（如有）；单模型模式取最后一次成功的 */
  critique: string[];
}

/** 统一错误转文案（unknown 收窄，替代散落的 `e?.message || e`） */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 中位数：偶数样本取中间两值的均值（评判分数对离群值敏感，中位数比均值稳） */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** 稳健评分：配置了交叉评判模型时，主模型与交叉模型各评 1 次取均值（1+1，
 *  兼顾去自评偏差与速度——glm-5.2 单次要 15~20s）；未配置时同一模型评 3 次取中位数。
 *  顺带返回交叉模型的痕迹清单，省掉深度闭环里单独再取一次痕迹的调用。
 *  systemOverride：透传给 judgeWithCritique（朱雀语义层专用提示词）。 */
export async function judgeScoreStable(
  text: string,
  cfg: ApiConfig,
  samples = 3,
  systemOverride?: string,
): Promise<StableJudgeResult> {
  const cross = cfg.judgeModel.trim() && cfg.judgeModel.trim() !== cfg.model;
  const plan: (string | undefined)[] = cross
    ? [undefined, cfg.judgeModel.trim()]
    : Array.from({ length: samples }, () => undefined);
  const scores: number[] = [];
  let critique: string[] = [];
  let lastErr: unknown = null;
  for (const model of plan) {
    try {
      const r = await judgeWithCritique(text, cfg, model, systemOverride);
      scores.push(r.score);
      if (model)
        critique = r.critique; // 优先保留交叉模型的痕迹（视角不同，更犀利）
      else if (!critique.length) critique = r.critique;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!scores.length) throw lastErr instanceof Error ? lastErr : new Error("评判失败");
  const score = cross
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) // 交叉模式：1 主 + 1 交叉取均值
    : median(scores); // 单模型模式：多次采样取中位数
  return { score, critique };
}

/**
 * 用已配置的 LLM 当"评判员"，给文本打 AI 味分（0~100）。
 * 这是除本地代理分之外的一个"真实"参考：有 API Key 就能用，不依赖特定检测器。
 */
export async function judgeAiScore(text: string, cfg: ApiConfig): Promise<number> {
  const { content, reasoning } = await chat(
    cfg,
    [
      {
        role: "system",
        content:
          "你是 AI 文本检测员。只回答一个 0 到 100 的整数，表示这段中文文本有多像 AI 写的。100 表示绝对是 AI 生成，0 表示绝对是人写的。按你的真实判断打分，不要刻意从严或从宽。不要任何解释、不要标点。",
      },
      { role: "user", content: text },
    ],
    { temperature: 0, maxTokens: 8000 },
  );
  // 思考型模型偶发 content 为空（token 预算被思考吃光）：回退从 reasoning 里取最后的数字
  const fromContent = content.match(/\d+/);
  if (fromContent) return Math.max(0, Math.min(100, parseInt(fromContent[0], 10)));
  const allNums = reasoning.match(/\d+/g);
  if (allNums && allNums.length) {
    return Math.max(0, Math.min(100, parseInt(allNums[allNums.length - 1], 10)));
  }
  throw new Error("评判失败：模型未给出数字");
}
