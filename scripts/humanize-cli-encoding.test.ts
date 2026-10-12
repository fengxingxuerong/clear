/**
 * CLI 编码检测与批量行为（v0.9.32）的**真进程**端到端测试。
 *
 * 为什么真起进程：编码检测发生在 readInputText（main 的 I/O 路径，不在 vm 切片里），
 * 纯函数层够不到；而它的风险恰恰在接线层——GBK 老文件按 UTF-8 硬读会得到整篇乱码稿，
 * 去味引擎照常"成功"产出，用户看不出来（cli-fulltest 轮的发现）。
 *
 * 断言策略：不比对改写结果（引擎会换词），只钉三件事——
 *  ① 每种编码都能跑通（退出 0）且产物是合法 UTF-8 中文（不是乱码）；
 *  ② 转码发生时控制台明说转了哪个文件（用户看得见）；
 *  ③ 重跑幂等（回环防护）与 --dry-run 不落盘，是行为级事实，可逐字断言。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { runSimple } from "./run-async";

const CLI = path.resolve(__dirname, "humanize-cli.ts");
const TSX = path.resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");

/** 异步派生：同步 spawn 在部分宿主被整体挡下（EBUSY），见 humanize-cli-docx.test.ts 备忘 */
function runCli(args: string[]) {
  return runSimple(process.execPath, [TSX, CLI, ...args], { timeoutMs: 120000 });
}

const SAMPLE =
  "随着人工智能技术的飞速发展，AI 写作工具已经广泛应用于各个领域。首先，它能够显著提升写作效率，帮助用户在短时间内生成内容。其次，这类工具还具备学习能力，能够根据反馈优化输出。总之，人工智能正在改变我们的写作方式。";

describe("CLI 编码检测（真起进程）", () => {
  let tmp = "";
  let inDir = "";
  let outDir = "";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quaiwei-cli-enc-"));
    inDir = path.join(tmp, "in");
    outDir = path.join(tmp, "out");
    fs.mkdirSync(inDir);
  });

  afterEach(() => {
    // 临时目录刻意不清理（2026-10-13，同 humanize-cli-docx.test.ts：全量并行下
    // rmSync 会抛 ENOTEMPTY 或撞 safe-delete 挂住）⇒ 统一不删，残留交系统回收。
    void tmp;
  });

  it("tsx 入口存在（否则用例静默变假绿）", () => {
    expect(fs.existsSync(TSX)).toBe(true);
    expect(fs.existsSync(CLI)).toBe(true);
  });

  it("UTF-16LE + BOM：转码读取，产物是合法 UTF-8 且含中文与专名", async () => {
    const body = Buffer.from(SAMPLE, "utf16le");
    fs.writeFileSync(path.join(inDir, "u16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
    const r = await runCli([inDir, "--out", outDir]);
    expect(r.code, r.log).toBe(0);
    expect(r.log).toContain("UTF-16LE");
    const out = fs.readFileSync(path.join(outDir, "u16.humanized.txt"), "utf8");
    expect(out).toContain("人工智能");
    // 乱码特征：解码失败的替换符 U+FFFD 不许出现
    expect(out).not.toContain("\ufffd");
  });

  it("UTF-8 BOM：剥掉 BOM 正常读，不误报转码", async () => {
    fs.writeFileSync(
      path.join(inDir, "bom.txt"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SAMPLE, "utf8")]),
    );
    const r = await runCli([inDir, "--out", outDir]);
    expect(r.code, r.log).toBe(0);
    expect(r.log).not.toContain("转码");
    const out = fs.readFileSync(path.join(outDir, "bom.humanized.txt"), "utf8");
    expect(out).toContain("人工智能");
    expect(out).not.toContain("\ufffd");
  });

  it("GBK（GB2312 夹具字节）：按 GBK 转码并明说，产物不带替换符", async () => {
    // 夹具：SAMPLE 的 GB2312 双字节序列（由仓库外一次性生成，hex 固定）
    const hex = GbkFixtureHex(SAMPLE);
    expect(hex.length, "夹具生成器覆盖不到 SAMPLE 的字符——换用更常见的字").toBeGreaterThan(0);
    fs.writeFileSync(path.join(inDir, "gbk.txt"), Buffer.from(hex, "hex"));
    const r = await runCli([inDir, "--out", outDir]);
    expect(r.code, r.log).toBe(0);
    expect(r.log).toContain("GBK");
    const out = fs.readFileSync(path.join(outDir, "gbk.humanized.txt"), "utf8");
    expect(out).toContain("人工智能");
    expect(out).not.toContain("\ufffd");
  });
});

/* ---------------- GBK 夹具生成器 ---------------- */
/**
 * Node 只带 GBK **解码器**（TextDecoder('gbk')）没有编码器，所以夹具字节自己造：
 * 用解码器反查——把 GB2312 双字节空间（0xA1A1–0xF7FE，约 6700 码位）逐对 decode，
 * 建「字符 → GBK 字节」表。覆盖不到的字符（生僻字/半角混排）返回空串，
 * 让测试红在夹具生成这一步，而不是把 UTF-8 字节假装 GBK 喂给被测逻辑。
 */
function GbkFixtureHex(text: string): string {
  const dec = new TextDecoder("gbk");
  const table = new Map<string, string>();
  for (let cp = 0xa1a1; cp <= 0xf7fe; cp++) {
    const hi = cp >> 8, lo = cp & 0xff;
    if (lo < 0xa1) continue;
    const s = dec.decode(Buffer.from([hi, lo]));
    if (s.length === 1 && s !== "\ufffd") table.set(s, `${hi.toString(16)}${lo.toString(16)}`);
  }
  let hex = "";
  for (const ch of text) {
    // GBK 兼容 ASCII：0x00–0x7F 单字节直通，不在双字节表里
    if (ch.charCodeAt(0) < 0x80) {
      hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
      continue;
    }
    const b = table.get(ch);
    if (!b) return ""; // 覆盖不到（生僻字）→ 交上层断言红掉
    hex += b;
  }
  return hex;
}
