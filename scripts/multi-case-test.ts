/**
 * 趣AI味 · 多场景功能测试
 * 5 类代表性文本 × 3 档强度 × 指纹体检 + 忠实度 + 朱雀增强
 */
import { humanize, aiScore, humanizeWithScore, fingerprintCheck, checkFidelityLocal, applyZhuqueFeatures } from "../src/engine/humanize.ts";

interface Case {
  name: string;
  text: string;
  hasNumbers?: boolean; // 忠实度校验重点关注
}

const cases: Case[] = [
  {
    name: "AI书面腔（通用）",
    text: `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的发展。`,
    hasNumbers: false,
  },
  {
    name: "公文/体制内套话",
    text: `高位推动顶层设计，各地压茬推进、挂图作战，攻坚克难、久久为功。我们要锚定目标、紧扣主题，牵住牛鼻子、下好先手棋，打通最后一公里、跑出加速度。通过夯实基础、筑牢防线、厚植优势、盘活资源、补齐短板、锻造长板、擦亮名片，为高质量发展注入新动能、激发新活力、释放新潜力，凝聚共识、形成合力、拓宽渠道、搭建平台。`,
    hasNumbers: false,
  },
  {
    name: "互联网黑话密集",
    text: `我们拉通底层架构，以增长组合拳打透关键路径，通过复盘收敛打法、拉齐认知，最终击穿痛点、放大爽点，让飞轮转起来形成护城河。团队需要对齐心智，沉淀经验，反哺业务，在高质量发展的背景下稳步推进。抓手、闭环、矩阵、维度、颗粒度，这些底层逻辑构成了我们的认知护城河。`,
    hasNumbers: false,
  },
  {
    name: "学术论文（含数字/术语）",
    text: `研究表明，在 2024 年的实验中，GPT-4 模型的参数量达到了 1760 亿规模，准确率为 92.5%，比 GPT-3 高出 10 个百分点。这种 AI 写作工具应运而生，不仅提升了内容生产的效率，而且降低了创作门槛。值得注意的是，在 350 字以上的文本中，检测准确率显著提升。从长远来看，建立完善的评估体系至关重要。`,
    hasNumbers: true,
  },
  {
    name: "混合叙事（新闻+评论）",
    text: `据统计，2025 年中国数字经济规模达到 56 万亿元，占 GDP 比重 42%。值得注意的是，这一数字较 2020 年增长了 23%。与此同时，人工智能产业的年复合增长率达到 35.7%，远超传统行业。综上所述，数字化转型已成为不可逆转的趋势。然而，数据安全和隐私保护问题也日益凸显。因此，我们需要在技术创新与风险管控之间找到平衡。`,
    hasNumbers: true,
  },
];

const intensities = [0.3, 0.7, 1.0];

// 病句检查：去味后不应出现这些模式
const badPatterns: [string, RegExp][] = [
  ["越来越增多", /越来越来越|越来越增多/],
  ["急用思考", /急用/],
  ["裸难接动词", /(者|人|们)难(?!以)/],
  ["但，", /但，/],
  ["具有挺", /具有挺/],
  ["双垫词", /(说真的|要我说|老实讲|讲真|说实话|说白了|其实)，(说真的|要我说|有意思的是|老实讲|讲真|说实话)/],
  ["无主句", /。(?:成为|使得|意味着)[^。]/],
  ["落到实处", /落到实处/],
  ["连续标点", /[，、]{2,}|。{2,}|！{2,}/],
  ["空引号", /[""]{2}/],
];

let totalScoreDrop = 0;
let totalCases = 0;
let totalBadHits = 0;
let totalFingerprintIssues = 0;
let totalFidelityIssues = 0;

console.log("=".repeat(80));
console.log("  趣AI味 · 多场景功能测试（5 类文本 × 3 强度 × 指纹/忠实/朱雀）");
console.log("=".repeat(80));

for (const c of cases) {
  console.log("\n" + "─".repeat(80));
  console.log(`【${c.name}】`);
  console.log("─".repeat(80));

  const before = aiScore(c.text);
  console.log(`原文 AI 味评分：${before.score}（套话 ${before.formulaicHits} · CV ${before.burstiness} · 均长 ${before.avgLen}）`);
  console.log(`原文指纹体检：${fingerprintCheck(c.text).issues.length} 项`);
  fingerprintCheck(c.text).issues.forEach((i) => console.log(`  · ${i.name} ×${i.count}`));

  for (const it of intensities) {
    const r = humanizeWithScore(c.text, { intensity: it, seed: 42 });
    const drop = before.score - r.after.score;
    totalScoreDrop += drop;
    totalCases++;

    // 病句扫描
    let badHits = 0;
    const badList: string[] = [];
    for (const [name, re] of badPatterns) {
      if (re.test(r.text)) { badHits++; badList.push(name); }
    }
    totalBadHits += badHits;

    // 指纹体检
    const fp = fingerprintCheck(r.text);
    totalFingerprintIssues += fp.issues.length;

    // 忠实度校验
    const fid = checkFidelityLocal(c.text, r.text);
    if (!fid.pass) totalFidelityIssues += fid.problems.length;

    console.log(`\n  强度 ${it} → 评分 ${before.score}→${r.after.score}（降 ${drop}）${drop > 0 ? "✅" : drop < 0 ? "❌反升" : "➖"}`);
    console.log(`    套话 ${r.after.formulaicHits} · CV ${r.after.burstiness} · 均长 ${r.after.avgLen}`);
    if (badHits > 0) console.log(`    ⚠️ 病句命中：${badList.join("、")}`);
    else console.log(`    ✅ 零病句`);
    if (fp.issues.length > 0) {
      console.log(`    指纹残留 ${fp.issues.length} 项：${fp.issues.map((i) => i.name).join("、")}`);
    } else {
      console.log(`    ✅ 指纹体检通过`);
    }
    if (c.hasNumbers && !fid.pass) {
      console.log(`    ⚠️ 忠实度：${fid.problems.join("；")}`);
    } else if (c.hasNumbers) {
      console.log(`    ✅ 忠实度通过（数字/术语完整）`);
    }
  }

  // 朱雀增强对比（强度 0.7）
  console.log("\n  ── 朱雀增强模式（强度 0.7）──");
  const base = humanize(c.text, { intensity: 0.7, seed: 42 });
  const zq = applyZhuqueFeatures(base, 0.7, 42, "casual");
  const baseScore = aiScore(base);
  const zqScore = aiScore(zq);
  console.log(`    普通去味：${baseScore.score} → 朱雀增强：${zqScore.score}${zqScore.score <= baseScore.score ? " ✅" : " ⚠️"}`);
  const zqFp = fingerprintCheck(zq);
  if (zqFp.issues.length > 0) {
    console.log(`    朱雀增强指纹：${zqFp.issues.map((i) => i.name).join("、")}`);
  } else {
    console.log(`    ✅ 朱雀增强指纹体检通过`);
  }
  // 朱雀增强不应引入病句
  let zqBad = 0;
  for (const [, re] of badPatterns) if (re.test(zq)) zqBad++;
  console.log(`    朱雀增强病句：${zqBad === 0 ? "✅ 零病句" : `❌ ${zqBad} 处`}`);

  // 输出截断预览
  console.log(`\n  去味预览（强度 0.7）：${base.slice(0, 120)}…`);
}

// 汇总
console.log("\n" + "=".repeat(80));
console.log("  汇总");
console.log("=".repeat(80));
console.log(`  测试用例：${cases.length} 类 × ${intensities.length} 档 = ${totalCases} 次去味`);
console.log(`  平均评分降幅：${(totalScoreDrop / totalCases).toFixed(1)} 分`);
console.log(`  病句命中总数：${totalBadHits} ${totalBadHits === 0 ? "✅" : "❌"}`);
console.log(`  指纹残留总数：${totalFingerprintIssues} 项`);
console.log(`  忠实度问题总数：${totalFidelityIssues} 处 ${totalFidelityIssues === 0 ? "✅" : "❌"}`);

if (totalBadHits === 0 && totalFidelityIssues === 0) {
  console.log("\n✅ 全部通过：零病句、零忠实度问题");
} else {
  console.log("\n⚠️ 存在问题，需排查");
}