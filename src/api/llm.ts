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
import { resetApiCallCount } from "./llm-chat";
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
  /** v0.9.4 P2 压缩率（去空白产出/原文，仅 API 路径）：UI 知情用 */
  shrinkRatio?: number;
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
    const r = humanizeBestOf(text, {
      intensity,
      zhuqueMode,
      style,
      genre,
      candidates: local.candidates,
    });
    return {
      text: r.text,
      after: r.after,
      bestOf: { tried: r.tried, rejected: r.rejected, seed: r.seed },
    };
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
  // v0.9.4 P1 边界守卫：超短文本透传。实测「短。」发给 LLM 被当成用户指令，
  // 模型回复「好的，请把原文发给我」这类元话语并拿到 3 分"达标"——质检与评判
  // 都识别不了"答非所问"。10 字以内直接跳过 API 路径（本地引擎同样透传）。
  if (text.replace(/\s+/g, "").length < 10 && text.trim()) {
    return {
      text,
      before,
      after: before,
      usedApi: false,
      note: "文本过短（去空白 <10 字），跳过去味",
      roundScores: [],
    };
  }
  let usedApi = false;
  let note = "";
  let outText: string;
  let roundScores: number[] = [];
  let bestOf: RunResult["bestOf"];
  let shrinkRatio: number | undefined;

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
        // v0.8.6 调用预算跨块共享：整篇 reset 一次，各块累计计数，
        // maxApiCalls 语义从"每块一次"修正为"整篇一次"
        resetApiCallCount();
        for (let i = 0; i < chunks.length; i++) {
          const stage = `块 ${i + 1}/${chunks.length} `;
          if (cfg.deepMode) {
            // 每块深度闭环但轮数收敛到 2（块多时控制总时长）；
            // budgetShared=true：不清零计数，块间继承已消耗预算
            try {
              const deep = await humanizeViaApiDeep(
                chunks[i],
                cfg,
                (r, sc) => onProgress?.(r, sc, stage),
                DEEP_TARGET_SCORE,
                2,
                intensity,
                true,
              );
              parts.push(deep.text);
              allScores.push(...deep.roundScores);
              allQc.push(...deep.qcPassed);
              if (deep.qcIssues.length) anyIssue = true;
            } catch {
              // 单块失败（如预算耗尽且该块零产出/各轮质检全挂）只回退该块本地引擎，
              // 不再让整篇抛错丢弃已完成块的 API 成果（v0.8.6 行为修正）
              // v0.9.5 P4：回退块强制温和档（≤0.5、不开朱雀）——深度稿是自然口语，
              // 全强度机械扰动产物（垫词/语气词/句序打乱）混进来是质量断崖
              // （s7 事故实测：后 1/3 出现"是啊/对哦"堆叠与断引用）。温和档只做
              // 套话与连接词清理，与 LLM 稿的风格落差最小。
              parts.push(humanize(chunks[i], { intensity: Math.min(intensity, 0.5) }));
              anyIssue = true;
            }
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
        // v0.9.4 P2：整篇压缩率（含单块本地回退的混拼结果，按最终拼稿算）
        const rc = (s: string) => s.replace(/\s+/g, "").length;
        shrinkRatio = rc(text) > 0 ? +(rc(outText) / rc(text)).toFixed(2) : undefined;
        const shrinkNote =
          shrinkRatio !== undefined && shrinkRatio < 0.8
            ? ` · 字数压缩 ${Math.round((1 - shrinkRatio) * 100)}%`
            : "";
        note =
          `长文分块处理（${chunks.length} 块）` +
          (allScores.length
            ? `：各块评分 ${allScores.map((x) => (x < 0 ? "失败" : x)).join("、")}`
            : "") +
          (allQc.length ? ` · 质检 ${allQc.filter(Boolean).length}/${allQc.length} 通过` : "") +
          (fid.pass ? "" : ` · ⚠️忠实度：${fid.problems[0]}`) +
          (anyIssue ? " · 部分块有未修复质检问题" : "") +
          shrinkNote;
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
        // v0.9.5：qcIssues 现在只记录"最后一轮被弃用候选"的问题——交付稿必然
        // 通过全部检查（质检+硬门槛+编造复核），文案同步修正避免误导
        const qcSummary = deep.qcPassed.length
          ? ` · 质检 ${qcOk}/${deep.qcPassed.length} 轮通过${deep.qcIssues.length ? "（最后一轮候选被弃用：" + deep.qcIssues[0] + "…，交付稿为通过全部检查的最优稿）" : ""}`
          : "";
        // v0.9.4 P2：压缩超 20% 时显式告知（LLM 改写系统性缩水，用户需知情）
        const shrinkNote =
          deep.shrinkRatio !== undefined && deep.shrinkRatio < 0.8
            ? ` · 字数压缩 ${Math.round((1 - deep.shrinkRatio) * 100)}%`
            : "";
        note =
          (deep.hitTarget
            ? `深度去味达标：各轮评分 ${shown}`
            : deep.note
              ? `${deep.note}：各轮评分 ${shown}`
              : `深度去味完成（未压到 ${deep.targetUsed} 以下）：各轮评分 ${shown}`) +
          qcSummary +
          shrinkNote;
        shrinkRatio = deep.shrinkRatio;
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
  // v0.9.4 P2 迭代收益提示：实测深度模式对已去味文本（AI 味 <35 分）再处理
  // 收益趋零（31→30）且白烧 5~10 分钟——信息提示不拦截，用户自行决定
  const tip =
    before.probability < 35 && usedApi
      ? "（提示：输入 AI 味已较低，本轮收益有限；重复/串联去味不建议）"
      : "";
  return {
    text: outText,
    before,
    after,
    usedApi,
    note: (note + (tip ? ` ${tip}` : "")).trim(),
    roundScores,
    bestOf,
    shrinkRatio,
  };
}
