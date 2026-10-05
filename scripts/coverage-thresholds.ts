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
 *
 * 2026-10-05 上调为棘轮（全面优化验证轮），同日再收一档：
 *   补测进行中实测 Stmt 94.6 / Branch 87.9 / Func 96.4 / Lines 95.9（先定 90/84/92/91）；
 *   补测收尾后实测 **Stmt 96.6 / Branch 90.5 / Func 97.4 / Lines 97.6**（68 文件/1271 用例），
 *   余量涨到 5~6.6pt，超出下面写的「3~5pt」口径 ⇒ 按同一纪律收到 93/87/94/94，
 *   让余量回到 3.4~3.6pt。**阈值贴着实际值，门禁才有牙齿**；
 *   覆盖 CI(ubuntu/node20) 与本机(win/node24) 的平台差异，以及后续正常改动的小幅波动；
 *   低于它即红，只许变好，不许回调。要降阈值请先在提交信息里写清为什么这不是回退。
 *
 * 2026-10-05 同日第三档（覆盖尾巴补测全部收尾后）：
 *   实测 **Stmt 97.9 / Branch 92.8 / Func 99.2 / Lines 98.6**（68 文件/1336 用例），
 *   93/87/94/94 的余量漂到 4.6~5.8pt，Branch 已越过上面写的「3~5pt」上限
 *   ⇒ 按同一纪律收到 **94/89/95/95**，余量回到 3.6~4.2pt。
 *   这不是「为过门禁调数字」——是门禁先绿、余量变松，再把线往上抬；
 *   方向永远是单向收紧，且每次都在此留档（改了什么、为什么、当时实测值）。
 */
export const COVERAGE_THRESHOLDS = {
  statements: 94,
  branches: 89,
  functions: 95,
  lines: 95,
} as const;

export type CoverageThresholds = typeof COVERAGE_THRESHOLDS;
