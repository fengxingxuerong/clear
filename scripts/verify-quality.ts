/**
 * 质量校验：确保「……」占位已消除、黑话本体不再作为替身泄漏。
 * 用法：node --experimental-strip-types src/engine/verify-quality.ts（或 npx tsx ...）
 * 任一硬性校验失败即非零退出（CI 可感知）。
 *
 * v0.8.6 自校验：核心校验逻辑抽为 runQualityChecks 导出，被
 * scripts/verify-quality.test.ts 直接断言——门禁自身失效时 vitest 会亮红，
 * 而不是让所有"通过"信号静默失真。
 */
import { humanize } from "../src/engine/humanize.ts";
declare const process: { exit(code?: number): never };

export const LEAK_WORDS = [
  "赋能",
  "基于",
  "诸如",
  "闭环",
  "生态",
  "护城河",
  "飞轮",
  "对齐",
  "心智",
  "沉淀",
  "反哺",
  "在……背景下",
];

const text =
  "值得注意的是，基于大数据，技术赋能传统产业已成为趋势。诸如电商、物流等赛道，" +
  "我们要构建生态闭环，打造护城河，让飞轮转起来。团队需对齐心智，沉淀经验，反哺业务，" +
  "在高质量发展的背景下稳步推进。";

/** 单次扫描：返回 {省略号残留, 黑话泄漏次数} */
export function scanOutput(out: string): { ellipsis: boolean; leak: number } {
  let leak = 0;
  for (const w of LEAK_WORDS) if (out.includes(w)) leak++;
  return { ellipsis: out.includes("……"), leak };
}

/** 完整校验（25 种子 × 双强度）。供脚本 main 与测试共用。 */
export function runQualityChecks() {
  // 强度 1.0：p=1.0 应 100% 替换，且因已删除「替身=原词」无效项，输出须零泄漏、零字面省略号
  let hardEllipsis = false;
  let hardLeak = 0;
  for (let seed = 0; seed < 25; seed++) {
    const s = scanOutput(humanize(text, { intensity: 1.0, seed }));
    if (s.ellipsis) hardEllipsis = true;
    hardLeak += s.leak;
  }

  // 强度 0.7：按设计约 13% 套话保留，仅作信息统计
  let softLeak = 0;
  for (let seed = 0; seed < 25; seed++) {
    softLeak += scanOutput(humanize(text, { intensity: 0.7, seed })).leak;
  }

  return { hardEllipsis, hardLeak, softLeak };
}

/* ----------------------------- CLI 入口 ----------------------------- */

const r = runQualityChecks();
const { hardEllipsis, hardLeak, softLeak } = r;

console.log("[强度1.0] 含字面省略号(……):", hardEllipsis ? "❌ 有" : "✅ 无");
console.log(
  "[强度1.0] 黑话本体泄漏:",
  hardLeak === 0 ? "✅ 0（无效替身已清除）" : `❌ ${hardLeak}`,
);
console.log(`[强度0.7] 黑话保留 ${softLeak} 次（按设计，强度<1 故意不全改）`);
console.log("\n示例输出(强度0.7, seed=3):\n" + humanize(text, { intensity: 0.7, seed: 3 }));

// 硬性校验：强度 1.0 必须零泄漏、零字面省略号
const hardFails = (hardEllipsis ? 1 : 0) + (hardLeak === 0 ? 0 : 1);
if (hardFails > 0) {
  console.error(`\n❌ 质量校验失败：省略号残留=${hardEllipsis}，黑话泄漏=${hardLeak} 次`);
  process.exit(1);
}
console.log("\n✅ 质量校验通过（强度1.0 零泄漏、零省略号）");
