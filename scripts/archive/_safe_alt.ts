/**
 * scripts/_safe_alt.ts —— 为问题替身寻找安全替代（临时）
 *
 * _vocab_audit.ts 找出 10 个会制造污染的替身。
 * 本脚本给定候选替代词，检测其安全性（插句首后句式分 == 0）。
 */
import { aiScore } from "../src/engine/humanize-metrics";

const CONTEXT = "数字化转型是企业发展的必由之路，它能够提升效率，把握需求，支撑可持续发展，因此值得认真对待。";

const CANDIDATES = [
  // 值得注意的是 的候选
  "说起来", "顺带一提", "有个细节", "细心的人会发现",
  // 事实上 的候选
  "实际看", "落到实处看", "论实际情况",
  // 换言之 的候选
  "换个说法", "也就是说", "换句话说语气", "意思就是说",
  // 简而言之 的候选
  "简言之", "一句话概括", "拢共一句", "用一句话讲",
  // 毋庸讳言 的候选
  "毋庸回避", "这话得直说", "避不开的是",
  // 一言以蔽之 的候选
  "拢共一句", "一句话", "合起来说",
  // 从某种意义上看 的候选
  "某种意义上", "往深了看", "放大了看",
];

console.log("候选替代词安全性检测\n");
console.log("候选词".padEnd(18) + "句式分  套话");
console.log("-".repeat(40));
for (const w of CANDIDATES) {
  const bd = aiScore(`${w}，${CONTEXT}`);
  const icon = bd.structureHits === 0 ? "✅" : "❌";
  console.log(`${w.padEnd(16)} ${String(bd.structureHits).padStart(3)}   ${String(bd.formulaicHits).padStart(2)}  ${icon}`);
}
