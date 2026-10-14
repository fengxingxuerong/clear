/**
 * humanize-syntax.ts —— 「句式工整度」独立指标 ⚠️ **未通过验收，已废弃**
 *
 * 📍 **已移出 src/engine/ → artifacts/experiments/**（2026-10-14）：
 *    未接入任何产品路径，留在源码目录只会被误 import。相对 import 路径已失效，
 *    要复现实验请改回 src/engine/ 或用 tsx 直接跑（它无外部依赖）。
 *
 * ## 状态：作废（2026-10-14）
 *
 * 设计它是为了补一个当时认为存在的盲区（「aiScore 对句式/语体无感」）。
 * 后续实验证明：
 *   ① **那个盲区不存在**——干净实验（`artifacts/mutator/style-probe.ts`，确定性替换
 *      14 处口语词、不删字不加套话）下 aiScore **+6 正向响应**。之前的"盲区"结论
 *      源于把 `calibration-data-v2-genres.json` 里 `level="原文"` 的 **AI 腔文本**
 *      误当成人写真值（详见 `_audit-baseline.ts` 的审计）。
 *   ② **本指标选错了维度**：它测「句法平行结构 / 段末总结句」，而 aiScore 已经覆盖
 *      了「词汇书面度」。实测在纯语体替换上它 **−0.1**（无感），aiScore **+6**。
 *   ③ 与 aiScore **判别模式高度重合**：44 对标注对里 aiScore 70%、本指标 77%、
 *      "任一报警"仍是 77%（无互补增益）。
 *
 * 为什么文件还在：① 换成「词汇书面度」方向重做时这里是起点与踩坑记录；
 * ② `measure-syntax.ts` 的对照实验仍需要它跑基线。
 * ⚠️ **不导出到 index、不接 CLI/UI、不进任何门禁与棘轮**。
 */

/** 平行结构标记（成对出现才算一次，取左半边计数） */
const PARALLEL_RE =
  /不仅[^。！？]{0,20}(?:而且|还|更)|一方面[^。！？]{0,24}另一方面|既[^。！？]{1,12}又[^。！？]{1,12}|首先[^。！？]{0,12}其次|从[^。！？]{1,10}来看[，,][^。！？]{1,20}来看/g;
/** 段末总结句 */
const SUMMARY_TAIL_RE =
  /综上所述|总而言之|由此可见|不难看出|可以看出|由此可见的|总体而言|一言以蔽之/g;
/** 显式列举（一是/二是/三是、1./2./3.） */
const ENUM_RE = /[一二三四五六七八九十]是[，,、]|第[一二三]点|\n\s*[（(]?[一二三1-3][）).、]/g;

export interface SyntaxRegularityBreakdown {
  /** 0~100，越高越"句式工整"（越可疑）。**与 aiScore 无任何换算关系** */
  score: number;
  /** 平行结构命中数 */
  parallelism: number;
  /** 段末总结句命中数 */
  summaryTail: number;
  /** 显式列举命中数 */
  enumerated: number;
  /** 段长变异系数（0 = 每段一样长） */
  segLenCV: number;
  chars: number;
  paras: number;
  /** 命中样例（给人看的，不参与打分） */
  samples: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function syntaxRegularity(text: string): SyntaxRegularityBreakdown {
  const t = (text || "").trim();
  const chars = t.length;
  const paras = t.split(/\n\s*\n|\n/).filter((p) => p.trim().length >= 20);
  const base = {
    parallelism: (t.match(PARALLEL_RE) || []).length,
    summaryTail: (t.match(SUMMARY_TAIL_RE) || []).length,
    enumerated: (t.match(ENUM_RE) || []).length,
    chars,
    paras: Math.max(1, paras.length),
  };
  // 段长变异系数
  const lens = paras.map((p) => p.trim().length);
  const meanLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  let varSum = 0;
  for (const l of lens) varSum += (l - meanLen) ** 2;
  const sd = lens.length ? Math.sqrt(varSum / lens.length) : 0;
  const segLenCV = meanLen ? Number((sd / meanLen).toFixed(3)) : 0;

  // 打分：四个分项归一化后加权，全部按"每千字/每段"口径，与文本长度解耦
  const per1k = (n: number) => (chars / 1000) * n;
  const raw =
    per1k(base.parallelism) * 3.2 + // 平行结构：最硬的信号
    (base.summaryTail / base.paras) * 45 + // 段末总结句：段级信号
    (base.enumerated / base.paras) * 35 + // 显式列举：段级信号
    clamp(1 - segLenCV / 0.8, 0, 1) * 18; // 段长一致性：弱信号
  const score = Math.round(clamp(raw, 0, 100) * 10) / 10;

  const samples = [
    ...(t.match(PARALLEL_RE) || []).slice(0, 2),
    ...(t.match(SUMMARY_TAIL_RE) || []).slice(0, 1),
  ].map((s) => s.trim().slice(0, 18));

  return { score, ...base, segLenCV, samples };
}

/** 人读版摘要（CLI --explain / 校准实验用） */
export function explainSyntaxRegularity(r: SyntaxRegularityBreakdown): string {
  if (r.chars < 80) return "文本太短，句式工整度不可判";
  const parts: string[] = [`句式工整度 ${r.score}/100`];
  if (r.parallelism) parts.push(`平行结构 ${r.parallelism} 处`);
  if (r.summaryTail) parts.push(`段末总结句 ${r.summaryTail} 处`);
  if (r.enumerated) parts.push(`显式列举 ${r.enumerated} 处`);
  parts.push(`段长变异 ${r.segLenCV}`);
  return parts.join("｜");
}
