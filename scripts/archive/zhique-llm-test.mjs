/** 朱雀实测准备：LLM 通道生成去味稿 + 交叉评判（样本 D 原文 = 官方基线 AI生成 99.99%） */
import { DEFAULT_API, humanizeViaApi, judgeWithCritique } from "../src/api/llm.ts";
import { aiScore } from "../src/engine/humanize.ts";

// node 直连（等价于浏览器经代理转发）
DEFAULT_API.baseUrl = "https://token.sensenova.cn/v1";

// 样本 D：朱雀官方标定用 421 字 AI 议论文（原文 = AI生成 99.99%，本地引擎 = 疑似 98.47%）
const sample = `随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。值得注意的是，数字化阅读不仅改变了人们获取知识的方式，还显著提升了阅读的便捷性。然而，数字化阅读也面临着一系列挑战，诸如注意力分散、深度思考能力下降等问题。因此，我们需要在享受技术便利的同时，保持对阅读质量的关注。

首先，数字化阅读让知识的获取变得更加高效。读者可以随时随地通过移动设备访问海量资源，检索与标注也变得前所未有的便捷。其次，数字化阅读有助于降低阅读门槛，让更多人能够接触到优质的内容。此外，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。

与此同时，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。纸质阅读所具有的沉浸感与仪式感，依然是数字媒介难以替代的。阅读的核心在于思考，这是任何技术手段都无法完全实现的。

综上所述，数字化阅读与传统阅读并非对立关系，而是互为补充的两种方式。我们既要积极拥抱技术进步，也要坚守阅读的本质，唯有如此，才能真正实现阅读的价值。`;

console.log("=== 第一轮：deepseek-v4-flash 单轮改写 ===");
let draft = await humanizeViaApi(sample, DEFAULT_API, 0.9);
console.log(draft);

let r = await judgeWithCritique(draft, DEFAULT_API);
console.log(`\n第一轮评判: ${r.score} 分 | 痕迹: ${r.critique.join("；") || "无"}`);

if (r.score > 35) {
  console.log("\n=== 第二轮：带痕迹定向修订 ===");
  const tells = r.critique.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const revPrompt = `下面这段文字被 AI 检测员判了 ${r.score} 分（0=纯人写，100=纯AI），残留痕迹：\n${tells}\n\n请逐条消除痕迹，只动痕迹指出的地方；句长剧烈起伏（混入三五字短句和30字长句）；事实数字一个不能变；只输出修订后的正文。\n\n【当前文本】\n${draft}`;
  draft = await humanizeViaApi(revPrompt, { ...DEFAULT_API, style: "casual" }, 0.9);
  console.log(draft);
  r = await judgeWithCritique(draft, DEFAULT_API);
  console.log(`\n第二轮评判: ${r.score} 分 | 痕迹: ${r.critique.join("；") || "无"}`);
}

console.log(`\n本地代理分: ${aiScore(draft).score}`);
console.log("可见字数:", draft.replace(/\s/g, "").length);
console.log("\n===== 送检稿 =====");
console.log(draft);
