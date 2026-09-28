/**
 * scripts/_vocab_audit.ts —— VOCAB 全表替身 × 标尺黑名单交叉审计（临时）
 *
 * 发现：值得注意的是 的三个替身里有两个有问题（要我说 ∈ INTERJECTIONS 池、
 * 有意思的是 ∈ LEADING_CONNECTORS）。怀疑 VOCAB 表整体存在"替身即黑名单"问题。
 * 本脚本批量审计：对每个替身，检查它是否 ∈ 标尺黑名单 ∪ INTERJECTIONS。
 */
import { VOCAB } from "../src/engine/humanize-vocab";
import { aiScore } from "../src/engine/humanize-metrics";

// 标尺黑名单（从 humanize-metrics.ts 抄录，若改动需同步）
const PAD_SENTENCE_WORDS = new Set([
  "就这样", "你懂的", "说白了", "讲真", "说真的", "老实讲", "行吧", "好吧", "是啊",
  "你说得对", "是这个理", "随你怎么说", "反正", "往实了说", "往好听了说", "说难听点",
  "夸张点说", "不瞒你说", "这么说吧", "差不多得了",
]);

const INTERJECTIONS = new Set([
  "说真的", "其实", "说实话", "按我的经验", "老实讲", "讲真", "说白了", "你别说",
  "要我说", "话又说回来", "平心而论", "客观讲", "往实了说", "不瞒你说", "说句掏心窝的", "细想下",
]);

const CONTEXT = "数字化转型是企业发展的必由之路，它能够提升效率，把握需求，支撑可持续发展，因此值得认真对待。";

console.log("审计：每个替身「单独插到句首」后的句式分（>0 = 会制造污染）\n");
const problems: Array<{ from: string; to: string; score: number; reason: string }> = [];

for (const [from, alts] of Object.entries(VOCAB)) {
  for (const alt of alts) {
    const injected = `${alt}，${CONTEXT}`;
    const bd = aiScore(injected);
    if ((bd.structureHits ?? 0) > 0) {
      const reasons: string[] = [];
      if (PAD_SENTENCE_WORDS.has(alt)) reasons.push("垫词独句表");
      if (INTERJECTIONS.has(alt)) reasons.push("INTERJECTIONS池");
      problems.push({ from, to: alt, score: bd.structureHits ?? 0, reason: reasons.join("+") || "其它" });
    }
  }
}

console.log(`共 ${problems.length} 个替身会制造污染：\n`);
console.log("原文套话".padEnd(14) + "  替身".padEnd(14) + "句式分  命中来源");
console.log("-".repeat(64));
for (const p of problems) {
  console.log(`${p.from.padEnd(14)}→ ${p.to.padEnd(14)} ${String(p.score).padStart(3)}    ${p.reason}`);
}
