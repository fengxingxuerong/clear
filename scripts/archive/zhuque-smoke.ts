/**
 * 朱雀检测引擎冒烟（纯本地，零联网）
 * 用法：npx tsx scripts/zhuque-smoke.ts
 *
 * 验证三件事：
 *  1. 典型 AI 论述文应落「AI特征」档且占比偏高；
 *  2. 真人/深度去味稿的 AI 特征占比应显著低于原文；
 *  3. 高亮片段的 offset 必须能原样还原文本（防错位）。
 */
import { detectZhuque, fitCalibration, applyCalibration, type CalibPoint } from "../src/engine/zhuque.ts";
import { parseOfficialResult } from "../src/api/zhuque.ts";

const AI_SAMPLE = `随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。值得注意的是，数字化阅读不仅改变了人们获取知识的方式，还显著提升了阅读的便捷性。然而，数字化阅读也面临着一系列挑战，诸如注意力分散、深度思考能力下降等问题。因此，我们需要在享受技术便利的同时，保持对阅读质量的关注。

首先，数字化阅读让知识的获取变得更加高效。读者可以随时随地通过移动设备访问海量资源，检索与标注也变得前所未有的便捷。其次，数字化阅读有助于降低阅读门槛，让更多人能够接触到优质的内容。此外，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。

与此同时，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。纸质阅读所具有的沉浸感与仪式感，依然是数字媒介难以替代的。阅读的核心在于思考，这是任何技术手段都无法完全实现的。

综上所述，数字化阅读与传统阅读并非对立关系，而是互为补充的两种方式。我们既要积极拥抱技术进步，也要坚守阅读的本质，唯有如此，才能真正实现阅读的价值。`;

const HUMAN_SAMPLE = `数字化阅读这东西，说实话，这几年是真真切切融进生活里了。早上地铁上刷几篇文章，晚上躺床上看会儿电子书，获取知识的方式确实变了。方便是真方便，手机一掏，什么资源都能翻到，想查个东西直接检索，做笔记也比以前省事，不用带笔带本子。

但问题是，方便归方便，读着读着就容易走神。我自己的体验是，看屏幕超过十分钟，手指就不自觉地想划走，去点个别的什么。那种一页页翻纸质书的沉浸感，数字媒介确实给不了，翻书这个动作本身就是一种仪式，能让人安静下来。碎片化的阅读喂给大脑的都是短平快的东西，时间长了，深度思考的能力好像会退化。

要我说，个性化推荐也是个双刃剑。它懂你的喜好，推给你的都是你想看的，但长时间待在这种信息茧房里，接触的面反而窄了。另外，有人认为电子阅读降低了门槛，让更多人可以读到优质内容，这个我不否认，各种免费资源和低价电子书确实帮了不少人。

不过话说回来，把数字化阅读和传统阅读弄成对立面也没必要。纸质书有它的好，电子书有它的方便，两者本质上是互补的。技术再怎么进步，阅读的核心还是思考，这个谁也替代不了。所以关键不在于用什么媒介读，而在于读的时候走没走心。`;

function show(name: string, text: string) {
  const rep = detectZhuque(text);
  console.log(`\n===== ${name} =====`);
  console.log(
    `AI特征占比 ${rep.probability}% | 疑似 ${rep.ratios.suspected}% | 人工 ${rep.ratios.human}% | 综合 ${rep.composite}%`
  );
  console.log(`档位：${rep.labelText} · 置信 ${rep.confidence}% · ${rep.verdict} · ${rep.stats.chars}字/${rep.stats.sentences}句`);
  console.log(`标注片段 ${rep.spans.length} 处，最高风险 ${rep.topSpans[0]?.risk ?? 0}：`);
  for (const s of rep.topSpans.slice(0, 3)) {
    console.log(`  [${s.risk}] ${s.text.slice(0, 40)}${s.text.length > 40 ? "…" : ""}  (${s.reasons.join("、")})`);
  }
  rep.warnings.forEach((w) => console.log("  ⚠ " + w));

  // 高亮 offset 正确性：按 spans 拼回去必须等于原文
  let rebuilt = "";
  let pos = 0;
  for (const s of rep.spans) {
    rebuilt += text.trim().slice(pos, s.start) + text.trim().slice(s.start, s.end);
    pos = s.end;
  }
  rebuilt += text.trim().slice(pos);
  console.log(rebuilt === text.trim() ? "  ✅ offset 还原一致" : "  ❌ offset 错位！");
  return rep;
}

const aiRep = show("样本A · 典型 AI 论述文", AI_SAMPLE);
const huRep = show("样本B · 口语化真人稿", HUMAN_SAMPLE);

console.log("\n===== 断言 =====");
const ok1 = aiRep.composite > huRep.composite;
const ok2 = aiRep.label !== "human";
const ok3 = huRep.ratios.ai < aiRep.ratios.ai;
console.log(`${ok1 ? "✅" : "❌"} AI 稿综合分(${aiRep.composite}) > 真人稿综合分(${huRep.composite})`);
console.log(`${ok2 ? "✅" : "❌"} AI 稿未落人工档（${aiRep.labelText}）`);
console.log(`${ok3 ? "✅" : "❌"} 真人稿 AI 特征占比(${huRep.ratios.ai}%) < AI 稿(${aiRep.ratios.ai}%)`);

console.log("\n===== 校准拟合（演示用，official 是占位值，非官方实测） =====");
console.log("真值对照请跑：npm run test:zhuque-truth（用样本 D 的官方实测 99.99% / 98.47%）");
const OFFICIAL_PLACEHOLDER = 32.5; // 占位，无官方实测支撑，切勿当作真值写进文档
const pts: CalibPoint[] = [
  { local: aiRep.composite, official: 99.99, ts: Date.now() },
  { local: huRep.composite, official: OFFICIAL_PLACEHOLDER, ts: Date.now() },
];
const cal = fitCalibration(pts);
console.log(`映射：官方 ≈ ${cal.a} × 本地 ${cal.b >= 0 ? "+" : "−"} ${Math.abs(cal.b)}（${cal.n} 点）`);
console.log(`本地 ${aiRep.composite} → 估官方 ${applyCalibration(aiRep.composite, cal).toFixed(2)}%`);
console.log(`本地 ${huRep.composite} → 估官方 ${applyCalibration(huRep.composite, cal).toFixed(2)}%`);

console.log("\n===== 官方结果回填解析 =====");
for (const s of ["AI生成 99.99%", "疑似AI辅助 62.3%", "人工特征", "98.47%", "乱七八糟的文本"]) {
  const r = parseOfficialResult(s);
  console.log(`"${s}" → ${r.ok ? `${r.labelText} ${r.probability}%` : "解析失败：" + r.note}`);
}

console.log("\n===== 送检文本截断 =====");
const { buildSubmission } = await import("../src/api/zhuque.ts");
const long = AI_SAMPLE.repeat(6);
const sub = buildSubmission(long, 2000);
console.log(
  `原文 ${long.replace(/\s/g, "").length} 字 → 送检文本 ${sub.text.replace(/\s/g, "").length} 字（截断=${sub.truncated}）`
);
console.log("结尾：", sub.text.slice(-30));
