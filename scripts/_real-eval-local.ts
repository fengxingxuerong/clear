/**
 * scripts/_real-eval-local.ts — 真实去 AI 能力实测（本地引擎，零 API 成本）
 * 3 篇典型 AI 生成文本 × 3 档强度，输出 aiScore 前后对比 + 指纹体检 + 忠实度校验
 */
import { humanize } from "../src/engine/humanize";
import { aiScore, fingerprintCheck, checkFidelityLocal } from "../src/engine/humanize-metrics";

const SAMPLES: { name: string; text: string }[] = [
  {
    name: "论说文（AI 经典总分总）",
    text: `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据相关数据显示，我国数字经济规模已经突破了五十万亿元人民币，占GDP的比重达到了百分之四十以上，充分体现了数字经济作为国民经济核心增长引擎的强大动力与韧性。
综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系；最后，也是最为重要的一点，企业需要培养和引进既懂业务又懂技术的复合型数字化人才。
总而言之，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有那些真正把数字化战略上升到企业核心战略层面的企业，才能在未来的竞争中立于不败之地。`,
  },
  {
    name: "产品软文（AI 营销味）",
    text: `在当今竞争激烈的市场环境中，一款优秀的效率工具能够为用户赋能，成为提升生产力的得力助手。该产品凭借其强大的功能和简洁优雅的设计，赢得了广大用户的一致好评。
值得一提的是，该产品不仅具备了行业领先的核心功能，还提供了丰富的个性化定制选项，充分满足不同用户的多元化需求。无论是职场新人还是资深专家，都能够快速上手，轻松驾驭。
与此同时，团队始终坚持用户至上的理念，不断倾听用户反馈，持续迭代优化。展望未来，产品将继续深耕垂直领域，为用户创造更大的价值，助力企业实现降本增效，开启智能化办公的新篇章。`,
  },
  {
    name: "总结报告（AI 八股味）",
    text: `本季度，在各部门的通力协作下，各项工作取得了显著成效，现将主要情况总结如下。
一、工作进展情况。项目组严格按照既定计划有序推进，完成了需求调研、方案设计、开发测试等阶段性任务，整体进度符合预期。同时，团队积极引入新技术、新方法，有效提升了工作效率与质量。
二、存在的问题与不足。部分环节的沟通协调仍有待加强，跨部门协作机制需要进一步完善；此外，人才梯队建设相对滞后，需引起高度重视。
三、下一步工作计划。下阶段将围绕既定目标，进一步压实责任、细化举措、强化督导，确保各项任务落到实处，推动工作再上新台阶。`,
  },
];

const INTENSITIES = [0.5, 0.7, 0.9];

console.log("=".repeat(78));
console.log("真实去 AI 能力实测 · 本地引擎（零 API）");
console.log("=".repeat(78));

let allFidelityOk = true;
for (const s of SAMPLES) {
  const before = aiScore(s.text);
  console.log(`\n【${s.name}】 字数=${s.text.length} 去味前 aiScore=${before.score}（套话命中=${before.formulaicHits} 句长CV=${before.burstiness.toFixed(2)}）`);
  for (const it of INTENSITIES) {
    const out = humanize(s.text, { intensity: it, seed: 20260907, zhuqueMode: it >= 0.5 });
    const after = aiScore(out);
    const fp = fingerprintCheck(out);
    const fid = checkFidelityLocal(s.text, out);
    if (!fid.pass) allFidelityOk = false;
    const drop = before.score - after.score;
    console.log(
      `  强度${it}: aiScore ${before.score}→${after.score}（降${drop}）| 指纹残留=${fp.issues.length} | 忠实度=${fid.pass ? "PASS" : "FAIL:" + fid.problems.join(";")}`,
    );
    if (it === 0.9) console.log(`  [0.9档输出预览] ${out.slice(0, 160)}...`);
  }
}
console.log("\n" + "=".repeat(78));
console.log(allFidelityOk ? "✅ 全部样本忠实度校验通过（关键信息/数字/术语未篡改）" : "❌ 存在忠实度失败样本");
