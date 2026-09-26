/**
 * CLI 的 .docx 端到端（v0.9.17）：**真起一次 CLI 进程**，不做 mock 自证。
 *
 * 为什么要真起进程：CLI 的接线层（收集文件 → 读 .docx → 去味 → 按格式落盘）
 * 此前完全没被测过，而它恰恰是「批量」这个卖点的入口。纯函数测试只能证明
 * `collectInputFiles` 认识 .docx，证明不了「跑一遍真能出一份能打开的 .docx」。
 * 所以这里用 `spawnSync(process.execPath, [tsx, cli, ...])` 跑真 CLI，
 * 再用 `readDocxText` 把产物读回来做 round-trip 断言。
 *
 * 断言的稳法：去味引擎会换词，所以不逐字比对改写结果，只钉三件事——
 *  ① 输入是 .docx 时输出**也是** .docx（默认跟随）；
 *  ② 产物能被 OOXML 解析回来且非空（说明落盘的是合法 docx，不是空壳）；
 *  ③ 英文专名 `QuAiWei` 穿过整条链路还在（证明内容真的从输入读进来了）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "node:child_process";
import { readDocxText, writeDocxText } from "../src/docx-io";

const CLI = path.resolve(__dirname, "humanize-cli.ts");
const TSX = path.resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");

function runCli(args: string[]) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    encoding: "utf8",
    timeout: 120000,
  });
  return { code: r.status ?? -1, log: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 用引擎自己的 docx 导出器造输入（自产自销，不依赖外部样本文件） */
async function makeDocx(file: string, text: string): Promise<void> {
  const blob = await writeDocxText(text);
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
}

/** Buffer → 独立 ArrayBuffer（Buffer 可能建在共享内存池上，直接取 .buffer 会串） */
function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const SAMPLE =
  "值得注意的是，QuAiWei 在这一环节实现了显著提升，为后续工作夯实了根基。\n\n" +
  "综上所述，该方案具备广泛的应用前景，能够有效推动相关业务稳步向前。";

describe("CLI 的 .docx 输入（真起进程）", () => {
  let tmp = "";
  let inDir = "";
  let outDir = "";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quaiwei-cli-docx-"));
    inDir = path.join(tmp, "in");
    outDir = path.join(tmp, "out");
    fs.mkdirSync(inDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("tsx 入口存在（否则下面的用例会静默变成「CLI 没跑」的假绿）", () => {
    expect(fs.existsSync(TSX)).toBe(true);
    expect(fs.existsSync(CLI)).toBe(true);
  });

  it(".docx 进 → .docx 出，产物能被解析回来且内容非空", async () => {
    await makeDocx(path.join(inDir, "doc.docx"), SAMPLE);
    const r = runCli([inDir, "--out", outDir]);
    expect(r.code, r.log).toBe(0);

    const dest = path.join(outDir, "doc.humanized.docx");
    expect(fs.existsSync(dest), r.log).toBe(true);

    const back = await readDocxText(toArrayBuffer(fs.readFileSync(dest)));
    expect(back.trim().length).toBeGreaterThan(10);
    // 英文专名穿过整条链路：证明内容确实是从输入 docx 读进来、而不是空跑
    expect(back).toContain("QuAiWei");
  });

  it(".txt 仍然输出 .txt（既有行为不被这次接线改坏）", () => {
    fs.writeFileSync(path.join(inDir, "plain.txt"), SAMPLE);
    const r = runCli([inDir, "--out", outDir]);
    expect(r.code, r.log).toBe(0);
    const dest = path.join(outDir, "plain.humanized.txt");
    expect(fs.existsSync(dest), r.log).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain("QuAiWei");
  });

  it("--out-format txt：.docx 输入也落成 .txt", async () => {
    await makeDocx(path.join(inDir, "doc.docx"), SAMPLE);
    const r = runCli([inDir, "--out", outDir, "--out-format", "txt"]);
    expect(r.code, r.log).toBe(0);
    expect(fs.existsSync(path.join(outDir, "doc.humanized.txt")), r.log).toBe(true);
    expect(fs.existsSync(path.join(outDir, "doc.humanized.docx"))).toBe(false);
  });

  it("--out-format 给非法值：退出 1 并提示可选项（不静默当成 follow）", async () => {
    await makeDocx(path.join(inDir, "doc.docx"), SAMPLE);
    const r = runCli([inDir, "--out", outDir, "--out-format", "pdf"]);
    expect(r.code).toBe(1);
    expect(r.log).toContain("--out-format");
  });

  it("坏 docx（不是 zip）：报出真实原因，不静默跳过", () => {
    fs.writeFileSync(path.join(inDir, "broken.docx"), "这不是一个 docx");
    const r = runCli([inDir, "--out", outDir]);
    expect(r.code).toBe(1);
    expect(r.log).toMatch(/docx|zip|EOCD/i);
  });
});
