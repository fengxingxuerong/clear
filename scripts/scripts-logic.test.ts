/**
 * scripts 渐进测试（P3 收尾）：humanize-cli 纯逻辑 + check-vocab-hygiene 词表卫生。
 * CLI 的 parseArgs/collectTxtFiles 不依赖终端 I/O，直接导入测试；
 * 词表卫生用断言固化（原脚本以 exit code 表达，这里改成可读断言）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import vm from "vm";
import { VOCAB } from "../src/engine/humanize-vocab";
import { FORMULAIC_EXTRA } from "../src/engine/humanize-vocab-extra";

/* ---------------- 词表卫生（check-vocab-hygiene.ts 的核心规则固化） ---------------- */

describe("词表卫生（check-vocab-hygiene 规则固化）", () => {
  // 与 check-vocab-hygiene.ts 保持一致的黑名单（KILLER_INTRO + OFFICIALESE + FORMULAIC_EXTRA）
  const KILLER_INTRO = [
    "值得注意的是", "值得一提的是", "毋庸置疑", "毋庸讳言", "不可否认", "众所周知",
    "归根结底", "归根到底", "综上所述", "总而言之", "总的说来", "总的来说",
    "简而言之", "一言以蔽之", "由此可见",
  ];
  const OFFICIALESE = [
    "总体设计", "按图推进", "长期坚持", "夯实根基", "守牢防线", "加深优势", "盘活资产",
    "填平缺口", "拉长长板", "做亮招牌", "排忧解难", "拓宽路子", "架起平台", "顶层规划", "凑成共识",
  ];
  const FORBIDDEN = new Set([...KILLER_INTRO, ...OFFICIALESE, ...FORMULAIC_EXTRA]);

  it("VOCAB 所有替身不得落入高危套话/官方腔黑名单（自 defeats 防复发守卫）", () => {
    const offenders: string[] = [];
    for (const [from, tos] of Object.entries(VOCAB)) {
      for (const to of tos) {
        if (FORBIDDEN.has(to)) offenders.push(`${from} → "${to}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("黑名单本身非空（防止守卫被悄悄清空）", () => {
    expect(FORBIDDEN.size).toBeGreaterThanOrEqual(25);
  });
});

/* ---------------- humanize-cli 纯逻辑 ---------------- */

// humanize-cli.ts 顶层会执行 main()（依赖 argv），vitest 导入会触发 process.exit。
// 因此不直接 import：用 esbuild 把纯函数段落（parseArgs/collectTxtFiles）转译成 JS 后在沙箱执行，
// 渐进测试不改动 CLI 行为。
import { readFileSync } from "fs";
import { transformSync } from "esbuild";

/** parseArgs 的返回形状（只列断言用到的字段，够用即可） */
interface CliArgs {
  input: string;
  out: string;
  intensity: number;
  zhuque: boolean;
  style: string;
  suffix: string;
  seed: number;
  api: boolean;
  model: string;
  judgeModel: string;
  deep: boolean;
  contest: number;
}

function loadCliFns(): {
  parseArgs: (argv: string[]) => CliArgs;
  collectTxtFiles: (input: string) => string[];
} {
  const src = readFileSync(path.resolve(__dirname, "humanize-cli.ts"), "utf-8");
  // 只保留纯函数段：USAGE + parseArgs + buildApiConfig + collectTxtFiles
  // （main 依赖终端 I/O，interface 是 TS 类型）
  //
  // 起点必须包含 USAGE：v0.9.15 起 parseArgs 引用了这个模块级常量，只从
  // "function parseArgs" 切会让它在沙箱里变成未定义标识符。
  const start = src.indexOf("const USAGE");
  // 终点按正则匹配「行首的 async function main / function main」：
  // 直接 indexOf("function main") 会把 `async` 留在切片尾部，转译后成为裸标识符
  // → ReferenceError: async is not defined（v0.9.15 把 main 改成 async 时踩到）。
  const m = /(?:async\s+)?function main/.exec(src);
  const end = m ? m.index : src.length;
  const body = src.slice(start, end).replace(/^import .*$/gm, "");
  const js = transformSync(body, { loader: "ts", format: "cjs" }).code;
  const sandbox: { fs: typeof fs; path: typeof path; module: { exports: Record<string, unknown> } } = {
    fs,
    path,
    module: { exports: {} },
  };
  vm.runInNewContext(`${js}\n;module.exports = { parseArgs, collectTxtFiles };`, sandbox);
  return sandbox.module.exports as { parseArgs: never; collectTxtFiles: never };
}

const { parseArgs, collectTxtFiles } = loadCliFns();

describe("humanize-cli parseArgs", () => {
  const base = (argv: string[]) => ["node", "humanize-cli.ts", ...argv];

  it("最简参数：只给输入路径，其余默认值正确", () => {
    const a = parseArgs(base(["./docs"]));
    expect(a.input).toBe("./docs");
    expect(a.out).toBe("./docs");
    expect(a.intensity).toBe(0.9);
    expect(a.zhuque).toBe(false);
    expect(a.style).toBe("casual");
    expect(a.suffix).toBe(".humanized");
  });

  it(".txt 输入时 out 默认为其所在目录", () => {
    const a = parseArgs(base(["./docs/a.txt"]));
    expect(a.out).toBe("./docs");
  });

  it("全量参数解析：out/intensity/zhuque/style/suffix", () => {
    const a = parseArgs(base(["./in", "--out", "./out", "--intensity", "0.7", "--zhuque", "--style", "academic", "--suffix", ".h"]));
    expect(a.out).toBe("./out");
    expect(a.intensity).toBe(0.7);
    expect(a.zhuque).toBe(true);
    expect(a.style).toBe("academic");
    expect(a.suffix).toBe(".h");
  });

  it("强度越界夹取 0~1", () => {
    expect(parseArgs(base(["./in", "--intensity", "5"])).intensity).toBe(1);
    expect(parseArgs(base(["./in", "--intensity", "-1"])).intensity).toBe(0);
  });

  // v0.9.15：seed 此前硬编码 20260905 不可改，批量结果无法与 UI 对齐复现
  it("--seed 可指定，默认仍是 20260905（向后兼容）", () => {
    expect(parseArgs(base(["./in"])).seed).toBe(20260905);
    expect(parseArgs(base(["./in", "--seed", "42"])).seed).toBe(42);
  });

  // v0.9.15：LLM 通道接线
  it("--api 系列参数解析（默认关闭深度、单候选）", () => {
    const a = parseArgs(base(["./in"]));
    expect(a.api).toBe(false);
    expect(a.deep).toBe(true);
    expect(a.contest).toBe(1);
    const b = parseArgs(
      base(["./in", "--api", "--model", "m1", "--judge-model", "j1", "--no-deep", "--contest", "3"]),
    );
    expect(b.api).toBe(true);
    expect(b.model).toBe("m1");
    expect(b.judgeModel).toBe("j1");
    expect(b.deep).toBe(false);
    expect(b.contest).toBe(3);
  });
});

describe("humanize-cli collectTxtFiles", () => {
  let tmpDir = "";
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quaiwei-cli-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("单文件输入直接返回该文件", () => {
    const f = path.join(tmpDir, "a.txt");
    fs.writeFileSync(f, "内容");
    expect(collectTxtFiles(f)).toEqual([f]);
  });

  it("目录输入：只收 .txt（大小写不敏感），按名称排序，忽略子目录", () => {
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    fs.writeFileSync(path.join(tmpDir, "a.TXT"), "a");
    fs.writeFileSync(path.join(tmpDir, "c.md"), "非txt");
    fs.mkdirSync(path.join(tmpDir, "sub"));
    fs.writeFileSync(path.join(tmpDir, "sub", "d.txt"), "子目录不算");
    expect(collectTxtFiles(tmpDir)).toEqual([
      path.join(tmpDir, "a.TXT"),
      path.join(tmpDir, "b.txt"),
    ]);
  });
});
