import { describe, it, expect } from "vitest";
import { humanize } from "./humanize";
import {
  isProtectedTerm,
  setProtectedTerms,
  clearProtectedTerms,
  builtinProtectedTerms,
} from "./term-protect";

describe("term-protect（v0.8.6 术语保护）", () => {
  it("内置术语在去味后原样保留", () => {
    const t =
      "机器学习正在深刻改变行业，这一转变具有重要意义，与此同时带来了挑战，因此我们需要积极拥抱变化。综上所述，深度学习与神经网络是核心支撑。";
    for (const seed of [0, 1, 2, 3, 4]) {
      const out = humanize(t, { intensity: 0.9, seed, zhuqueMode: true });
      expect(out).toContain("机器学习");
      expect(out).toContain("深度学习");
      expect(out).toContain("神经网络");
    }
  });

  it("isProtectedTerm 基本判定", () => {
    const text = "我们研究机器学习的应用。";
    const idx = text.indexOf("机器学习");
    expect(isProtectedTerm(text, idx, idx + 4)).toBe(true);
    // 非术语不保护
    expect(isProtectedTerm(text, 0, 2)).toBe(false);
  });

  it("用户自定义术语可注入并受保护", () => {
    setProtectedTerms(["量子跃迁式改革", "张三丰算法"]);
    const t = "张三丰算法值得一提，量子跃迁式改革综上所述很重要。";
    for (const seed of [0, 1, 2]) {
      const out = humanize(t, { intensity: 0.9, seed });
      expect(out).toContain("张三丰算法");
      expect(out).toContain("量子跃迁式改革");
    }
    clearProtectedTerms();
  });

  it("内置保护词列表非空且含跨学科词", () => {
    const list = builtinProtectedTerms();
    expect(list.length).toBeGreaterThan(40);
    expect(list).toContain("善意取得");
    expect(list).toContain("机器学习");
  });
});
