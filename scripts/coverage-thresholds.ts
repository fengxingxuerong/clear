/**
 * coverage-thresholds.ts —— 覆盖率阈值的**唯一事实源**。
 *
 * 为什么要单独一个文件：阈值此前只写在 vite.config.ts 的注释与配置里，
 * 而 `npm run test:cov` 又用命令行参数写了第二份（--coverage.thresholds.lines=75 …），
 * 两份各自漂移。经核实（2026-10-03），本机覆盖率门禁从未真正生效（见 coverage-gate.ts 头部），
 * 所以「哪里是真阈值」已经说不清。现在两处都从这里取，改一次即两处同步。
 *
 * 基线（2026-10-03 实测，含 63 文件/1102 用例）：
 *   Stmt 92.3% / Branch 84.9% / Func 92.6%（阈值 75，余量充足）
 * 注意：报告里**不含** src/main.tsx、src/ppl/ppl-worker.ts、src/types/*.d.ts 三个文件
 *   （v8 provider 默认只统计被测试加载过的文件；这三者是入口/worker/纯类型）。
 *   即真实覆盖略低于上面的数字，差值 <1pt。不为它们去追数字——那是入口层测试的事，
 *   见 docs 里对 desktop-entry-testability 的记录。
 */
export const COVERAGE_THRESHOLDS = {
  statements: 75,
  branches: 75,
  functions: 75,
  lines: 75,
} as const;

export type CoverageThresholds = typeof COVERAGE_THRESHOLDS;
