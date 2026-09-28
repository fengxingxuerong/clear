/**
 * 检查过度纠偏：AI 典型套话样本里，哪些词被 SCORING_EXCLUDE 误排除了？
 */
import { VOCAB, FORMULAIC, SCORING_EXCLUDE } from "../src/engine/humanize-data.ts";
import { FORMULAIC_EXTRA } from "../src/engine/humanize-vocab-extra.ts";

const AI_TYPICAL = `在当今数字化浪潮席卷全球的背景下，企业数字化转型已成为不可逆转的趋势。首先，数字化转型能够显著提升企业的运营效率。通过引入先进的信息技术，企业可以实现业务流程的自动化与智能化，从而大幅降低人力成本。
其次，数字化转型有助于企业更好地洞察市场需求。借助大数据分析技术，企业能够精准把握用户偏好，进而优化产品设计与营销策略，提升市场竞争力。此外，数据驱动的决策模式还能帮助企业快速响应市场变化，增强组织的敏捷性。
综上所述，数字化转型对企业发展具有重要的战略意义。企业应当积极拥抱数字化变革，构建完善的数据治理体系，从而在激烈的市场竞争中占据有利地位。展望未来，唯有持续创新，方能在数字经济时代赢得先机。`;

console.log("=== 该样本中命中的 VOCAB key 分类 ===\n");
const allF = new Set([...FORMULAIC, ...FORMULAIC_EXTRA]);
console.log("--- 计入套话（非 VOCAB 的 FORMULAIC）---");
for (const p of allF) if (!(p in VOCAB) && AI_TYPICAL.includes(p)) console.log(`  ✅ ${p}`);

console.log("\n--- 计入套话（VOCAB 且未被排除）---");
for (const from of Object.keys(VOCAB)) {
  if (SCORING_EXCLUDE.has(from)) continue;
  if (AI_TYPICAL.includes(from)) console.log(`  ✅ ${from}`);
}

console.log("\n--- ❌ 被 SCORING_EXCLUDE 排除掉的命中（疑似过度纠偏）---");
for (const from of Object.keys(VOCAB)) {
  if (!SCORING_EXCLUDE.has(from)) continue;
  if (AI_TYPICAL.includes(from)) console.log(`  ❌ ${from}`);
}

console.log("\n=== SCORING_EXCLUDE 总词数:", SCORING_EXCLUDE.size);
