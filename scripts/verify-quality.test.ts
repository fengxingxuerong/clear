/**
 * verify-quality 门禁自校验：门禁自身失效时 vitest 亮红，
 * 而不是让所有"通过"信号静默失真。核心逻辑由 verify-quality.ts
 * 的 runQualityChecks / scanOutput 导出，这里直接断言。
 */
import { describe, it, expect } from "vitest";
import { runQualityChecks, scanOutput, LEAK_WORDS } from "../scripts/verify-quality";
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
