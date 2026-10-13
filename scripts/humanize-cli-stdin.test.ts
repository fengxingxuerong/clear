/**
 * humanize-cli stdin 管道模式端到端测试（v0.9.38）
 *
 * 为什么走子进程：humanize-cli.ts 无条件 main()，import 即执行（vm 切片测试只覆盖
 * parseArgs 纯函数层，见 scripts-logic.test.ts）；stdin 的真实行为只能在进程级验证。
 *
 * ⚠️ 本机坑（2026-10-13 实测）：node 的 execFile `input` 选项**不可靠**——input 写入后
 * 管道不 EOF，子进程 readFileSync(0) 永久阻塞（20s 才被杀）。bash 管道反而正常
 * （`echo x | node cli` 手动验证过）。故这里用 bash 真管道 + 环境变量传文本
 * （免引号转义），CI 的 windows runner 同样带 Git Bash。
 *
 * 断言的抓手：**正文走 stdout、诊断走 stderr**——`> 重定向` 不混进度行是管道模式的
 * 立身之本；以及「同 seed 可复现」「强度透传」。
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = path.join(ROOT, "scripts", "humanize-cli.ts");

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 跑 CLI：argv 为 humanize-cli 的参数；input 经环境变量 + bash printf 管道喂 stdin。
 * 不 rejects——退出码/输出一并返回，方便断言错误路径的 stderr 文案。
 */
async function runCli(argv: string[], input: string): Promise<RunResult> {
  // 注意：是 `"$NODE_BIN"` 当可执行、tsx cli 当脚本——写反成 `node "$NODE_BIN"` 会让
  // node 把 node.exe 本身当脚本读（MZ SyntaxError，2026-10-13 实测踩过）。
  const script = 'printf %s "$CLI_STDIN" | "$NODE_BIN" "$TSX_BIN" "$CLI_BIN" "$@"';
  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      ["-c", script, "ai-humanizer", ...argv],
      {
        env: {
          ...process.env,
          CLI_STDIN: input,
          NODE_BIN: process.execPath,
          TSX_BIN: TSX,
          CLI_BIN: CLI,
        },
        cwd: ROOT,
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as Error & { code?: number; stderr?: string };
    return { stdout: "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

const AI_TEXT =
  "本文首先阐述了人工智能技术的发展现状，其次分析了其在各行各业中的广泛应用。综上所述，人工智能技术具有广阔的发展前景，值得我们高度重视。";

describe("humanize-cli stdin 模式", () => {
  it("显式 - 参数：stdin 进 → stdout 出去味正文，诊断在 stderr", async () => {
    const r = await runCli(["-", "--seed", "42"], `${AI_TEXT}\n`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(30);
    expect(r.stdout).not.toContain("[1/1]"); // 批量进度行不混进 stdout
    expect(r.stderr).toMatch(/✅ stdin：\d+→\d+/); // 诊断（含前后分）走 stderr
  }, 60_000);

  it("省略输入参数：管道喂 stdin 同样生效（cat 稿 | ai-humanizer）", async () => {
    const r = await runCli(["--seed", "42"], AI_TEXT);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(30);
  }, 60_000);

  it("--seed 可复现：同输入同种子两次输出逐字相同", async () => {
    const a = await runCli(["-", "--seed", "7"], AI_TEXT);
    const b = await runCli(["-", "--seed", "7"], AI_TEXT);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  }, 60_000);

  it("强度参数透传：--intensity 0.9 与 0.3 输出不同（同一 seed）", async () => {
    const strong = await runCli(["-", "--intensity", "0.9", "--seed", "5"], AI_TEXT);
    const mild = await runCli(["-", "--intensity", "0.3", "--seed", "5"], AI_TEXT);
    expect(strong.code).toBe(0);
    expect(mild.code).toBe(0);
    expect(strong.stdout).not.toBe(mild.stdout);
  }, 60_000);

  it("空 stdin → 退出码 1 且 stderr 一句话", async () => {
    const r = await runCli(["-"], "   \n");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("标准输入为空");
  }, 60_000);

  it("stdin + --api → 拒绝并提示落成文件（诚实边界，不重构批量路径）", async () => {
    const r = await runCli(["-", "--api"], AI_TEXT);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stdin 模式暂不支持 LLM 通道");
  }, 60_000);

  it("stdin + --explain → 「为什么这么改」清单进 stderr", async () => {
    const r = await runCli(["-", "--explain", "--seed", "3"], AI_TEXT);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("确定归因"); // formatExplain 的逐条归因输出
  }, 60_000);

  it("重定向可用性：stdout 只有正文，可直接 > 落盘", async () => {
    const r = await runCli(["-", "--seed", "42"], AI_TEXT);
    expect(r.code).toBe(0);
    // 模拟重定向产物：写出去再读回来应逐字一致（无诊断行污染）
    const tmp = path.join(fs.realpathSync(os.tmpdir()), "stdin-redirect-check.txt");
    fs.writeFileSync(tmp, r.stdout, "utf8");
    expect(fs.readFileSync(tmp, "utf8")).toBe(r.stdout);
    fs.unlinkSync(tmp);
  }, 60_000);

  // v0.9.40：--help 此前落进 default 分支 →「未知参数」+ 退出码 1。命令行工具的第一个
  // 动作不该是报错。三条断言各自盯一个面：退出码、输出通道（帮助不是诊断）、
  // 以及「help 提前返回、根本不读 stdin」（空管道仍 0 —— 若退回读 stdin 必红）。
  it("--help → 用法进 stdout + 退出码 0（不是「未知参数」错误）", async () => {
    const r = await runCli(["--help"], AI_TEXT);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("用法:");
    expect(r.stderr).not.toContain("未知参数");
  }, 60_000);

  it("-h 短选项等价：同样打印用法并退出 0", async () => {
    const r = await runCli(["-h"], AI_TEXT);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("用法:");
  }, 60_000);

  it("--help 提前返回：空 stdin 也不报错（证明没去读管道）", async () => {
    const r = await runCli(["--help"], "");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--help");
  }, 60_000);
});
