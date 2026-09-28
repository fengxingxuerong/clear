/**
 * 验证：academic 档是不是"几乎没做事"？casual 档具体改坏了什么？
 */
import { humanize } from "../src/engine/humanize.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";

const SRC = `综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系。`;

const ac = humanize(SRC, { intensity: 0.7, style: "academic", zhuqueMode: true, seed: 20260826 } as never);
const ca = humanize(SRC, { intensity: 0.7, style: "casual", zhuqueMode: true, seed: 20260826 } as never);

console.log("=== 原文 ===\n" + SRC);
console.log(`\n(${SRC.length} 字, score=${aiScore(SRC).score}, n=${aiScore(SRC).sentenceCount})`);

console.log("\n\n=== academic 0.7 ===\n" + ac);
console.log(`\n(${ac.length} 字, score=${aiScore(ac).score}, n=${aiScore(ac).sentenceCount})`);

console.log("\n\n=== casual 0.7 ===\n" + ca);
console.log(`\n(${ca.length} 字, score=${aiScore(ca).score}, n=${aiScore(ca).sentenceCount})`);

console.log("\n\n=== academic 是否等同原文？===");
console.log("完全相同:", ac === SRC);
if (ac !== SRC) {
  // 找出差异
  const sents = SRC.split(/([。；，])/);
  const outS = ac.split(/([。；，])/);
  console.log(`原文片段 ${sents.length} / 输出片段 ${outS.length}`);
}
