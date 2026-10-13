/**
 * CLI 入口测试（scripts/cli.test.ts）
 *
 * 覆盖两层：
 *  1. parseArgs 纯函数：全部选项、全部错误路径（退出码 2 的来源）
 *  2. run 主流程：注入内存 IO 跑端到端（不起子进程——本环境同步 spawn EBUSY，
 *     e2e spawn 路线不可用；bundle 产物的可执行性由手动 node dist-cli/cli.mjs 验证）
 *
 * 关键断言：**--seed 可复现**。同一 argv 跑两次输出逐字相同 ——
 * 这同时是「seed 真的传进了引擎」的敏感断言（丢掉 seed 引擎随机化，本测试即红）。
 */
import { describe, it, expect } from "vitest";
import { parseArgs, run, UsageError, type CliIo } from "./cli.ts";

/** 内存 IO：out/err 收集为数组，文件系统用 Map 模拟，stdin 可注入 */
function memIo(inject: { stdin?: string; files?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>(Object.entries(inject.files ?? {}));
  const io: CliIo = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    stdin: () => inject.stdin ?? "",
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p, s) => {
      files.set(p, s);
    },
  };
  return { io, out, err, files };
}

/** 典型 AI 腔文本：引擎处理前后 aiScore 差异明显，适合断言 --score 输出 */
const AI_TEXT =
  "本文首先阐述了人工智能技术的发展现状，其次分析了其在各行各业中的广泛应用。综上所述，人工智能技术具有广阔的发展前景，值得我们高度重视。需要注意的是，我们应当充分利用这一重要机遇，积极推进相关工作的落实。";

describe("parseArgs", () => {
  it("默认值：strength=0.6 / genre=auto / style=casual / 无 seed", () => {
    const opts = parseArgs([]);
    expect(opts.strength).toBe(0.6);
    expect(opts.genre).toBe("auto");
    expect(opts.style).toBe("casual");
    expect(opts.seed).toBeUndefined();
    expect(opts.zhuque).toBe(false);
    expect(opts.score).toBe(false);
    expect(opts.bestof).toBeUndefined();
    expect(opts.text).toBeUndefined();
    expect(opts.file).toBeUndefined();
    expect(opts.out).toBeUndefined();
  });

  it("短选项与长选项等价：-t/-s/-g/-o", () => {
    const a = parseArgs(["-t", "文本甲", "-s", "0.8", "-g", "dialogue", "-o", "x.txt"]);
    const b = parseArgs(["--text", "文本甲", "--strength", "0.8", "--genre", "dialogue", "--out", "x.txt"]);
    expect(a).toEqual(b);
    expect(a.text).toBe("文本甲");
    expect(a.strength).toBe(0.8);
    expect(a.genre).toBe("dialogue");
    expect(a.out).toBe("x.txt");
  });

  it("--seed 只接受非负整数", () => {
    expect(parseArgs(["--seed", "42"]).seed).toBe(42);
    expect(parseArgs(["--seed", "0"]).seed).toBe(0);
    expect(() => parseArgs(["--seed", "-1"])).toThrow(UsageError);
    expect(() => parseArgs(["--seed", "1.5"])).toThrow(UsageError);
    expect(() => parseArgs(["--seed", "abc"])).toThrow(UsageError);
  });

  it("--strength 越界拒绝", () => {
    expect(() => parseArgs(["-s", "1.5"])).toThrow(UsageError);
    expect(() => parseArgs(["-s", "-0.1"])).toThrow(UsageError);
    expect(() => parseArgs(["-s", "abc"])).toThrow(UsageError);
  });

  it("--bestof 数字值消费、非数字不消费", () => {
    expect(parseArgs(["--bestof", "8"]).bestof).toBe(8);
    // 不跟数字 → 0（自动候选数）
    expect(parseArgs(["--bestof"]).bestof).toBe(0);
    expect(parseArgs(["--bestof", "-t", "x"]).bestof).toBe(0);
    expect(parseArgs(["--bestof", "-t", "x"]).text).toBe("x");
    expect(() => parseArgs(["--bestof", "0"])).toThrow(UsageError);
    expect(() => parseArgs(["--bestof", "31"])).toThrow(UsageError);
  });

  it("--genre / --style 合法值校验", () => {
    for (const g of ["auto", "main", "narrative", "dialogue", "humanHand"]) {
      expect(parseArgs(["-g", g]).genre).toBe(g);
    }
    expect(() => parseArgs(["-g", "poetry"])).toThrow(UsageError);
    for (const s of ["casual", "plain", "academic"]) {
      expect(parseArgs(["--style", s]).style).toBe(s);
    }
    expect(() => parseArgs(["--style", "vulgar"])).toThrow(UsageError);
  });

  it("位置参数：单个文件；第二个文件报错", () => {
    expect(parseArgs(["a.txt"]).file).toBe("a.txt");
    expect(() => parseArgs(["a.txt", "b.txt"])).toThrow(UsageError);
  });

  it("-t 与文件参数互斥", () => {
    expect(() => parseArgs(["-t", "x", "a.txt"])).toThrow(UsageError);
  });

  it("未知选项与缺值报错", () => {
    expect(() => parseArgs(["--nope"])).toThrow(UsageError);
    expect(() => parseArgs(["-t"])).toThrow(UsageError);
    expect(() => parseArgs(["-s"])).toThrow(UsageError);
    expect(() => parseArgs(["-o"])).toThrow(UsageError);
  });

  it("--help / --version 以特殊 UsageError 透传（run 里转退出码 0）", () => {
    expect(() => parseArgs(["--help"])).toThrow("__help__");
    expect(() => parseArgs(["-h"])).toThrow("__help__");
    expect(() => parseArgs(["--version"])).toThrow("__version__");
    expect(() => parseArgs(["-v"])).toThrow("__version__");
  });

  it("--zhuque / --score 开关", () => {
    expect(parseArgs(["--zhuque"]).zhuque).toBe(true);
    expect(parseArgs(["--score"]).score).toBe(true);
  });
});

describe("run", () => {
  it("-t 输入 → stdout 输出；退出码 0", async () => {
    const m = memIo();
    const code = await run(["-t", AI_TEXT, "--seed", "7"], m.io);
    expect(code).toBe(0);
    expect(m.out.join("")).toContain("人工智能");
    expect(m.out.join("").length).toBeGreaterThan(50);
    expect(m.err).toEqual([]);
  });

  it("--seed 可复现：同一 argv 两次输出逐字相同", async () => {
    const a = memIo();
    const b = memIo();
    await run(["-t", AI_TEXT, "--seed", "7"], a.io);
    await run(["-t", AI_TEXT, "--seed", "7"], b.io);
    expect(a.out.join("")).toBe(b.out.join(""));
  });

  it("文件输入走 readFile；-o 走 writeFile 且不污染 stdout", async () => {
    const m = memIo({ files: { "in.txt": AI_TEXT } });
    const code = await run(["in.txt", "-o", "out.txt", "--seed", "1"], m.io);
    expect(code).toBe(0);
    expect(m.out).toEqual([]); // -o 模式 stdout 无正文
    expect(m.files.get("out.txt")?.length ?? 0).toBeGreaterThan(50);
    expect(m.err.join("")).toContain("out.txt");
  });

  it("stdin 管道输入（无 -t 无文件参数）", async () => {
    const m = memIo({ stdin: AI_TEXT });
    const code = await run(["--seed", "3"], m.io);
    expect(code).toBe(0);
    expect(m.out.join("").length).toBeGreaterThan(50);
  });

  it("输入为空 → 退出码 1（三种空源）", async () => {
    expect(await run([], memIo().io)).toBe(1);
    expect(await run(["-t", "   "], memIo().io)).toBe(1);
    expect(await run(["-t", "x"], memIo({ stdin: "" }).io)).toBe(0); // -t 非空不受 stdin 影响
  });

  it("读文件失败 → 退出码 1", async () => {
    const m = memIo(); // 无文件
    expect(await run(["nope.txt"], m.io)).toBe(1);
    expect(m.err.join("")).toContain("读输入失败");
  });

  it("--score 在 stderr 打前后对比，且 after 不高于 before+3（选优或常规都不该劣化太多）", async () => {
    const m = memIo();
    const code = await run(["-t", AI_TEXT, "--score", "--seed", "5"], m.io);
    expect(code).toBe(0);
    const line = m.err.join("");
    expect(line).toMatch(/\[score\] aiScore \d+ → \d+（[+-]?\d+，越低越不像 AI）/);
  });

  it("--bestof 走选优路径：exit 0 且 stderr 有 score 行（bestof 必算前后分）", async () => {
    const m = memIo();
    const code = await run(["-t", AI_TEXT, "--bestof", "--seed", "9"], m.io);
    expect(code).toBe(0);
    expect(m.out.join("").length).toBeGreaterThan(50);
    expect(m.err.join("")).toContain("[score] aiScore");
  });

  it("--bestof 候选数越界（解析层拒绝）→ 退出码 2", async () => {
    const m = memIo();
    expect(await run(["--bestof", "99"], m.io)).toBe(2);
  });

  it("用法错误 → 退出码 2 且 stderr 带用法文本", async () => {
    const m = memIo();
    expect(await run(["--nope"], m.io)).toBe(2);
    expect(m.err.join("")).toContain("用法：ai-humanizer");
  });

  it("--help / --version → 退出码 0，正文进 stdout", async () => {
    const h = memIo();
    expect(await run(["--help"], h.io)).toBe(0);
    expect(h.out.join("")).toContain("--strength");
    const v = memIo();
    expect(await run(["--version"], v.io)).toBe(0);
    expect(v.out.join("")).toMatch(/^ai-humanizer v\d+\.\d+\.\d+\n$/);
  });

  it("genre=humanHand + style=academic 组合可跑通", async () => {
    const m = memIo();
    const code = await run(["-t", AI_TEXT, "-g", "humanHand", "--style", "academic", "--seed", "2"], m.io);
    expect(code).toBe(0);
    expect(m.out.join("").length).toBeGreaterThan(50);
  });
});
