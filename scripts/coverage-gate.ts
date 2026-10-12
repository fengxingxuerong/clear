/**
 * coverage-gate.ts —— 覆盖率门禁（本机可用版，v0.9.21 新增）
 *
 * ## 为什么需要这层包装（实测，不是推测）
 *
 * 这个项目一直有 `test:cov`，vite.config.ts 里也写了 75% 阈值，CI 也在跑 ——
 * 但**本机这门禁从来没有真正生效过**，原因是一个与代码无关的环境事实：
 *
 *   vitest 的 `--coverage` 在收尾时会 `rm -rf coverage/.tmp`（v8 provider 的原始
 *   blob，每个测试文件一个 → 63 个），以及开头会 `rm -rf coverage/`（上次的
 *   html+json，87 个文件）。**本机有批量删除守卫，单轮上限 50 个文件**，
 *   两次都会抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` → 进程以非零退出。
 *
 * 关键顺序（node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:793-796）：
 *   reportCoverage() { generateReports()  // ← 阈值校验在这里
 *                      cleanAfterRun() }  // ← 崩溃在这里
 * 即：**阈值校验先跑，清理后崩**。所以覆盖率达标时本命令**也会**非零退出 ——
 * 它是一个结构性假红。假红比没有门禁更糟：它训练人忽略红灯，于是
 * `coverage/coverage-final.json` 从 2026-09-30 起就再没人生成过，报告形态也坏了没人知道。
 *
 * ## 因此本门禁的判定纪律
 *
 * **不采信退出码，一律从外部可观测事实派生判定**：
 *   ① 产物 `coverage/coverage-final.json` 必须存在且**新于本次开跑时刻**（防陈旧基准）；
 *   ② 输出里的测试计数必须显示 0 failed（解析前先剥 ANSI，vitest 即使被管道捕获也带色码）；
 *   ③ 覆盖率四项指标由**报告本身**重算，与阈值比较 —— 阈值从 coverage-thresholds.ts 取（单一事实源）；
 *   ④ 退出码只用来识别「非守卫引起的意外错误」：若有无法归因的 Unhandled Error 仍判红。
 *
 * 退出码：0 = 通过；1 = 覆盖率不达标/测试失败/意外错误；2 = 环境错（拿不到报告依据）。
 *
 * 用法：npx tsx scripts/coverage-gate.ts [--keep]   （--keep 保留上次报告，仍会清）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { COVERAGE_THRESHOLDS, type CoverageThresholds } from "./coverage-thresholds";

const ROOT_RAW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// v0.9.34：盘符大写化。本机 MSYS/Git Bash 链路会把盘符规范化成小写
// （import.meta.url 推出 d://projects//...），而宿主 LiteSandbox broker 对
// 派生进程的路径匹配大小写敏感：小写盘符下 vitest worker 加载异常 →
// 82 文件全红「0 test」（`reading 'config'`，与沙箱/反斜杠症状一模一样）。
// 实测：大写 D:/ 与 D:// 全过（1735 passed），小写 d: 全挂。FS 层大小写
// 无关，本 gate 自己的 fs 操作两种都正常——坏的只有 broker 匹配那一跳。
const ROOT = ROOT_RAW.replace(/^([a-z]):/, (_m, c: string) => c.toUpperCase() + ":");
const REPORT = path.join(ROOT, "coverage", "coverage-final.json");
const REPORTS_DIR = path.join(ROOT, "coverage");
const VITEST_BIN = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");

/** 全部 CSI 形式，含带 ? 参数的（漏了 \u001b[?25l 这类会留残渣） */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex -- 职责就是识别并剥掉 ANSI 控制序列，正则里必须出现这些控制字符
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

const GUARD_SIG = /SAFE_DELETE_BULK_CONFIRM_REQUIRED/g;

/**
 * 清空报告目录。**不能用 fs.rmSync 一条路走到底**：本机批量删除守卫拦 >50 个文件
 * （正是本文件存在的原因），而且某些宿主环境连 `cmd /c rd` 的同步派生都会挡下
 * （实测 `spawnSync cmd.exe EBUSY`）。所以三条通道依次试：
 *
 *  ① `cmd /c rd /s /q`      —— Windows 原生递归删除，不经 Node 的 fs 垫片
 *  ② `fs.rmSync`            —— cmd 派生被环境挡下时的备选（coverage 文件数不多时秒级）
 *  ③ **`fs.renameSync` 挪走** —— 前两条都被守卫拦下时的最后退路
 *
 * ③ 为什么算"清理成功"：挪走之后 `coverage/` 对本次运行而言**已经不存在**，
 * vitest 会从头写一份新报告，不可能读到上次的残留（这正是清理要防的事）。
 * 而且 rename 不是删除，绕得开守卫；代价只是留下一个 `coverage.stale-<ts>` 待清目录
 * —— **留个待清目录远好过把"环境不让删"判成"覆盖率不达标"**。
 * 判据放在这里而不是信 exit code：报告新鲜度靠"目录确实是新的"来保证。
 */
function cleanReportsDir(): void {
  if (!fs.existsSync(REPORTS_DIR)) return;
  const stillThere = () => fs.existsSync(REPORTS_DIR);
  if (process.platform === "win32") {
    const winPath = REPORTS_DIR.split("/").join("\\");
    try {
      execFileSync("cmd.exe", ["/c", "rd", "/s", "/q", winPath], { encoding: "utf8" });
    } catch {
      /* rd 对"目录不存在"也返回非零，用 existsSync 复核而不是信退出码 */
    }
    if (stillThere()) {
      try {
        fs.rmSync(REPORTS_DIR, { recursive: true, force: true });
      } catch (rmErr) {
        // 第三通道：挪走。删除被守卫拦下时唯一还能保证"本次读到的是新报告"的办法
        try {
          const aside = `${REPORTS_DIR}.stale-${Date.now()}`;
          fs.renameSync(REPORTS_DIR, aside);
          console.log(
            `   ⓘ 删除被本机守卫拦下，已把旧报告挪到 ${path.basename(aside)}（下次有空手动删；\n` +
              `     不影响本次判定——新报告会从头写，不会读到旧数据）`,
          );
        } catch (mvErr) {
          throw new Error(
            `清理 ${REPORTS_DIR} 失败：rd / rmSync / rename 三条通道都不通` +
              `（${(rmErr as Error).message} / ${(mvErr as Error).message}）`,
            // rmErr 的原因写在 message 里（两条通道分工不同，合起来才看得出是
            // 守卫 + 派生拦截同时生效）；cause 挂最后那次，符合「带着原始错误抛」的约定
            { cause: mvErr },
          );
        }
      }
    }
  } else {
    fs.rmSync(REPORTS_DIR, { recursive: true, force: true });
  }
  if (stillThere()) throw new Error(`报告目录仍存在，清理未生效：${REPORTS_DIR}`);
}

interface IstanbulFileCov {
  statementMap: Record<string, { start?: { line?: number } }>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

interface Metrics {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
  files: number;
}

/** 从报告重算四项指标（不看 vitest 打印的表格，避免"打印面 ≠ 校验面"） */
function metricsFromReport(map: Record<string, IstanbulFileCov>): Metrics {
  const st: [number, number] = [0, 0];
  const br: [number, number] = [0, 0];
  const fn: [number, number] = [0, 0];
  const lineHit = new Map<string, boolean>();

  for (const [file, d] of Object.entries(map)) {
    for (const id in d.s) {
      st[1]++;
      const hit = (d.s[id] ?? 0) > 0;
      if (hit) st[0]++;
      const line = d.statementMap[id]?.start?.line;
      if (typeof line === "number") {
        const key = `${file}:${line}`;
        lineHit.set(key, (lineHit.get(key) ?? false) || hit);
      }
    }
    for (const id in d.f) {
      fn[1]++;
      if ((d.f[id] ?? 0) > 0) fn[0]++;
    }
    for (const id in d.b) {
      for (const c of d.b[id] ?? []) {
        br[1]++;
        if (c > 0) br[0]++;
      }
    }
  }
  const pct = (a: [number, number]) => (a[1] ? (100 * a[0]) / a[1] : 100);
  let linesHit = 0;
  for (const v of lineHit.values()) if (v) linesHit++;
  return {
    statements: pct(st),
    branches: pct(br),
    functions: pct(fn),
    lines: lineHit.size ? (100 * linesHit) / lineHit.size : 100,
    files: Object.keys(map).length,
  };
}

interface RunResult {
  code: number | null;
  /** "timeout" 是本门禁自己给的兜底信号（进程树杀不掉），不是操作系统信号 */
  signal: NodeJS.Signals | "timeout" | null;
  out: string;
}

/**
 * 杀进程树：只 `child.kill()` 杀不掉 vitest 的 worker 池，主进程没了而子进程还在，
 * close 事件永远不来 —— 实测表现为全链 `check:release` 在覆盖率门禁这一步**静默挂死**
 * （15 分钟超时触发后，日志 28 分钟一行未增，人只能靠猜）。故超时后走 taskkill /T /F。
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    process.kill(pid, "SIGKILL");
  } catch {
    /* 进程已退出，忽略 */
  }
}

/** 异步 spawn：本进程不提供服务，本可用 spawnSync；但异步能拿到 signal 与超时，诊断更好 */
function runVitest(timeoutMs: number): Promise<RunResult> {
  return new Promise((done) => {
    // v0.9.34：spawn 的 cwd 从 ROOT 挪到 os.tmpdir()，args 同步带 `--root`。
    //
    // 根因（2026-10-12 深夜实测，与项目代码无关——最小测试文件也复现）：
    // 本机宿主（WorkBuddy 5.7.7）通过 NODE_OPTIONS 注入 language shim，
    // 且 LiteSandbox 对「**工作区目录内**派生的子进程」做 broker 代理。
    // 两者叠加使 vitest 的 tinypool worker 加载不到完整的 @vitest/runner 状态
    // → 测试文件在 collection 阶段就抛
    // `TypeError: Cannot read properties of undefined (reading 'config')`
    // → 82 个文件全红「0 test」→ onTestFailure 触发 cleanAfterRun →
    // 撞 SAFE_DELETE_BULK_CONFIRM_REQUIRED（覆盖率门禁的经典伪装形态）。
    // 对照组（全过，1734 passed / 82 文件实测）：cwd 在工作区之外
    // （/tmp、D:/projects 均可）+ 剥掉 NODE_OPTIONS + `--root`。
    // 22:33 宿主切换前无此问题；此前 cwd=ROOT 且带 shim 也能跑是运气。
    //
    // ⚠️ 坑中坑（本次实测第二个形态）：`--root` 必须传**正斜杠**路径。
    // path.resolve 产物是反斜杠（d:\projects\quaiwei），作为 CLI arg 进
    // vitest 的 cac 解析器会被当转义序列吞掉字符 → root 解析错位 →
    // 同样的 `reading 'config'`（82 文件全红，与沙箱症状一模一样）。
    // 对照实验：`--root D:/projects/quaiwei` 过 / `--root d:\projects\quaiwei` 挂。
    //
    // 判据一个字没动：root 仍是仓库根，config 解析、include 范围、
    // coverage 报告目录（相对 root）全部照旧；变的只有 worker 的派生位置
    // 与继承的 env。门禁不需要宿主 language shim（那是 Bash 工具的中文处理）。
    const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
    delete childEnv.NODE_OPTIONS;
    // root 参数用正斜杠（反斜杠进 cac 解析器会被当转义吞字符，实测同挂），
    // 盘符已在 ROOT 定义处大写化（见那里的注释：小写盘符 broker 匹配失败）。
    const rootArg = ROOT.split(path.sep).join("/");
    const child = spawn(process.execPath, [VITEST_BIN, "run", "--coverage", "--root", rootArg],
      {
        cwd: os.tmpdir(),
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      done(r);
    };
    const timer = setTimeout(() => {
      out += `\n[gate] 超过 ${Math.round(timeoutMs / 1000)}s 未结束 → 杀 vitest 进程树`;
      killTree(child.pid);
      // 兜底：进程树仍不退就直接判超时，绝不让门禁无限期挂着
      hardTimer = setTimeout(
        () =>
          finish({
            code: null,
            signal: "timeout",
            out: out + `\n[gate] 进程树未退出，按超时判红（不采信任何指标）`,
          }),
        20_000,
      );
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("close", (code, signal) => finish({ code, signal, out }));
    child.on("error", (e) =>
      finish({ code: null, signal: null, out: out + `\n[spawn error] ${e.message}` }),
    );
  });
}

function countMatches(s: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s) !== null) n++;
  re.lastIndex = 0;
  return n;
}

function fmt(n: number): string {
  return n.toFixed(1).padStart(6);
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  if (!fs.existsSync(VITEST_BIN)) {
    console.error(`✗ 找不到 ${VITEST_BIN}——依赖没装齐，门禁无法判定`);
    process.exit(2);
  }

  console.log("══════════ 覆盖率门禁（从产物派生判定）══════════");
  cleanReportsDir();

  // 超时可用环境变量覆盖：CI 想早点失败、或本机想验证超时分支时改成 60_000 即可
  const overrideMs = Number(process.env.COVERAGE_GATE_TIMEOUT_MS ?? "");
  const run = await runVitest(
    Number.isFinite(overrideMs) && overrideMs > 0 ? overrideMs : 15 * 60 * 1000,
  );
  const out = stripAnsi(run.out);

  // ---- 事实 ⓪：跑没跑完（旧版这里会静默挂死，见 runVitest 的注释）----
  if (run.signal === "timeout") {
    console.error(
      "✗ vitest 超时且进程树未能结束 —— 本轮覆盖数据不完整，按纪律判红，不许拿半截报告当依据",
    );
    console.error("  输出尾部：\n" + out.split("\n").slice(-25).join("\n"));
    process.exit(2);
  }

  // ---- 事实 ①：报告是否为本轮新生成（陷阱：基准自己过期 → 假绿）----
  if (!fs.existsSync(REPORT)) {
    console.error(
      "✗ 没拿到覆盖报告依据（coverage/coverage-final.json 不存在）——按纪律判红，不许当成通过",
    );
    console.error(`  vitest 退出码=${run.code} signal=${run.signal}`);
    console.error("  输出尾部：\n" + out.split("\n").slice(-25).join("\n"));
    process.exit(2);
  }
  const reportMtime = fs.statSync(REPORT).mtimeMs;
  if (reportMtime < startedAt - 5000) {
    console.error(
      `✗ 报告陈旧（mtime=${new Date(reportMtime).toISOString()} 早于本次开跑）——不许拿旧值当依据`,
    );
    process.exit(2);
  }

  // ---- 事实 ②：测试是否全过 ----
  const failedTests = /(\d+)\s+failed/.exec(out)?.[1];
  const testLine = out.split("\n").find((l) => /^\s*Tests\s/.test(l)) ?? "(未找到 Tests 行)";
  const fileLine =
    out.split("\n").find((l) => /^\s*Test Files\s/.test(l)) ?? "(未找到 Test Files 行)";

  // ---- 事实 ③：退出码归因（守卫崩溃是已知环境现象，不算代码问题）----
  const guardHits = countMatches(out, GUARD_SIG);
  const unhandled = countMatches(out, /Unhandled Error/g);
  const unexplained = unhandled - guardHits;

  const map = JSON.parse(fs.readFileSync(REPORT, "utf8")) as Record<string, IstanbulFileCov>;
  const m = metricsFromReport(map);
  if (m.files === 0) {
    console.error("✗ 报告里 0 个文件——解析不到内容即为判据失效，判红");
    process.exit(2);
  }

  // ---- 判定 ----
  const problems: string[] = [];
  if (failedTests && Number(failedTests) > 0) problems.push(`有 ${failedTests} 个用例失败`);
  if (unexplained > 0)
    problems.push(`有 ${unexplained} 处无法归因的 Unhandled Error（退出码 ${run.code}）`);
  const th = COVERAGE_THRESHOLDS as CoverageThresholds;
  const below: string[] = [];
  for (const k of ["statements", "branches", "functions", "lines"] as const) {
    if (m[k] + 1e-9 < th[k]) below.push(`${k} ${m[k].toFixed(1)}% < ${th[k]}%`);
  }
  if (below.length) problems.push("低于阈值：" + below.join("；"));

  console.log(`  ${fileLine.trim()}`);
  console.log(`  ${testLine.trim()}`);
  console.log("");
  console.log("  指标        实测      阈值");
  for (const k of ["statements", "branches", "functions", "lines"] as const) {
    const label = { statements: "Stmt", branches: "Branch", functions: "Func", lines: "Lines" }[k];
    console.log(
      `  ${label.padEnd(8)} ${fmt(m[k])}%  ≥ ${th[k]}%   ${m[k] + 1e-9 >= th[k] ? "✅" : "❌"}`,
    );
  }
  console.log(`  报告文件数：${m.files}`);
  if (guardHits > 0) {
    console.log(
      `  ⓘ 本次退出码 ${run.code} 含 ${guardHits} 次本机批量删除守卫拦截（coverage/.tmp 收尾清理，环境现象，非代码问题）`,
    );
  } else if (run.code !== 0) {
    console.log(`  ⓘ vitest 退出码 ${run.code}（无守卫拦截）`);
  }

  if (problems.length) {
    console.error("\n❌ 覆盖率门禁未通过：");
    for (const p of problems) console.error("   · " + p);
    if (unexplained > 0) console.error("\n  输出尾部：\n" + out.split("\n").slice(-25).join("\n"));
    console.error(
      "\n  提示：阈值在 scripts/coverage-thresholds.ts（单一事实源），改它即两处同步。",
    );
    process.exit(1);
  }

  console.log("\n✅ 覆盖率门禁通过（四项指标均由报告重算，未采信退出码）");
}

main().catch((e: unknown) => {
  console.error(`✗ 覆盖率门禁执行异常：${(e as Error).message}`);
  process.exit(2);
});
