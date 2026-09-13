/**
 * 趣AI味 · LLM 去味流程：单轮改写 与 深度多轮闭环（质检+交叉评判+定向修订）
 */

import { ApiConfig, ADAPTIVE_CONTEST_CHARS, DEEP_MAX_ROUNDS, DEEP_TARGET_SCORE } from "./llm-config";
import {
  SYSTEM_PROMPT,
  buildRevisionPrompt,
  intensityDirective,
  styleDirective,
} from "./llm-prompts";
import { chat, resetApiCallCount, getApiCallCount } from "./llm-chat";
import { processCandidate } from "./llm-quality";
import { restoreMixedSpacing } from "../engine/humanize-shuffle.ts";
import { errMsg } from "./llm-judge";

/* ----------------------------- 去味 ----------------------------- */

/** v0.8.8 评判员宽严自适应：动态达标线 = max(绝对目标, 首轮分 × 此比例)。
 *  依据：2026-09-07 真实实测，glm-5.2 交叉评判对双模型竞争胜出稿仍打 86/91——
 *  绝对目标 10（按宽评评判员标定）在严评下永不达标，只能靠预算白烧收场。
 *  以首轮正分为宽严锚点后：严评（首轮 86）→ 目标 ≤31；宽评（首轮 45）→ ≤16；
 *  首轮已很低（≤28）→ 维持绝对目标不变。0.35 对两种宽严都落在
 *  "改写稿显著优于底稿"的语义带内，且不需要按模型硬编码宽严表。 */
const RELATIVE_TARGET_RATIO = 0.35;

/** 组装改写用的 system 提示词（基础战术 + 文风预设 + 强度档位） */
export function buildSystemPrompt(cfg: ApiConfig, intensity: number): string {
  return SYSTEM_PROMPT + styleDirective(cfg.style) + intensityDirective(intensity);
}

/** 单轮 LLM 去味 */
export async function humanizeViaApi(
  text: string,
  cfg: ApiConfig,
  intensity = 0.6,
): Promise<string> {
  const { content } = await chat(
    cfg,
    [
      { role: "system", content: buildSystemPrompt(cfg, intensity) },
      { role: "user", content: text },
    ],
    { temperature: cfg.temperature, maxTokens: 16000 },
  );
  // 空输出视为失败：让上层回退本地引擎，而不是把空串当去味结果
  if (!content) {
    throw new Error("模型返回空内容（思考型模型 token 预算耗尽，可重试或换非思考型模型）");
  }
  // v0.8.9：回填被 LLM 压掉的中英/中数空格（提示词管不住，改确定性后处理）
  return restoreMixedSpacing(text, content);
}

/**
 * v0.8.9 P0：空响应降级重试。
 *
 * 背景：深度闭环实测在第 2 轮拿到空 content 就直接 break——首轮明明改写成功，说明模型可用，
 * 空响应多为偶发（思考型模型 reasoning 吃光 max_tokens / 网关抖动 / 修订指令过长）。
 * 原实现不重试、不换模型，242s 后把「首轮 60 分、目标 21」的未达标稿静默交付。
 *
 * 降级链：默认参数 → token 预算翻倍 → 换备选模型，任一环节拿到非空内容即返回。
 * 已超调用预算时不再重试，避免把时间/额度烧在重试上。
 */
async function chatNonEmpty(
  cfg: ApiConfig,
  messages: { role: "system" | "user"; content: string }[],
  opts: { temperature: number; maxTokens: number; model?: string },
  altModel: string,
  isOverBudget: () => boolean,
): Promise<{ content: string; via: string }> {
  const attempts: { model?: string; maxTokens: number; label: string }[] = [
    { model: opts.model, maxTokens: opts.maxTokens, label: "" },
    { model: opts.model, maxTokens: Math.min(32000, opts.maxTokens * 2), label: "token 预算翻倍" },
  ];
  if (altModel && altModel !== opts.model) {
    attempts.push({ model: altModel, maxTokens: opts.maxTokens, label: `换模型 ${altModel}` });
  }
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0 && isOverBudget()) break;
    try {
      const r = await chat(cfg, messages, {
        temperature: opts.temperature,
        maxTokens: attempts[i].maxTokens,
        model: attempts[i].model,
      });
      if (r.content) return { content: r.content, via: attempts[i].label };
    } catch {
      // 单档失败交给下一档降级；全部失败由调用方按空内容处理
    }
  }
  return { content: "", via: "" };
}

/** v0.9.4 P2：去空白字符数之比（产出/原文），作为压缩率口径 */
function shrinkRatioOf(original: string, output: string): number {
  const chars = (s: string) => s.replace(/\s+/g, "").length;
  const o = chars(original);
  if (o <= 0) return 1;
  return +(chars(output) / o).toFixed(2);
}

export interface DeepResult {
  text: string;
  /** 每轮改写后的 LLM 评分（中位数），如 [45, 18, 7] */
  roundScores: number[];
  /** v0.8.8：本次闭环实际使用的达标分（评判锚点放宽后可能高于绝对目标） */
  targetUsed: number;
  /** 达标（≤target）提前收手时为 true */
  hitTarget: boolean;
  /** 中途收场原因（如第 N 轮限流），无则空串 */
  note: string;
  /** 各轮质检（通顺+忠实）结果 */
  qcPassed: boolean[];
  /** 最后一轮未修复的质检问题（展示用） */
  qcIssues: string[];
  /** v0.9.4 P2 压缩率：去空白后 产出字数 / 原文字数。LLM 改写系统性压缩 25~44%，
   *  UI/note 需要让用户知情（本地引擎是注水 +8~22%，两者方向相反）。 */
  shrinkRatio?: number;
}

/** 深度去味闭环：改写 →（机械扰动）→ 质检 → 交叉评判 → 未达标按痕迹定向修订，
 *  全程保留"质检通过且评分最低"版本。v0.5.1：配置 altModel 时首轮双模型竞争择优。 */
export async function humanizeViaApiDeep(
  text: string,
  cfg: ApiConfig,
  onProgress?: (round: number, score: number | null, stage?: string) => void,
  target = DEEP_TARGET_SCORE,
  maxRounds = DEEP_MAX_ROUNDS,
  intensity = 0.6,
  /** v0.8.6 分块场景：调用预算跨块共享。true 时不清零计数器，
   *  由调用方（llm.ts 分块循环）在整篇开始前 reset 一次，maxApiCalls 对整篇生效
   *  而非按块重置。单篇独立调用保持默认 false，行为不变。 */
  budgetShared = false,
): Promise<DeepResult> {
  const startTime = Date.now();
  // 用户设的最长等待时间（秒）：0 = 不限制
  const maxWaitSec = cfg.maxWaitSeconds || 0;
  // v0.8.5 调用预算（次）：0 = 不限制。轮间检查，轮内不中断。
  const maxCalls = cfg.maxApiCalls || 0;
  if (!budgetShared) resetApiCallCount(); // 闭环从零计数（历史调用不占本次预算）；分块共享预算时由外层统一 reset
  const isOverBudget = () =>
    (maxWaitSec > 0 && (Date.now() - startTime) / 1000 > maxWaitSec) ||
    (maxCalls > 0 && getApiCallCount() >= maxCalls);
  const budgetReason = () =>
    maxCalls > 0 && getApiCallCount() >= maxCalls
      ? `已达调用上限 ${maxCalls} 次（实际 ${getApiCallCount()} 次）`
      : `已达最长等待 ${maxWaitSec}s`;
  const roundScores: number[] = [];
  const qcPassed: boolean[] = [];
  let bestText = "";
  let bestScore = Infinity;
  let hitTarget = false;
  let lastCritique: string[] = [];
  let qcIssues: string[] = [];
  let note = "";
  let writerModel: string | undefined; // 竞争胜者覆盖后续修订轮的改写模型
  // v0.8.8 评判锚点：以首个有效正分为宽严锚点（全程只锚一次，后续轮不再抬锚，
  // 避免"越改越宽"），有效目标 = max(绝对目标, 首轮分 × RELATIVE_TARGET_RATIO)
  let anchorScore: number | null = null;
  const effTarget = () =>
    anchorScore === null
      ? target
      : Math.max(target, Math.round(anchorScore * RELATIVE_TARGET_RATIO));

  // v0.5.1 双改写器竞争：主模型与备选模型各写一版第一稿，交叉评分择优当底稿。
  // 依据 A/B 实测：glm-5.2 改写被 deepseek 判 35，deepseek 改写被 glm 判 75（两样本一致）——
  // 不同模型的改写强项差异巨大，让它们赛一场比押注单模型稳。
  // v0.8.9 扩展：未配 altModel 时，可用同一模型多采样竞争（cfg.contestSamples ≥ 2）。
  // 依据：实测同一 temperature=0.9 的改写稿质量在 20~88 分之间横跳（极差 89），
  // 而评判尺子极稳（同文本重复评判极差 2）——瓶颈是改写采样的运气，多采几稿取最优最直接。
  const alt = cfg.altModel.trim();
  const contestants: string[] = [];
  // v0.9.5 竞争段自适应：长文赛马实测必超时（1200 字 420s 零产出），自动降级
  // 为仅主力模型首稿；短文保持赛马（pro 在小说等体裁有真收益，s6: 14 vs 39）
  const longText = text.replace(/\s+/g, "").length > ADAPTIVE_CONTEST_CHARS;
  if (alt && alt !== cfg.model && !longText) {
    contestants.push(cfg.model, alt);
  } else if (!longText) {
    const n = Math.max(1, Math.min(5, Math.floor(cfg.contestSamples ?? 1)));
    for (let i = 0; i < n; i++) contestants.push(cfg.model);
  } else {
    contestants.push(cfg.model);
  }
  const multiContest = contestants.length > 1;
  // v0.9.5：长文单候选路径的可见化说明（竞争段块内不会执行，在此预置 note，
  // 后续主循环的锚点/预算 note 均为追加式，不会被覆盖丢失）
  if (!multiContest && longText) {
    note = `长文自适应（>${ADAPTIVE_CONTEST_CHARS} 字）：跳过多模型赛马，仅主力模型改写`;
  }
  if (multiContest) {
    const contestInfo: string[] = [];
    for (let ci = 0; ci < contestants.length; ci++) {
      const m = contestants[ci];
      // 同模型多次采样时给日志加序号，否则 N 条记录长得一模一样没法排查
      const tag = `${m}#${ci + 1}`;
      // v0.8.6 竞争段接入调用预算：每个竞争者开跑前检查（与主循环"轮间检查"同语义），
      // 超预算不再发起竞争调用——此前竞争段计入计数却不受约束，极小预算配置下
      // 会先烧穿 maxApiCalls 才轮到主循环首次检查
      if (isOverBudget()) {
        contestInfo.push(`${tag}:预算已耗尽跳过`);
        continue;
      }
      try {
        // v0.8.9：竞争段同样走空响应降级重试；altModel 传空——本段已是多候选竞争，
        // 不再嵌套"换模型"档，避免调用数不可控
        const r = await chatNonEmpty(
          cfg,
          [
            { role: "system", content: buildSystemPrompt(cfg, intensity) },
            { role: "user", content: text },
          ],
          { temperature: cfg.temperature, maxTokens: 8000, model: m },
          "",
          isOverBudget,
        );
        if (!r.content) {
          contestInfo.push(`${tag}:空输出`);
          continue;
        }
        const cand = await processCandidate(text, r.content, cfg, intensity);
        qcPassed.push(cand.qc.pass);
        if (!cand.qc.pass) {
          contestInfo.push(`${tag}:质检未过`);
          qcIssues = cand.qc.issues;
          continue;
        }
        roundScores.push(cand.score ?? -1);
        if (cand.score !== null && cand.score >= 0 && anchorScore === null)
          anchorScore = cand.score;
        contestInfo.push(`${tag}:${cand.score ?? "?"}`);
        const sc = cand.score ?? 999;
        if (sc < bestScore) {
          bestScore = sc;
          bestText = cand.shuffled;
          lastCritique = cand.critique;
          writerModel = m;
        }
        onProgress?.(1, cand.score, `竞争 ${tag} `);
      } catch {
        contestInfo.push(`${tag}:调用失败`);
      }
    }
    note = `双模型竞争（${contestInfo.join("，")}）`;
    // v0.8.9：竞争段有多个有效分时，锚点取<b>最优（最低）</b>分而非首个——首个分只是
    // "第一次采样的运气"，用它标定宽严会把达标线抬松。实测三候选 85/70/70，
    // 用首个分定锚 → 达标线 ≤30；用最优分 70 定锚 → ≤24，才反映真实可达水平。
    if (anchorScore === null && bestScore < 999) anchorScore = bestScore;
    if (bestText && bestScore <= effTarget()) {
      return {
        text: bestText,
        roundScores,
        hitTarget: true,
        note,
        qcPassed,
        qcIssues,
        targetUsed: effTarget(),
        shrinkRatio: shrinkRatioOf(text, bestText),
      };
    }
  }

  const startRound = bestText ? 2 : 1;
  for (let round = startRound; round <= maxRounds; round++) {
    // 预算控制：超时或超调用次数，带当前最优结果收场
    if (isOverBudget()) {
      if (bestText) {
        note = `${budgetReason()}，返回第 ${round - 1} 轮最优结果`;
      } else {
        note = `${budgetReason()}，无可用结果`;
      }
      break;
    }
    // 单轮失败（限流耗尽/网络）不丢掉已完成成果：有 bestText 就带结果收场
    let content: string;
    let retryVia: string | undefined; // v0.8.9：记录本轮靠哪档降级重试拿到的内容（undefined=未重试）
    try {
      const userMsg = bestText
        ? buildRevisionPrompt(
            bestText,
            bestScore > 100 ? 50 : bestScore, // 无分底稿（999）按 50 计；失败标记/-1 不进提示词
            effTarget(),
            lastCritique,
          )
        : text; // 没有可用底稿（如前轮质检全挂）就重新改写原文
      // v0.8.9 P0：空响应不再直接放弃，走降级重试（token 预算翻倍 / 换备选模型）
      const r = await chatNonEmpty(
        cfg,
        [
          { role: "system", content: buildSystemPrompt(cfg, intensity) },
          { role: "user", content: userMsg },
        ],
        {
          temperature: Math.min(2, cfg.temperature + (round - 1) * 0.05),
          maxTokens: 8000,
          model: writerModel,
        },
        alt,
        isOverBudget,
      );
      content = r.content;
      retryVia = r.via;
    } catch (e: unknown) {
      if (bestText) {
        note = `第 ${round} 轮调用失败（${errMsg(e)}），返回已有最优结果`;
        break;
      }
      throw e;
    }
    if (!content && bestText) {
      // v0.8.9：带痕迹清单的修订 prompt 长度与指令复杂度都远高于首轮，是空响应高发区。
      // 降级重试仍为空时，退回"纯原文重改写"（不带 critique）再给一次机会——
      // 拿到内容就继续闭环，拿不到才带已有最优结果收场。
      const fb = await chatNonEmpty(
        cfg,
        [
          { role: "system", content: buildSystemPrompt(cfg, intensity) },
          { role: "user", content: text },
        ],
        { temperature: cfg.temperature, maxTokens: 8000, model: writerModel },
        alt,
        isOverBudget,
      );
      if (fb.content) {
        content = fb.content;
        retryVia = retryVia ? `${retryVia}+纯原文重改写` : "纯原文重改写";
      }
    }
    if (!content) {
      if (!bestText) {
        throw new Error("模型返回空内容（思考型模型 token 预算耗尽，可重试或换非思考型模型）");
      }
      // v0.8.9：已走完降级重试仍为空才放弃，并把重试情况写进 note 让 UI 可见
      note = `第 ${round} 轮模型返回空内容${retryVia ? `（已重试：${retryVia}）` : "（降级重试亦为空）"}，返回已有最优结果`;
      break;
    }

    const cand = await processCandidate(text, content, cfg, intensity);
    qcPassed.push(cand.qc.pass);
    if (cand.qc.pass) qcIssues = []; // 后续轮通过即清空——最终稿以返回稿对应轮为准报状态

    if (!cand.qc.pass) {
      qcIssues = cand.qc.issues;
      // 弃用本轮，并把质检问题喂给下一轮修订（优先保义再降 AI 味）
      lastCritique = cand.qc.issues;
      if (!bestText && round === maxRounds) {
        throw new Error(`各轮质检均未通过（${cand.qc.issues[0] ?? "原因未知"}），已回退本地引擎`);
      }
      continue;
    }

    const score = cand.score;
    if (score !== null && score >= 0) {
      if (anchorScore === null) anchorScore = score;
      roundScores.push(score);
      lastCritique = cand.critique;
    } else {
      roundScores.push(-1); // 评分失败不阻断流程，标记 -1
    }
    onProgress?.(round, score);

    if (score !== null && score >= 0) {
      // 达标优先：本轮达标即收，若同时是最低分则更新底稿
      if (score <= effTarget()) {
        hitTarget = true;
        // 达标即最优（后续不再更新），直接落底稿后退出
        if (score < bestScore) {
          bestText = cand.shuffled;
        }
        break;
      }
      // v0.8.9 未改进即停：本轮分数不优于当前最优 = 修订没带来收益，立即收手。
      // 实测修订轮频繁反向优化（76→88；三候选底稿 70、修订后 89），继续只会白烧预算。
      // 早前版本按"高于上一轮"判定，但上一轮基线不含竞争段最优分，
      // 于是出现"竞争稿 70、修订稿 89"仍继续跑下一轮的情况。改用 bestScore 作基线：
      // 初值 999（哨兵）保证首轮必然优于它，不会误停。
      if (score >= bestScore) {
        // v0.9.5：追加式而非覆盖——保留竞争段的"长文自适应"等前置说明
        note =
          (note ? `${note}；` : "") +
          `第 ${round} 轮未优于当前最优（${bestScore} → ${score}），修订无收益，停止后续轮次`;
        break;
      }
      bestScore = score;
      bestText = cand.shuffled;
    } else if (!bestText) {
      // 评分失败但质检已过，兜底保留；分数记 999（劣于一切真实分），
      // 不能用 -1 —— 那会让后续真实分数永远赢不了它（best-of 被哨兵污染）
      bestText = cand.shuffled;
      bestScore = 999;
    }
  }

  // 零轮完成（预算耗尽/轮数为 0 且无任何产出）不能把空串当结果：
  // 抛错让上层 runHumanize 回退本地引擎，与单轮空输出守卫对齐
  if (!bestText) {
    throw new Error((note || "深度去味未获得任何可用结果") + "，已回退本地引擎");
  }

  // v0.9.5 P1：严格保真补偿轮与收稿终审已移除——编造复核前移至 processCandidate
  // （每候选质检后即审，走既有修复链），所有产出路径的候选均已被复核覆盖；
  // 补偿轮「拿弃用候选的问题清单修最优稿」的语义错位随之消除。

  // v0.8.8 评判锚点可见化：达标线被放宽时写进 note，用户知道为什么"分高也算达标"
  const targetUsed = effTarget();
  if (anchorScore !== null && targetUsed > target) {
    note =
      (note ? `${note}；` : "") + `评判锚点：首轮 ${anchorScore} 分 → 达标线放宽至 ≤${targetUsed}`;
  }
  // v0.8.9：闭环提前收场且未达标时必须说清楚——此前 UI 静默交付"看起来完成"的未达标稿
  if (!hitTarget && roundScores.length > 0) {
    note =
      (note ? `${note}；` : "") +
      `仅完成 ${roundScores.length} 轮，未达目标 ≤${targetUsed} 分，结果可能仍偏 AI（可重试或换改写模型）`;
  }
  return {
    text: bestText,
    roundScores,
    hitTarget,
    note,
    qcPassed,
    qcIssues,
    targetUsed,
    shrinkRatio: shrinkRatioOf(text, bestText),
  };
}
