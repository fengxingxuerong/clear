/**
 * run-async.ts —— 「起子进程」的统一异步入口
 *
 * ## 为什么会有这个文件（2026-10-09 实测）
 *
 * 一批测试里有 7 条「真起进程」的用例（真跑 CLI、真跑门禁、真跑 git），此前一律用
 * `spawnSync` / `execFileSync`。在某些宿主环境里，Node 的**同步**子进程派生会被整体挡住：
 *
 * ```
 * spawnSync(node / cmd.exe / git)  →  EBUSY   // 同步，全灭
 * spawn(node / cmd.exe / git)      →  正常    // 异步，结果正确
 * ```
 *
 * 后果不是"测试跑得慢"，而是**断言失去意义**：`r.status` 恒 `-1`，用例要么假红、
 * 要么（更坏）在 `expect(r.status).toBe(0)` 上红完全场，让人误判成代码回归。
 * 「环境不让派生」绝不能伪装成「被测程序跑挂了」。
 *
 * 所以把所有派生收口到这一个异步实现里，顺带统一三件事：
 *  ① 超时就杀、并且 `timedOut` 明确标出来（不让超时退化成一个来历不明的退出码）；
 *  ② 派生失败（`error` 事件）与"进程跑了但退非 0"分开；
 *  ③ stdout/stderr 一定带上编码，避免 `Buffer` 混进字符串拼接。
 *
 * 一句话：**这个模块存在的意义，是让"进程没起来"永远不会被读成"程序判错了"。**
 */
import { spawn } from "node:child_process";

export interface RunResult {
  /** 退出码；进程没起来或被超时杀掉时为 -1（不用 0/undefined 这种会被误读成成功的值） */
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr，测试里当失败原因直接塞给 expect 的第二个参数 */
  log: string;
  /** 被超时杀掉。区分它很重要：超时不是"被测程序判红"，是"这次取值作废" */
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 默认 120 秒；设为 0 表示不超时 */
  timeoutMs?: number;
}

/**
 * 异步起一个子进程并等它结束。
 *
 * @param file 可执行文件（一般是 `process.execPath` 或 "git"）
 * @param args 参数
 * @param opts 选项
 */
export function runAsync(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { cwd, env, timeoutMs = 120_000 } = opts;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });

    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            // 超时必须先杀再结算：否则 promise 要等到进程自己退出才 resolve，
            // 一个卡死的子进程能把整条测试链挂到天荒地老（本项目踩过同款：覆盖率门禁超时后不返回）
            try {
              child.kill();
            } catch {
              /* 已经退了就无所谓 */
            }
            finish({
              code: -1,
              stdout,
              stderr,
              log: `${stdout}${stderr}\n[run-async] 超过 ${timeoutMs}ms 未结束，已杀`,
              timedOut: true,
            });
          }, timeoutMs)
        : undefined;

    child.on("error", (e) => {
      finish({
        code: -1,
        stdout,
        stderr,
        log: `${stdout}${stderr}\n[run-async] 派生失败：${e.message}（code 记 -1，不要当成被测程序的判红）`,
        timedOut: false,
      });
    });
    child.on("close", (code, signal) => {
      const c = typeof code === "number" ? code : -1;
      const note = signal ? `\n[run-async] 被信号终止：${signal}` : "";
      finish({ code: c, stdout, stderr, log: `${stdout}${stderr}${note}`, timedOut: false });
    });
  });
}

/** 只想要 {code, log} 两件套的地方用的包装（形状对齐原来的 spawnSync 用法） */
export function runSimple(file: string, args: string[], opts: RunOptions = {}) {
  return runAsync(file, args, opts).then(({ code, log }) => ({ code, log }));
}
