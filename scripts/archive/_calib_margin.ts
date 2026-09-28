/**
 * 标定边距分析：判断"该不该继续上调权重"。
 *
 * 核心问题：把 M1/M4/M8/M9 推过 40 需要多大的权重？代价是什么？
 * 如果代价是"真人写样本 V2 也越过 40"，那就说明这条路走不通，
 * 应该接受这些样本落在灰区（35~40），而不是硬凑。
 */
import { aiScore } from "../src/engine/humanize-metrics.ts";
import { ALL_SAMPLES } from "./_calib_corpus.ts";

const HOLDOUT: [string, "human" | "machine", string][] = [
  ["V1-真人散文", "human", `春天的风带着点土腥味，吹在脸上很舒服。我沿着河边慢慢走，看着柳条在水面上划出一道道波纹。有个老人在钓鱼，一动不动，像尊雕塑。`],
  ["V2-真人随笔（单个垫词）", "human", `说实话，我对这事儿一直没想明白。你说它重要吧，好像也没那么重要；说它不重要吧，又确实影响挺大。`],
  ["V3-真人公文", "human", `根据年度工作安排，现就有关事项通知如下：一、加强组织领导；二、明确责任分工；三、强化督导检查。`],
  ["V4-真人对话", "human", `【场景：办公室】
小王：这版设计你觉得怎么样？
老李：整体可以，就是配色有点跳。`],
  ["V5-引擎垫词堆叠", "machine", `讲真，说白了，这事儿得两面看。老实讲，其实吧，谁都不容易。`],
  ["V6-引擎语气词", "machine", `他昨天来过了诶。说了一会儿话哦。走的时候天已经黑了嗼。`],
  ["V7-引擎碎片句", "machine", `项目延期了。你懂的。客户很不高兴。差不多得了。`],
  ["V8-引擎复合", "machine", `说真的，技术这事儿啊，得慢慢来呣。你懂的。反正就那样。说到底。急也没用呵。`],
];

console.log("当前标定结果（阈值 40）：");
console.log("─".repeat(76));
const all = [
  ...ALL_SAMPLES.map((s) => ({ id: s.id, expect: s.expect, score: aiScore(s.text).score, set: "训练" })),
  ...HOLDOUT.map(([id, expect, text]) => ({ id, expect, score: aiScore(text).score, set: "验证" })),
];
for (const r of all) {
  const ok = r.expect === "human" ? r.score < 40 : r.score >= 29;
  const bar = "█".repeat(Math.round(r.score / 4));
  console.log(
    `${r.set} ${r.id.padEnd(22)} ${String(r.score).padStart(3)}  ${ok ? "✓" : "✗"}  ${bar}`,
  );
}

// 分组统计：干净样本 vs 灰区样本的分布
const human = all.filter((r) => r.expect === "human");
const machine = all.filter((r) => r.expect === "machine");
console.log("─".repeat(76));
console.log(`真人写（${human.length} 个）：最高 ${Math.max(...human.map((r) => r.score))}  最低 ${Math.min(...human.map((r) => r.score))}`);
console.log(`引擎污染（${machine.length} 个）：最高 ${Math.max(...machine.map((r) => r.score))}  最低 ${Math.min(...machine.map((r) => r.score))}`);
const humanMax = Math.max(...human.map((r) => r.score));
const machineMin = Math.min(...machine.map((r) => r.score));
console.log(`\n分离间隙：真人写最高 ${humanMax}  ←→  引擎最低 ${machineMin}`);
if (humanMax < machineMin) {
  console.log(`✅ 两组完全分离，可用阈值区间 [${humanMax}, ${machineMin}]，建议取中位 ${Math.round((humanMax + machineMin) / 2)}`);
} else {
  console.log(`⚠️ 两组有重叠区间 [${machineMin}, ${humanMax}]，无法用单一阈值完全分开`);
  const overlap = all.filter((r) => r.score >= machineMin && r.score <= humanMax);
  console.log("   重叠样本：");
  for (const r of overlap) console.log(`     ${r.id.padEnd(22)} ${r.score}  期望=${r.expect}`);
}
