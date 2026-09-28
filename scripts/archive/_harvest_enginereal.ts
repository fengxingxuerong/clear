/**
 * scripts/_harvest_enginereal.ts —— 摘录当前引擎的真实输出（临时）
 *
 * M6/M7 两条 @ENGINE-REAL 已陈旧：
 *   M6 论说 0.9 档：旧样本 89 分 → 当前引擎同题只能产出 0~38 分
 *   M7 叙事 0.9 档：旧样本 62 分 → 当前引擎恒 0 分（注入器已门控）
 *
 * 按 _calib_corpus.ts 的纪律（"@ENGINE-REAL 条目必须从 humanize() 实际输出摘录，
 * 不要手改"），本脚本用当前引擎跑出真实高分样本供摘录。
 *
 * 目标：找出当前引擎在论说体裁下的**最高分输出**，作为新的 M6 语料。
 * 同时验证叙事体裁是否已无机器化输出（若是，M7 应改为"叙事不再产生污染"的证据）。
 */
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";

// 用一条"引擎最容易出问题"的论说原文（含套话 + 多句 + 够长）
const EXPO = "在当今数字化浪潮席卷全球的时代背景下，数字化转型已经成为了企业发展的必由之路。首先，数字化转型能够显著提升企业的运营效率。通过引入先进的信息技术，企业可以实现流程的自动化与智能化，从而大幅降低人力成本。其次，数字化转型有助于企业精准把握市场需求。借助大数据分析，企业能够深入了解用户行为，进而制定更加精准的营销策略。最后，数字化转型还是企业实现可持续发展的关键支撑。综上所述，数字化转型不仅是提升竞争力的重要举措，更是顺应时代潮流的战略选择。";

console.log("=== 论说体裁：找当前引擎最高分输出 ===");
const rows: Array<{ it: number; seed: number; style: "plain" | "casual"; sc: number; out: string }> = [];
for (const style of ["plain", "casual"] as const) {
  for (const it of [0.6, 0.7, 0.8, 0.9]) {
    for (let seed = 1; seed <= 30; seed++) {
      const out = humanize(EXPO, { intensity: it, seed, genre: "main", style, zhuqueMode: true });
      rows.push({ it, seed, style, sc: aiScore(out).score, out });
    }
  }
}
rows.sort((a, b) => b.sc - a.sc);
console.log("最高 3 条：");
for (const r of rows.slice(0, 3)) {
  console.log(`  [${r.style} i=${r.it} seed=${r.seed}] score=${r.sc}`);
  console.log(`  ${r.out}\n`);
}

console.log("\n=== 叙事体裁：是否还有机器化输出 ===");
const NARR = "那是一个阳光明媚的下午，我漫步在熟悉的街道上，心中充满了对往事的回忆。街道两旁的老树依然挺立，斑驳的树影洒在地面上，仿佛在诉说着岁月的故事。我不知不觉走到了那家老书店门前，推开门的瞬间，一股淡淡的书香扑面而来。店主是一位慈祥的老人，他微笑着向我点头示意。";
let narrMax = 0;
let narrCount = 0;
for (const style of ["plain", "casual"] as const) {
  for (const it of [0.6, 0.7, 0.8, 0.9]) {
    for (let seed = 1; seed <= 30; seed++) {
      const sc = aiScore(humanize(NARR, { intensity: it, seed, genre: "narrative", style, zhuqueMode: true })).score;
      if (sc > narrMax) narrMax = sc;
      if (sc >= 29) narrCount++;
    }
  }
}
console.log(`  240 次运行中，>=29 分的次数 = ${narrCount}，最高分 = ${narrMax}`);
