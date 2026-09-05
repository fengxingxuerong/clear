/**
 * 可选 API 适配器（OpenAI 兼容）· 统一入口
 * 默认不开启；用户填了 baseUrl / apiKey / model 才走 LLM 去味，
 * 失败自动回退本地引擎。所有配置只存在本地，不上传。
 *
 * v0.3 深度去味；v0.5 长文分块。实现已按域拆分到同目录各模块，
 * 本文件保留统一再导出与 runHumanize 分发入口。
 */

export * from "./llm-config";
export * from "./llm-prompts";
export * from "./llm-chat";
export * from "./llm-chunk";
export * from "./llm-quality";
export * from "./llm-humanize";
export * from "./llm-judge";

import { humanize, aiScore, checkFidelityLocal, crossChunkCleanup } from "../engine/humanize";
import { humanizeBestOf } from "../engine/humanize-bestof";
import { ApiConfig, DEEP_MAX_ROUNDS, DEEP_TARGET_SCORE, effectiveKeys } from "./llm-config";
import { CHUNK_THRESHOLD, splitIntoChunks } from "./llm-chunk";
import { humanizeViaApi, humanizeViaApiDeep } from "./llm-humanize";
import { errMsg } from "./llm-judge";

export interface RunResult {
  text: string;
  before: ReturnType<typeof aiScore>;
  after: ReturnType<typeof aiScore>;
  usedApi: boolean;
  note: string;
  /** 深度模式各轮评分 */
  roundScores: number[];
  /** 多候选择优信息（仅本地引擎路径有） */
  bestOf?: { tried: number; rejected: number; seed: number };
}

/** 本地引擎选项：多候选择优 */
export interface LocalOptions {
  bestOf?: boolean;
  candidates?: number;
}

/** 本地引擎统一出口：按是否开启择优分流（API 失败回退同样尊重该设置） */
function runLocal(
  text: string,
  intensity: number,
  zhuqueMode: boolean | undefined,
  genre: "main" | "narrative" | "dialogue" | "humanHand" | undefined,
  style: ApiConfig["style"],
  local?: LocalOptions,
): { text: string; after: ReturnType<typeof aiScore>; bestOf: RunResult["bestOf"] } {
  if (local?.bestOf) {
    const r = humanizeBestOf(text, { intensity, zhuqueMode, style, genre, candidates: local.candidates });
    return { text: r.text, after: r.after, bestOf: { tried: r.tried, rejected: r.rejected, seed: r.seed } };
  }
  const out = humanize(text, { intensity, zhuqueMode, style, genre });
  return { text: out, after: aiScore(out), bestOf: undefined };
}

/** 统一分发：优先 API（深度/单轮），失败回退本地引擎 */
export async function runHumanize(
  text: string,
  intensity: number,
  cfg: ApiConfig,
  onProgress?: (round: number, score: number | null, stage?: string) => void,
  zhuqueMode?: boolean,
  genre?: "main" | "narrative" | "dialogue" | "humanHand",
  local?: LocalOptions,
): Promise<RunResult> {
  const before = aiScore(text);
  let usedApi = false;
  let note = "";
  let outText: string;
  let roundScores: number[] = [];
  let bestOf: RunResult["bestOf"];

  if (cfg.enabled && effectiveKeys(cfg).length > 0) {
    try {
      // 长文分块（v0.5.0）：超阈值按段落切块逐块处理再拼接，避免长上下文中段质量衰减
      const visibleLen = text.replace(/\s/g, "").length;
      if (visibleLen > CHUNK_THRESHOLD) {
        const chunks = splitIntoChunks(text);
        const parts: string[] = [];
        const allScores: number[] = [];
        const allQc: boolean[] = [];
        let anyIssue = false;
        for (let i = 0; i < chunks.length; i++) {
          const stage = `块 ${i + 1}/${chunks.length} `;
          if (cfg.deepMode) {
            // 每块深度闭环但轮数收敛到 2（块多时控制总时长）
            const deep = await humanizeViaApiDeep(
              chunks[i],
              cfg,
              (r, sc) => onProgress?.(r, sc, stage),
              DEEP_TARGET_SCORE,
              2,
              intensity,
            );
            parts.push(deep.text);
            allScores.push(...deep.roundScores);
            allQc.push(...deep.qcPassed);
            if (deep.qcIssues.length) anyIssue = true;
          } else {
            parts.push(await humanizeViaApi(chunks[i], cfg, intensity));
          }
        }
        outText = parts.join("\n\n");
        // 跨块反指纹清理：各块独立去味时"每块各出现一次"的垫词/破折号/段首过渡词
        // 在块边界会累积成新指纹——拼接后做全文级限额去重（零改写）
        outText = crossChunkCleanup(outText);
        usedApi = true;
        const fid = checkFidelityLocal(text, outText);
        note =
          `长文分块处理（${chunks.length} 块）` +
          (allScores.length
            ? `：各块评分 ${allScores.map((x) => (x < 0 ? "失败" : x)).join("、")}`
            : "") +
          (allQc.length ? ` · 质检 ${allQc.filter(Boolean).length}/${allQc.length} 通过` : "") +
          (fid.pass ? "" : ` · ⚠️忠实度：${fid.problems[0]}`) +
          (anyIssue ? " · 部分块有未修复质检问题" : "");
        // v0.8.6 LLM 主导：API 输出即最终稿，不再叠加本地朱雀特征（方言/自问自答/错别字
        // 注入会污染 LLM 的语义级改写）。反检测特征由提示词 19 条战术原生产出。
        return {
          text: outText,
          before,
          after: aiScore(outText),
          usedApi,
          note,
          roundScores: allScores,
        };
      }
      if (cfg.deepMode) {
        const deep = await humanizeViaApiDeep(
          text,
          cfg,
          onProgress,
          DEEP_TARGET_SCORE,
          DEEP_MAX_ROUNDS,
          intensity,
        );
        outText = deep.text;
        roundScores = deep.roundScores;
        usedApi = true;
        const shown = deep.roundScores.map((s) => (s < 0 ? "失败" : s)).join(" → ");
        const qcOk = deep.qcPassed.filter(Boolean).length;
        const qcSummary = deep.qcPassed.length
          ? ` · 质检 ${qcOk}/${deep.qcPassed.length} 轮通过${deep.qcIssues.length ? "（最终稿有未修复问题：" + deep.qcIssues[0] + "…）" : ""}`
          : "";
        note =
          (deep.hitTarget
            ? `深度去味达标：各轮评分 ${shown}`
            : deep.note
              ? `${deep.note}：各轮评分 ${shown}`
              : `深度去味完成（未压到 ${DEEP_TARGET_SCORE} 以下）：各轮评分 ${shown}`) + qcSummary;
      } else {
        outText = await humanizeViaApi(text, cfg, intensity);
        // 单轮 LLM 输出同样过反指纹清理（垫词去重/破折号限额/套话清除/空格清理），
        // 与深度模式的机械扰动层对齐反指纹下限
        outText = crossChunkCleanup(outText);
        usedApi = true;
      }
    } catch (e: unknown) {
      // 回退本地引擎时同样尊重择优设置
      const r = runLocal(text, intensity, zhuqueMode, genre, cfg.style, local);
      outText = r.text;
      bestOf = r.bestOf;
      note = `API 调用失败，已回退本地引擎：${errMsg(e)}`;
    }
  } else {
    const r = runLocal(text, intensity, zhuqueMode, genre, cfg.style, local);
    outText = r.text;
    bestOf = r.bestOf;
  }

  // v0.8.6 LLM 主导：API 输出即最终稿，不再叠加本地朱雀特征（方言/自问自答/错别字注入
  // 会污染 LLM 的语义级改写并制造新指纹）——反检测特征由提示词 19 条战术原生产出；
  // 朱雀增强（zhuqueMode）仅作用于本地引擎路径（runLocal 内部处理）。

  const after = aiScore(outText);
  return { text: outText, before, after, usedApi, note, roundScores, bestOf };
}
