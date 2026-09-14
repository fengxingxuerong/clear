/**
 * 朱雀校准采样脚本
 * 用法：node --experimental-strip-types src/engine/zhique-prep.ts
 *
 * 产出：原始文本 + 不同强度去味结果，供粘入「朱雀大模型内容检测」对比官方 AI 分，
 * 校准本地代理分（aiScore）的偏差。本地分非官方分，仅作参考。
 */
import { humanizeWithScore } from "../src/engine/humanize.ts";

const samples: Record<string, string> = {
  "公文/体制内套话":
    "高位推动顶层设计，各地压茬推进、挂图作战，攻坚克难、久久为功。要以高质量发展为抓手，为产业升级注入新动能，成为区域协调发展的重要组成部分。",
  互联网黑话密集:
    "我们拉通底层架构，以增长组合拳打透关键路径，通过复盘收敛打法、拉齐认知，最终击穿痛点、放大爽点，让飞轮转起来形成护城河。",
  通用AI书面腔:
    "值得注意的是，随着人工智能的发展，其在各行各业的应用愈发广泛。毋庸置疑，技术赋能传统产业已成为不可忽视的趋势，因此我们必须予以高度重视。",
};

const intensities = [0.5, 0.7, 0.9];

for (const [name, text] of Object.entries(samples)) {
  console.log("\n================= 样本：" + name + " =================");
  console.log("【原始】");
  console.log(text);
  const base = humanizeWithScore(text, { intensity: 0, seed: 1 });
  console.log(`\n[本地代理分] 原始=${base.before.score}（套话命中 ${base.before.formulaicHits}）`);
  for (const it of intensities) {
    const r = humanizeWithScore(text, { intensity: it, seed: 7 });
    console.log(
      `\n----- 强度 ${it} | 本地分 ${r.before.score} -> ${r.after.score}（套话命中 ${r.after.formulaicHits}）-----`,
    );
    console.log(r.text);
  }
  console.log("\n（把上面「原始」与各「强度」结果分别粘入朱雀，记录官方 AI 概率，回填即可校准）");
}
