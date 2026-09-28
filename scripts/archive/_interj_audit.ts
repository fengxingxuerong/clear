/**
 * scripts/_interj_audit.ts —— INTERJECTIONS 池逐条标尺审计（临时）
 *
 * INTERJECTIONS 是"随机插到句首的口语垫词"池，16 条。
 * 句首插入必然形成"垫词，+ 正文"形态 → 直接命中标尺 3e 的 POLL_HEAD_PAD_RE。
 * 本脚本逐条检测：该词是否在黑名单内 + 实际插入后句式分如何。
 */
import { INTERJECTIONS } from "../src/engine/humanize-vocab";
import { aiScore } from "../src/engine/humanize-metrics";

const BASE = "数字化转型是企业发展的必由之路，它能够提升效率，把握需求，支撑可持续发展，因此值得认真对待。";
console.log("原文分:", aiScore(BASE).score);
console.log("");
console.log("词".padEnd(16) + "单独插入后句式分  是否污染");
console.log("-".repeat(50));

for (const w of INTERJECTIONS) {
  const injected = `${w}，${BASE}`;
  const bd = aiScore(injected);
  const polluted = (bd.structureHits ?? 0) > 0;
  console.log(`${w.padEnd(14)}  ${String(bd.structureHits ?? 0).padStart(3)}  (套话${bd.formulaicHits})   ${polluted ? "❌ 污染" : "✅ 安全"}`);
}
