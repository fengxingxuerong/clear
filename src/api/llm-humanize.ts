/**
 * 趣AI味 · LLM 去味流程：单轮改写 与 深度多轮闭环（质检+交叉评判+定向修订）
 */

import { ApiConfig, DEEP_MAX_ROUNDS, DEEP_TARGET_SCORE } from "./llm-config";
import { SYSTEM_PROMPT, buildRevisionPrompt, intensityDirective, styleDirective } from "./llm-prompts";
import { chat, resetApiCallCount, getApiCallCount } from "./llm-chat";
import { processCandidate } from "./llm-quality";
import { errMsg } from "./llm-judge";

/* ----------------------------- 去味 ----------------------------- */

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
  return content;
}

export interface DeepResult {
  text: string;
  /** 每轮改写后的 LLM 评分（中位数），如 [45, 18, 7] */
  roundScores: number[];
  /** 达标（≤target）提前收手时为 true */
  hitTarget: boolean;
  /** 中途收场原因（如第 N 轮限流），无则空串 */
  note: string;
  /** 各轮质检（通顺+忠实）结果 */
  qcPassed: boolean[];
  /** 最后一轮未修复的质检问题（展示用） */
  qcIssues: string[];
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
): Promise<DeepResult> {
  const startTime = Date.now();
  // 用户设的最长等待时间（秒）：0 = 不限制
  const maxWaitSec = cfg.maxWaitSeconds || 0;
  // v0.8.5 调用预算（次）：0 = 不限制。轮间检查，轮内不中断。
  const maxCalls = cfg.maxApiCalls || 0;
  resetApiCallCount(); // 闭环从零计数（历史调用不占本次预算）
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

  // v0.5.1 双改写器竞争：主模型与备选模型各写一版第一稿，交叉评分择优当底稿。
  // 依据 A/B 实测：glm-5.2 改写被 deepseek 判 35，deepseek 改写被 glm 判 75（两样本一致）——
  // 不同模型的改写强项差异巨大，让它们赛一场比押注单模型稳。
  const alt = cfg.altModel.trim();
  if (alt && alt !== cfg.model) {
    const contestInfo: string[] = [];
    for (const m of [cfg.model, alt]) {
      try {
        const r = await chat(
          cfg,
          [
            { role: "system", content: buildSystemPrompt(cfg, intensity) },
            { role: "user", content: text },
          ],
          { temperature: cfg.temperature, maxTokens: 8000, model: m },
        );
        if (!r.content) {
          contestInfo.push(`${m}:空输出`);
          continue;
        }
        const cand = await processCandidate(text, r.content, cfg, intensity);
        qcPassed.push(cand.qc.pass);
        if (!cand.qc.pass) {
          contestInfo.push(`${m}:质检未过`);
          qcIssues = cand.qc.issues;
          continue;
        }
        roundScores.push(cand.score ?? -1);
        contestInfo.push(`${m}:${cand.score ?? "?"}`);
        const sc = cand.score ?? 999;
        if (sc < bestScore) {
          bestScore = sc;
          bestText = cand.shuffled;
          lastCritique = cand.critique;
          writerModel = m;
        }
        onProgress?.(1, cand.score, `竞争 ${m} `);
      } catch {
        contestInfo.push(`${m}:调用失败`);
      }
    }
    note = `双模型竞争（${contestInfo.join("，")}）`;
    if (bestText && bestScore <= target) {
      return { text: bestText, roundScores, hitTarget: true, note, qcPassed, qcIssues };
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
    try {
      const userMsg = bestText
        ? buildRevisionPrompt(
            bestText,
            bestScore > 100 ? 50 : bestScore, // 无分底稿（999）按 50 计；失败标记/-1 不进提示词
            target,
            lastCritique,
          )
        : text; // 没有可用底稿（如前轮质检全挂）就重新改写原文
      const r = await chat(
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
      );
      content = r.content;
    } catch (e: unknown) {
      if (bestText) {
        note = `第 ${round} 轮调用失败（${errMsg(e)}），返回已有最优结果`;
        break;
      }
      throw e;
    }
    if (!content) {
      if (!bestText) {
        throw new Error("模型返回空内容（思考型模型 token 预算耗尽，可重试或换非思考型模型）");
      }
      note = `第 ${round} 轮模型返回空内容，返回已有最优结果`;
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
      roundScores.push(score);
      lastCritique = cand.critique;
    } else {
      roundScores.push(-1); // 评分失败不阻断流程，标记 -1
    }
    onProgress?.(round, score);

    if (score !== null && score >= 0) {
      if (score < bestScore) {
        bestScore = score;
        bestText = cand.shuffled;
      }
      if (score <= target) {
        hitTarget = true;
        break;
      }
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

  return { text: bestText, roundScores, hitTarget, note, qcPassed, qcIssues };
}
