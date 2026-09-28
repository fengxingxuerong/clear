/**
 * 合并兜底（boostBurstinessByCutting 尾段 cutsDone===0 分支）影响面量化。
 * 关注：① 是否被标尺奖励（burstiness 反向项已删，理论上 cv 高不再加分）
 *      ② 各体裁的句数损失（作者结构被破坏的程度）
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";

const CASES: Array<[string, string, "main" | "narrative" | "dialogue" | "humanHand"]> = [
  [
    "叙事·三长句",
    `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。`,
    "narrative",
  ],
  [
    "论说·三段式",
    `数字化转型已经成为各行各业的必然趋势。企业需要加大研发投入力度。同时还需要重视数据资产治理。`,
    "main",
  ],
  [
    "对话·台词",
    `【场景：会议室】
张总：这季度指标完成得怎么样？
李工：主流程已经联调完毕。
张总：什么时候能上线？`,
    "dialogue",
  ],
  [
    "人写·随笔",
    `周末去了趟菜市场。西红柿涨到六块五一斤。摊主说连着下了半个月雨。`,
    "humanHand",
  ],
];

const countSent = (t: string) => t.split(/(?<=[。！？])/).filter((s) => s.trim()).length;

console.log("合并兜底影响面（0.9 档，输入均无 AI 套话）\n" + "=".repeat(70));
for (const [name, text, genre] of CASES) {
  const before = countSent(text);
  let sumAfter = 0;
  let worst = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const out = humanize(text, { intensity: 0.9, zhuqueMode: true, genre, seed });
    const after = countSent(out);
    sumAfter += after;
    if (before - after > worst) worst = before - after;
  }
  console.log(`${name}: 原文${before}句 → 平均${(sumAfter / 10).toFixed(1)}句  最大损失${worst}句  aiScore=${aiScore(text).score}`);
}
