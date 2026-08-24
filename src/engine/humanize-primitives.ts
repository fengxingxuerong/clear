/**
 * 趣AI味 · 共享引擎原语：mulberry32 可复现随机源、句长统计、劈句点查找。
 * 核心替换 / 机械扰动 / 评分三方共用，全部纯函数、零副作用。
 */
import { fragmentCanStand } from "./humanize-vocab";
import { splitSentences } from "./humanize-text";

/* ----------------------------- 共享引擎原语 ----------------------------- */
// 由 humanize.ts（核心替换）、humanize-metrics.ts（评分/指纹）、humanize-shuffle.ts（机械扰动）
// 三方共用，故下沉到此层，避免模块间循环依赖。全部纯函数、零副作用。

/** 文风预设：控制朱雀增强特征的开关门控 */
export type RewriteStyle = "casual" | "plain" | "academic";

/** 去味参数：核心引擎、机械扰动与评分共用 */
export interface HumanizeOptions {
  /** 去味强度 0~1，越大改得越狠（默认 0.6） */
  intensity?: number;
  /** 随机种子，固定后结果可复现 */
  seed?: number;
  /** 朱雀增强模式：开启后激活额外对抗特征（方言、插入语、句式片段、主观意见、标点不规整等），
   *  针对 AI 文本检测器（朱雀/知网等）的统计特征做定向干扰。强度 ≥0.5 时自动启用。 */
  zhuqueMode?: boolean;
  /** 文风预设：casual=自然口语（朱雀特征全开）/ plain=平实书面（禁方言/网络梗，保留结构操作）
   *  / academic=学术体（禁方言/网络梗/主观意见，保留结构操作）。 */
  style?: RewriteStyle;
}

/** 句长变异系数最低阈值（节奏兜底与指纹体检共用） */
export const MIN_BURSTINESS_CV = 0.45;

/** mulberry32 伪随机源：零依赖、可复现（seed 固定则序列固定） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 可复现随机源：seed 缺省时按当前时间取种；offset 用于同一流程内互不干扰的多个随机流 */
export function makeRng(seed?: number, offset = 0): () => number {
  return mulberry32((seed ?? Date.now() & 0xffffffff) + offset);
}

export interface SentenceStats {
  count: number;
  lens: number[];
  avg: number;
  std: number;
  cv: number;
}

export function computeStats(lens: number[]): { avg: number; std: number; cv: number } {
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const std = lens.length
    ? Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length)
    : 0;
  return { avg, std, cv: avg > 0 ? std / avg : 0 };
}

/** 句长统计：句子数、句长数组、均值、标准差、变异系数（CV 越大节奏越跳脱）。
 *  评分 / 指纹体检 / 节奏兜底共用，避免多处重复实现。 */
export function sentenceStats(text: string): SentenceStats {
  const sentences = splitSentences(text);
  const lens = sentences.map((s) => s.replace(/[。！？!?；;\n]/g, "").length);
  const { avg, std, cv } = computeStats(lens);
  return { count: lens.length, lens, avg, std, cv };
}

/** 在句中找可安全劈开的位置：30%~70% 区间内的逗号，且后半句能独立成句（fragmentCanStand）。
 *  minLen 为最短句长门槛；找不到返回 -1。 */
export function findSplitPoint(s: string, minLen: number): number {
  if (s.length < minLen) return -1;
  const commas: number[] = [];
  let ci = s.indexOf("，");
  while (ci !== -1) {
    commas.push(ci);
    ci = s.indexOf("，", ci + 1);
  }
  const mid = commas.find((c) => c > s.length * 0.3 && c < s.length * 0.7);
  if (mid === undefined) return -1;
  if (!fragmentCanStand(s.slice(mid + 1).trim())) return -1;
  return mid;
}
