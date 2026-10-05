/**
 * verify-quality 门禁自校验：门禁自身失效时 vitest 亮红，
 * 而不是让所有"通过"信号静默失真。核心逻辑由 verify-quality.ts
 * 的 runQualityChecks / scanOutput 导出，这里直接断言。
 *
 * CLI 入口（verify-quality.ts 的模块顶层）另用两条路覆盖：
 *  ① 真起一次 tsx 进程，钉住通过路径的真实退出码与输出文案；
 *  ② 注入 mock humanize 让强度 1.0 必然泄漏，触发 process.exit(1)
 *     失败分支——否则「省略号残留/黑话泄漏 → 退出 1」这段永远不执行，
 *     门禁最关键的"会拦人"能力没有任何测试背书。
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runQualityChecks, scanOutput, LEAK_WORDS } from "../scripts/verify-quality";
import { scanVocabGrammar, UNGRAMMATICAL_AS_VERB } from "../scripts/verify-quality";
import { humanize } from "../src/engine/humanize";

describe("质量门禁自校验（verify-quality.ts 核心逻辑）", () => {
  it("强度 1.0：25 种子零黑话泄漏、零字面省略号", () => {
    const r = runQualityChecks();
    expect(r.hardLeak).toBe(0);
    expect(r.hardEllipsis).toBe(false);
  });

  it("scanOutput：能抓到注入的已知泄漏样文（防'门禁永远绿'的假阳性）", () => {
    // 故意构造含泄漏词与省略号的文本，门禁必须报出来
    const bad = "我们要赋能业务，构建生态闭环，在……背景下稳步推进。";
    const s = scanOutput(bad);
    expect(s.ellipsis).toBe(true);
    expect(s.leak).toBeGreaterThanOrEqual(3);
    // 干净文本零命中
    const good = "这件事说起来简单，做起来要一步一步来，急不得。";
    const s2 = scanOutput(good);
    expect(s2.ellipsis).toBe(false);
    expect(s2.leak).toBe(0);
  });

  it("词表卫生：LEAK_WORDS 非空且每项可被 scanOutput 检出", () => {
    expect(LEAK_WORDS.length).toBeGreaterThanOrEqual(10);
    for (const w of LEAK_WORDS) {
      // 单词注入必须被检出——防止词表条目与实现脱节（如多了空格/变体）
      expect(scanOutput(`我们${w}一下。`).leak).toBe(1);
    }
  });

  it("强度 1.0 输出必须发生实质改写（防引擎整体空转）", () => {
    const src =
      "值得注意的是，基于大数据，技术赋能传统产业已成为趋势。诸如电商、物流等赛道，我们要构建生态闭环。";
    const out = humanize(src, { intensity: 1.0, seed: 0 });
    expect(out).not.toBe(src);
  });
});

/* ─────────── 词表配对卫生扫描（2026-10-05） ───────────
 *
 * 这层检查的价值在于防"下次再犯"：它不看具体词条，而是对整张 VOCAB
 * 做实跑判定。2026-10-05 一次就抓出 3 组崩坏的替换（统筹→一盘棋、
 * 全方位→通盘、系统性→成体系），而这三条在门禁存在期间从未被发现。
 *
 * 所以下面必须有**反向断言**：把坏替身注入回去，扫描必须报出来。
 * 没有这一条，"扫描恒返回空数组"与"词表已修干净"就长得一模一样。
 */
describe("词表配对卫生：接宾语即崩的替换必须被抓出", () => {
  it("当前词表扫描为零", () => {
    expect(scanVocabGrammar()).toEqual([]);
  });

  it("反向断言：注入已修复的坏替身后扫描必须报出（防门禁永远绿）", () => {
    // 用真实存在过的三条历史缺陷做夹具——它们都曾真实存在于词表中
    for (const bad of ["一盘棋", "通盘", "成体系"]) {
      expect(UNGRAMMATICAL_AS_VERB, `夹具 ${bad} 必须在检测名单里`).toContain(bad);
    }
    // 正面构造一个必然崩的输出，确认判定函数本身不是恒返回 null
    const broken = "我们需要一盘棋好效率与深度的关系。";
    expect(UNGRAMMATICAL_AS_VERB.some((b) => new RegExp(b + "好").test(broken))).toBe(true);
  });

  it("判定不会误伤正常输出（宁可漏过也不误报）", () => {
    // 「统一安排好效率」是合法的动词替身，必须放行
    const ok = "我们需要统一安排好效率与深度的关系。";
    expect(UNGRAMMATICAL_AS_VERB.some((b) => new RegExp(b + "好").test(ok))).toBe(false);
    // 整句没被替换时也算合法
    const untouched = "我们需要统筹好效率与深度的关系。";
    expect(UNGRAMMATICAL_AS_VERB.some((b) => new RegExp(b + "好").test(untouched))).toBe(false);
  });
});

/* --------------------------- CLI 入口（真起进程） --------------------------- */

const CLI = path.resolve(__dirname, "verify-quality.ts");
const TSX = path.resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");

/** 真跑一次门禁脚本：返回退出码与合并输出（stdout+stderr） */
function runGate() {
  const r = spawnSync(process.execPath, [TSX, CLI], { encoding: "utf8", timeout: 120000 });
  return { code: r.status ?? -1, log: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("质量门禁 CLI 入口（verify-quality.ts 顶层）", () => {
  it("通过路径：真起进程退出码 0，且打印零泄漏/零省略号的通过文案", () => {
    // 入口不存在时下面的 spawn 会退 1，这里先说清是「没跑」而不是「没过」
    expect(fs.existsSync(TSX), "tsx CLI 缺失").toBe(true);
    expect(fs.existsSync(CLI), "门禁脚本缺失").toBe(true);

    const r = runGate();
    expect(r.code, r.log).toBe(0);
    expect(r.log).toContain("[强度1.0] 含字面省略号(……): ✅ 无");
    expect(r.log).toContain("[强度1.0] 黑话本体泄漏: ✅ 0（无效替身已清除）");
    expect(r.log).toMatch(/\[强度0\.7\] 黑话保留 \d+ 次（按设计/);
    expect(r.log).toContain("[词表卫生] 接宾语即崩的替换: ✅ 0");
    expect(r.log).toContain("✅ 质量校验通过（强度1.0 零泄漏、零省略号、词表配对全通）");
    expect(r.log).not.toContain("质量校验失败");
  });

  it("失败分支：强度 1.0 有泄漏/省略号 → 退出码 1 并报出失败原因", async () => {
    // 注入必然泄漏且带字面省略号的替身输出，逼出门禁的拦截路径
    const LEAKY = "在……背景下，我们要赋能业务、构建生态闭环。";
    const expectedLeak = 25 * scanOutput(LEAKY).leak;
    expect(scanOutput(LEAKY).ellipsis, "注入样文须含省略号").toBe(true);
    expect(expectedLeak, "注入样文须含黑话").toBeGreaterThan(0);

    const exitSpy = vi.spyOn(process, "exit");
    exitSpy.mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as unknown as typeof process.exit);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // 只影响接下来的这次动态导入：静态导入的真实引擎不受污染
    vi.resetModules();
    vi.doMock("../src/engine/humanize", () => ({ humanize: () => LEAKY }));

    let caught: unknown = null;
    // mockRestore 会清掉调用记录，先取证到常量对象里再还原
    const captured: { exit: unknown[][]; err: unknown[][]; log: unknown[][] } = {
      exit: [],
      err: [],
      log: [],
    };
    try {
      await import("../scripts/verify-quality");
    } catch (e) {
      caught = e;
    } finally {
      captured.exit.push(...exitSpy.mock.calls);
      captured.err.push(...errSpy.mock.calls);
      captured.log.push(...logSpy.mock.calls);
      vi.doUnmock("../src/engine/humanize");
      vi.resetModules();
      exitSpy.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
    }

    // 若 mock 未命中（真实引擎跑出零泄漏），下面每一条都会红——不会假绿
    expect(caught, "门禁必须以 process.exit 终止").toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("EXIT:1");
    expect(captured.exit).toEqual([[1]]);
    expect(captured.err.length).toBe(1);
    expect(String(captured.err[0][0])).toContain(
      `❌ 质量校验失败：省略号残留=true，黑话泄漏=${expectedLeak} 次`,
    );
    expect(captured.log).toContainEqual(["[强度1.0] 含字面省略号(……):", "❌ 有"]);
    expect(captured.log).toContainEqual(["[强度1.0] 黑话本体泄漏:", `❌ ${expectedLeak}`]);
    // 失败时绝不能打印通过文案——否则"红"会被刷成"绿"
    expect(captured.log.some((c) => String(c[0]).includes("质量校验通过"))).toBe(false);
  });
});
