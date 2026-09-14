/**
 * 朱雀检测 · 官方真值对照（纯本地跑，不联网）
 * 用法：npx tsx scripts/zhuque-truthcheck.ts
 *
 * 样本 D 是本项目唯一有「朱雀官方实测真值」的样本（记录见 src/engine/zhique-calibration.txt，
 * 2026-08-30 游客模式实测）：
 *   原文 421 字 AI 议论文   → 官方 label=1 AI生成，99.99%，全段命中
 *   本地引擎去味稿（v0.5.3 / 强度0.9 / 20 种子择优）
 *                            → 官方 label=2 疑似AI辅助，98.47%，页面结论"未发现明显的人工创作特征"
 *
 * 本脚本用本地朱雀引擎跑同一对样本，把本地分与官方真值摆在一起看差距。
 * 注意：这两个点同时被用于校准演示时属于「自证」，真要评估必须留出未参与拟合的样本。
 */
import {
  detectZhuque, applyCalibration, fitCalibration, fuseLayers, DEFAULT_SEMANTIC_WEIGHT,
  type CalibPoint,
} from "../src/engine/zhuque.ts";

const D_ORIGINAL = `随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。值得注意的是，数字化阅读不仅改变了人们获取知识的方式，还显著提升了阅读的便捷性。然而，数字化阅读也面临着一系列挑战，诸如注意力分散、深度思考能力下降等问题。因此，我们需要在享受技术便利的同时，保持对阅读质量的关注。

首先，数字化阅读让知识的获取变得更加高效。读者可以随时随地通过移动设备访问海量资源，检索与标注也变得前所未有的便捷。其次，数字化阅读有助于降低阅读门槛，让更多人能够接触到优质的内容。此外，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。

与此同时，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。纸质阅读所具有的沉浸感与仪式感，依然是数字媒介难以替代的。阅读的核心在于思考，这是任何技术手段都无法完全实现的。

综上所述，数字化阅读与传统阅读并非对立关系，而是互为补充的两种方式。我们既要积极拥抱技术进步，也要坚守阅读的本质，唯有如此，才能真正实现阅读的价值。`;

const D_HUMANIZED = `数字化阅读逐渐走进人们的日常生活。数字化阅读不只是改变了人们获取知识的方式，还明显提高了阅读的便捷性。可是，数字化阅读也面对一堆挑战。像是注意力分散。深度思考能力下降等问题。于是，我们需要在享受技术便利的同时，保持对阅读质量的关注。
一来，数字化阅读让知识的获取变得更加高效。读者可以随时随地用移动设备访问海量资源。检索与标注也变得前所未有的便捷。再说，数字化阅读利于降低阅读门槛，让更多人能够接触到优质的内容，还有，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。
这期间，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。说句掏心窝的，纸质阅读所具有的沉浸感与仪式感，依然是数字媒介很难替代的。阅读的核心在于思考。这是任何技术手段都无法完全弄成的。
往实了说，数字化阅读与传统阅读倒不是对立关系，是互为补充的两种方式。我们主动拥抱技术进步，也要坚守阅读的本质，只有这样，才能真正实现阅读的意义。`;

const TRUTH: Array<{ name: string; text: string; official: number; officialLabel: string }> = [
  { name: "样本D 原文（AI 议论文）", text: D_ORIGINAL, official: 99.99, officialLabel: "AI生成" },
  { name: "样本D 去味稿（本地引擎强度0.9）", text: D_HUMANIZED, official: 98.47, officialLabel: "疑似AI辅助" },
];

const reps = TRUTH.map((t) => ({ ...t, rep: detectZhuque(t.text) }));

console.log("===== 本地朱雀引擎 vs 朱雀官方真值 =====");
console.log("（官方值来源：src/engine/zhique-calibration.txt，2026-08-30 游客模式实测）\n");
for (const r of reps) {
  console.log(`【${r.name}】${r.rep.stats.chars}字/${r.rep.stats.sentences}句`);
  console.log(
    `  本地：AI特征 ${r.rep.ratios.ai}% | 疑似 ${r.rep.ratios.suspected}% | 人工 ${r.rep.ratios.human}% | 综合 ${r.rep.composite}% | 档位 ${r.rep.labelText}`
  );
  console.log(`  官方：${r.officialLabel} ${r.official}%`);
  console.log(
    `  差距：本地综合分 ${r.rep.composite} vs 官方 ${r.official} → 低估 ${(r.official - r.rep.composite).toFixed(2)} 个百分点`
  );
  console.log(`  标注片段 ${r.rep.spans.length} 处（红 ${r.rep.spans.filter((s) => s.label === "ai").length} / 黄 ${r.rep.spans.filter((s) => s.label === "suspected").length}）`);
  console.log("");
}

console.log("===== 若用这两点做校准（演示，属自证，不能当验证） =====");
const pts: CalibPoint[] = reps.map((r) => ({
  local: r.rep.composite,
  official: r.official,
  ts: Date.now(),
}));
const cal = fitCalibration(pts);
console.log(`映射：官方 ≈ ${cal.a} × 本地 ${cal.b >= 0 ? "+" : "−"} ${Math.abs(cal.b)}（${cal.n} 点）`);
for (const r of reps) {
  console.log(
    `  本地 ${r.rep.composite} → 估官方 ${applyCalibration(r.rep.composite, cal).toFixed(2)}%（真值 ${r.official}%）`
  );
}
console.log("\n注：两点拟合必然过拟合，两个数必然对得上——这不叫验证。");
console.log("真评估要做留出法：≥15 个样本拟合，另 5 个从未参与拟合的样本检验误差。");

console.log(`\n===== 语义层融合演示（LLM 分为演示假设值，非实测） =====`);
const humRep = reps[1].rep;
console.log(`去味稿：表层（本地）综合分 ${humRep.composite}，官方真值 98.47%（疑似AI辅助）`);
for (const semScore of [50, 70, 85]) {
  const f = fuseLayers(humRep.composite, {
    score: semScore,
    critique: [],
    source: "演示假设值",
  }, DEFAULT_SEMANTIC_WEIGHT);
  if (!f) continue;
  console.log(
    `  假设 LLM 语义层 ${semScore} 分 → 融合(w=${DEFAULT_SEMANTIC_WEIGHT}) ${f.composite}（${f.labelText}）· 分歧 ${f.divergence} · 置信 ${f.confidence}`
  );
}
console.log("结论：语义层把本地看不见的篇章层分差补回来，融合档位比纯本地更贴官方方向；");
console.log("真实 LLM 实测见 scripts/zhuque-semantic-live.ts（npm 无脚本，直接 node 跑）。");
