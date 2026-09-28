/**
 * 错别字注入的收益/代价量化（为待决策项 A/B/C 提供数据）。
 * 手法：同一文本，开/关 injectHumanTypos，看 aiScore 与人类观感的代理指标。
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";

const CASES: Array<[string, string, "main" | "narrative" | "dialogue" | "humanHand"]> = [
  [
    "论说",
    `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。企业在推进转型的过程中，往往会遇到各种各样的困难与挑战。

从本质上来说，数字化转型的核心并不在于技术本身，而在于组织能力与思维方式的根本性变革。`,
    "main",
  ],
  [
    "叙事",
    `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。`,
    "narrative",
  ],
  [
    "对话",
    `【场景：公司会议室，下午三点】
张总（项目经理）：这个季度的指标完成得怎么样了？
李工（前端负责人）：主流程已经联调完毕，还差两个边界用例。
张总（项目经理）：那什么时候能上线？
李工（前端负责人）：下周应该没问题。`,
    "dialogue",
  ],
];

const TYPO_SIGNS = ["得时候", "地时候", "在说", "做为", "作饭", "作事", "地方法", "得方法"];

console.log("错别字注入代价扫描（0.9 档 × 10 seed）\n" + "=".repeat(72));
for (const [name, text, genre] of CASES) {
  let typoCount = 0;
  let scoreSum = 0;
  const samples: string[] = [];
  for (let seed = 1; seed <= 10; seed++) {
    const out = humanize(text, { intensity: 0.9, zhuqueMode: true, genre, seed });
    const s = aiScore(out);
    scoreSum += s.score;
    const found = TYPO_SIGNS.filter((t) => out.includes(t));
    if (found.length) {
      typoCount++;
      if (samples.length < 2) samples.push(`seed=${seed}: ${found.join(",")}`);
    }
  }
  console.log(`\n【${name}】原文 ${aiScore(text).score} 分`);
  console.log(`  错别字命中率: ${typoCount}/10 seed   avg aiScore: ${(scoreSum / 10).toFixed(1)}`);
  for (const s of samples) console.log(`    ${s}`);
}
