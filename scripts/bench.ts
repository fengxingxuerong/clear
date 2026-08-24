import { humanize } from "../src/engine/humanize.ts";

// 性能基准测试
const longText = `随着人工智能技术的快速发展，大语言模型在各个领域的应用日益广泛。从自然语言处理到代码生成，从智能客服到内容创作，AI 正在深刻改变着我们的工作和生活方式。值得注意的是，这一技术变革不仅提升了生产效率，更为传统行业的数字化转型提供了新的可能。
然而，AI 技术的快速发展也带来了一系列值得关注的挑战。首先是数据安全问题，大语言模型在训练过程中需要海量数据，如何确保用户隐私不被泄露成为了一个亟待解决的问题。其次是伦理道德问题，AI 生成的内容可能存在偏见或误导性信息，这对于信息传播的准确性构成了潜在威胁。与此同时，AI 技术的广泛应用也可能导致部分传统岗位的减少，这对就业市场产生了深远影响。
从长远来看，人工智能技术的发展趋势是不可逆转的。我们不能因为潜在的风险就停止探索，也不能盲目乐观地忽视问题。因此，建立完善的监管体系和技术标准至关重要。一方面，政府应当加强对AI技术的监管，制定相关法律法规，确保技术发展在合理范围内进行。另一方面，企业也应当承担社会责任，在追求技术创新的同时，注重伦理约束和社会影响。
综上所述，人工智能技术是一把双刃剑。它既为社会发展带来了前所未有的机遇，也提出了新的挑战。唯有在技术创新与伦理约束之间找到平衡，才能让 AI 技术真正造福人类社会。这需要政府、企业、学术机构和公众的共同努力，携手构建一个可持续发展的 AI 生态体系。`;

// 生成不同规模的文本
const sizes = [1, 5, 10, 20, 50];
console.log("=== 性能基准（本地引擎，朱雀增强0.9）===\n");
console.log("文本规模 | 字数 | 耗时");

for (const mult of sizes) {
  const full = Array(mult).fill(longText).join("\n\n");
  const charCount = full.replace(/\s/g, "").length;

  // 预热
  humanize(full, { intensity: 0.9, seed: 42, zhuqueMode: true });

  const t0 = performance.now();
  for (let i = 0; i < 3; i++) {
    humanize(full, { intensity: 0.9, seed: 42, zhuqueMode: true });
  }
  const dt = (performance.now() - t0) / 3;

  console.log(
    `x${mult.toString().padStart(2)}  | ${String(charCount).padStart(5)}字 | ${dt.toFixed(0)}ms`,
  );
}

// 普通模式对比
console.log("\n=== 普通模式对比（10x）===\n");
const full10 = Array(10).fill(longText).join("\n\n");
const t0 = performance.now();
humanize(full10, { intensity: 0.9, seed: 42, zhuqueMode: false });
console.log(`普通模式: ${(performance.now() - t0).toFixed(0)}ms`);
const t1 = performance.now();
humanize(full10, { intensity: 0.9, seed: 42, zhuqueMode: true });
console.log(`朱雀模式: ${(performance.now() - t1).toFixed(0)}ms`);
