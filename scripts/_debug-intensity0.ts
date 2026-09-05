import { humanize } from "../src/engine/humanize.ts";

const samples = [
  [
    "s1",
    "随着互联网技术的不断发展，远程办公逐渐成为一种流行的工作方式。值得注意的是，远程办公不仅提高了工作效率，还显著提升了员工的工作生活平衡。然而，远程办公也面临着一系列挑战，诸如沟通成本、团队协作等问题。因此，企业需要不断优化管理流程，以确保协作质量。总而言之，远程办公既带来了机遇，也带来了挑战，我们应当以理性的态度看待它。",
  ],
  [
    "s2",
    "人工智能正在深刻改变教育行业。首先，人工智能可以实现个性化学习，针对每个学生的特点制定学习方案。其次，人工智能有助于减轻教师的负担，让教师将更多精力投入到教学创新中。此外，人工智能还能够提供即时反馈，帮助学生及时发现并解决问题。与此同时，我们也必须认识到，技术赋能教育并不意味着教师可以被替代。教育的核心在于育人，这是任何技术都无法完全实现的。综上所述，人工智能与教育的融合是大势所趋，我们既要积极拥抱技术，也要坚守教育的本质。",
  ],
  [
    "s3",
    "随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。值得注意的是，数字化阅读不仅改变了人们获取知识的方式，还显著提升了阅读的便捷性。",
  ],
];

let pass = 0;
for (const [name, text] of samples) {
  const out = humanize(text, { intensity: 0, seed: 1 });
  if (out === text) {
    console.log(`✅ ${name}: 强度0 保持原文`);
    pass++;
  } else {
    let i = 0;
    while (i < Math.min(text.length, out.length) && text[i] === out[i]) i++;
    console.log(`❌ ${name}: 强度0 改动。首个 diff 位置=${i}`);
    console.log(`  原文: …${text.slice(Math.max(0, i - 15))}[${text[i] ?? "EOF"}]${text.slice(i + 1, i + 25)}…`);
    console.log(`  输出: …${out.slice(Math.max(0, i - 15))}[${out[i] ?? "EOF"}]${out.slice(i + 1, i + 25)}…`);
  }
}
console.log(`\n${pass}/${samples.length} 通过`);
