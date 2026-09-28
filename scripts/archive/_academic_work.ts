/**
 * 关键验证：academic 档到底做了多少事？
 * 如果输出≈原文，那它"分数低"只是因为没工作，不能算解法。
 */
import { humanize } from "../src/engine/humanize.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";

const EXPO = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元人民币，占 GDP 的比重达到了 41.8%，较上一年度同比提升了 2.3 个百分点。值得注意的是，这一增长速度已经连续八年保持在 15% 以上。
综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系。`;

// 字符级相似度（LCS 简化版：编辑距离）
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

function similarity(a: string, b: string): number {
  const d = editDistance(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

console.log("=== academic 档做了多少改动？ ===");
console.log("体裁   档位  style      相似度   原字数→新字数   score");
console.log("-".repeat(68));

for (const [name, text] of [
  ["论说", EXPO],
] as Array<[string, string]>) {
  for (const intensity of [0.5, 0.7, 0.9]) {
    for (const style of ["academic", "plain", "casual"]) {
      const out = humanize(text, { intensity, zhuqueMode: true, style, seed: 20260826 } as never);
      const sim = similarity(text, out);
      console.log(
        `${name}   ${String(intensity).padEnd(6)}${style.padEnd(12)}${(sim * 100).toFixed(1).padStart(6)}%   ` +
          `${text.length} → ${String(out.length).padEnd(6)} ${String(aiScore(out).score).padStart(3)}`,
      );
    }
  }
}

console.log("\n\n=== academic 0.9 实际输出（全文）===");
const ac09 = humanize(EXPO, { intensity: 0.9, zhuqueMode: true, style: "academic", seed: 20260826 } as never);
console.log(ac09);

console.log("\n\n=== 原文对照（前 300 字）===");
console.log(EXPO.slice(0, 300));
