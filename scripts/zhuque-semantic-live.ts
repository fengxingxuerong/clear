/**
 * 朱雀语义层 LLM 实测（真请求，走 SenseNova 常驻通道）
 * 用法：npx tsx scripts/zhuque-semantic-live.ts
 *
 * v0.7.2 的「用 LLM 补语义层」此前只有机制演示（假设值），本脚本拿真实 LLM 评分：
 *   - 样本 D 原文（官方真值 AI生成 99.99%）与去味稿（官方真值 疑似AI辅助 98.47%）；
 *   - 口语真人稿（无官方真值，预期低分，看方向）；
 *   - 每个样本跑 judgeScoreStable（deepseek-v4-flash + glm-5.2 交叉取均值），
 *     与本地表层分融合（默认权重 0.6），对照官方真值看融合是否更贴近。
 */
import { DEFAULT_API, judgeScoreStable } from "../src/api/llm.ts";
import {
  detectZhuque, fuseLayers, DEFAULT_SEMANTIC_WEIGHT, type SemanticLayer,
} from "../src/engine/zhuque.ts";

// node 直连网关（页面里走 /sensenova/v1 同源代理，node 里没有代理，必须绝对地址）
DEFAULT_API.baseUrl = "https://token.sensenova.cn/v1";
// 2026-09-01 实测：deepseek-v4-flash / glm-5.2 / kimi-k3 / deepseek-v4-pro 全部 429
// （网关按模型分配额池），仅 sensenova-6.8-flash-lite 可用，故本脚本单模型 3 次取中位数
const LIVE_MODEL = "sensenova-6.8-flash-lite";
DEFAULT_API.model = LIVE_MODEL;
DEFAULT_API.judgeModel = "";

const D_ORIGINAL = `随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。值得注意的是，数字化阅读不仅改变了人们获取知识的方式，还显著提升了阅读的便捷性。然而，数字化阅读也面临着一系列挑战，诸如注意力分散、深度思考能力下降等问题。因此，我们需要在享受技术便利的同时，保持对阅读质量的关注。

首先，数字化阅读让知识的获取变得更加高效。读者可以随时随地通过移动设备访问海量资源，检索与标注也变得前所未有的便捷。其次，数字化阅读有助于降低阅读门槛，让更多人能够接触到优质的内容。此外，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。

与此同时，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。纸质阅读所具有的沉浸感与仪式感，依然是数字媒介难以替代的。阅读的核心在于思考，这是任何技术手段都无法完全实现的。

综上所述，数字化阅读与传统阅读并非对立关系，而是互为补充的两种方式。我们既要积极拥抱技术进步，也要坚守阅读的本质，唯有如此，才能真正实现阅读的价值。`;

const D_HUMANIZED = `数字化阅读逐渐走进人们的日常生活。数字化阅读不只是改变了人们获取知识的方式，还明显提高了阅读的便捷性。可是，数字化阅读也面对一堆挑战。像是注意力分散。深度思考能力下降等问题。于是，我们需要在享受技术便利的同时，保持对阅读质量的关注。
一来，数字化阅读让知识的获取变得更加高效。读者可以随时随地用移动设备访问海量资源。检索与标注也变得前所未有的便捷。再说，数字化阅读利于降低阅读门槛，让更多人能够接触到优质的内容，还有，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。
这期间，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。说句掏心窝的，纸质阅读所具有的沉浸感与仪式感，依然是数字媒介很难替代的。阅读的核心在于思考。这是任何技术手段都无法完全弄成的。
往实了说，数字化阅读与传统阅读倒不是对立关系，是互为补充的两种方式。我们主动拥抱技术进步，也要坚守阅读的本质，只有这样，才能真正实现阅读的意义。`;

const HUMAN_SAMPLE = `数字化阅读这东西，说实话，这几年是真真切切融进生活里了。早上地铁上刷几篇文章，晚上躺床上看会儿电子书，获取知识的方式确实变了。方便是真方便，手机一掏，什么资源都能翻到，想查个东西直接检索，做笔记也比以前省事，不用带笔带本子。

但问题是，方便归方便，读着读着就容易走神。我自己的体验是，看屏幕超过十分钟，手指就不自觉地想划走，去点个别的什么。那种一页页翻纸质书的沉浸感，数字媒介确实给不了，翻书这个动作本身就是一种仪式，能让人安静下来。碎片化的阅读喂给大脑的都是短平快的东西，时间长了，深度思考的能力好像会退化。

要我说，个性化推荐也是个双刃剑。它懂你的喜好，推给你的都是你想看的，但长时间待在这种信息茧房里，接触的面反而窄了。另外，有人认为电子阅读降低了门槛，让更多人可以读到优质内容，这个我不否认，各种免费资源和低价电子书确实帮了不少人。

不过话说回来，把数字化阅读和传统阅读弄成对立面也没必要。纸质书有它的好，电子书有它的方便，两者本质上是互补的。技术再怎么进步，阅读的核心还是思考，这个谁也替代不了。所以关键不在于用什么媒介读，而在于读的时候走没走心。`;

const SAMPLES: Array<{ name: string; text: string; official: number | null; officialLabel: string }> = [
  { name: "D 原文（官方：AI生成 99.99%）", text: D_ORIGINAL, official: 99.99, officialLabel: "AI生成" },
  { name: "D 去味稿（官方：疑似AI辅助 98.47%）", text: D_HUMANIZED, official: 98.47, officialLabel: "疑似AI辅助" },
  { name: "口语真人稿（无官方真值）", text: HUMAN_SAMPLE, official: null, officialLabel: "预期低分" },
];

console.log(`评判通道：${LIVE_MODEL} 单模型 3 次取中位数（judgeScoreStable）\n`);

const rows: Array<{ name: string; surface: number; sem: number; fused: number; label: string; official: number | null }> = [];

for (const s of SAMPLES) {
  const rep = detectZhuque(s.text);
  console.log(`【${s.name}】`);
  console.log(`  表层（本地）：综合 ${rep.composite}（${rep.labelText}）`);
  let sem: SemanticLayer | null = null;
  try {
    const r = await judgeScoreStable(s.text, DEFAULT_API);
    sem = { score: r.score, critique: r.critique, source: LIVE_MODEL };
    console.log(`  语义层（LLM）：${r.score} 分`);
    if (r.critique.length) console.log(`  痕迹：${r.critique.join("；")}`);
  } catch (e: any) {
    console.log(`  语义层（LLM）：失败（${e?.message || e}）`);
  }
  const f = fuseLayers(rep.composite, sem);
  if (f) {
    console.log(
      `  融合（w=${DEFAULT_SEMANTIC_WEIGHT}）：${f.composite}（${f.labelText}）· 分歧 ${f.divergence} · 置信 ${f.confidence}` +
        (s.official !== null ? `  vs 官方真值 ${s.official}%（${s.officialLabel}）` : "")
    );
    rows.push({ name: s.name, surface: rep.composite, sem: sem!.score, fused: f.composite, label: f.labelText, official: s.official });
  } else {
    rows.push({ name: s.name, surface: rep.composite, sem: -1, fused: rep.composite, label: rep.labelText, official: s.official });
  }
  console.log("");
}

console.log("===== 汇总（误差=|融合分−官方真值|，仅官方真值行有意义） =====");
for (const r of rows) {
  const err = r.official !== null && r.sem >= 0 ? Math.abs(r.fused - r.official).toFixed(2) : "—";
  console.log(
    `${r.name}  表层 ${r.surface} · 语义 ${r.sem < 0 ? "失败" : r.sem} · 融合 ${r.fused}（${r.label}）` +
      (r.official !== null ? ` · 官方 ${r.official} · 误差 ${err}` : "")
  );
}

console.log("\n注：LLM 评分有波动，结论以多次运行方向为准；官方真值仅样本 D 两条。");
