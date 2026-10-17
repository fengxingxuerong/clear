/**
 * zhuque-official-run.ts 的 `--only` 契约测试。
 *
 * 为什么值得单独立一个文件：这个脚本是**烧官方额度**的那一个，而额度按天算。
 * 2026-10-17 实测发现 `--only BAD_ID` 只 warn 不抛错 ⇒ selected 空 ⇒ todo 空 ⇒
 * 落到「全部已认证，无需送检」并 **exit 0**。用户以为跑完了，其实一篇都没送，
 * 白丢一天窗口。所以这里锁三件事：
 *   ① 未知 id 必须 exit 非 0，且报错里列出可用 id；
 *   ② 合法 id 的 dry-run 必须 exit 0（防止"一律非 0"的假通过）；
 *   ③ 缺 Key 实跑必须 exit 非 0（链路自检，不依赖真实 Key）。
 *
 * 全部走**真实子进程**（node --import tsx），不 mock：退出码本身就是被验证的对象。
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "zhuque-official-run.ts");

const run = promisify(execFile);

async function runScript(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, ZHUQUE_API_KEY: "", ...env },
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("zhuque-official-run --only", () => {
  it("未知 id：退出码非 0，且报错列出可用 id", async () => {
    const r = await runScript(["--dry-run", "--only", "BAD_ID"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("未知 id");
    expect(r.stderr).toContain("BAD_ID");
    // 可用 id 必须出现在报错里，否则用户还得回去翻文档
    expect(r.stderr).toMatch(/O1/);
    expect(r.stderr).toMatch(/H0/);
  });

  it("部分未知也拦下整批：不送一半、留一半", async () => {
    const r = await runScript(["--dry-run", "--only", "H0,NOPE"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("NOPE");
    // 拦下时不能顺手把 H0 也排上日程
    expect(r.stdout).not.toContain("待送检");
  });

  it("合法 id 的 dry-run：退出码 0（防「一律非 0」的假通过）", async () => {
    const r = await runScript(["--dry-run", "--only", "O1,N1,D0,H0,H1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("待送检 5 篇");
    expect(r.stdout).toContain("[dry-run]");
  });

  it("不带 --only 的 dry-run：18 篇全列，退出码 0", async () => {
    const r = await runScript(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("待送检 18 篇");
  });

  it("缺 Key 实跑：退出码非 0，并指出去哪儿拿 Key", async () => {
    const r = await runScript(["--only", "H0"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("ZHUQUE_API_KEY");
  });
});
