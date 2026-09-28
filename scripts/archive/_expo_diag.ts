import { humanize, aiScore } from "../src/engine/humanize.ts";

const EXPO_MULTI = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元，占 GDP 的比重达到了 41.8%。

综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等领域的研发投入；其次，企业需要重视数据资产的治理与运营；最后，企业需要培养复合型数字化人才。`;

const before = aiScore(EXPO_MULTI);
console.log(`原文 score=${before.score} avgLen=${before.avgLen} 句式=${before.structureHits} 病词=${before.brokenHits} 套话=${before.formulaicHits}`);

const out = humanize(EXPO_MULTI, { intensity: 0.9, zhuqueMode: true, genre: "main", seed: 7 });
const after = aiScore(out);
console.log(`输出 score=${after.score} avgLen=${after.avgLen} 句式=${after.structureHits} 病词=${after.brokenHits} 套话=${after.formulaicHits}`);
console.log("\n" + out.replace(/\n+/g, " ⏎ "));
