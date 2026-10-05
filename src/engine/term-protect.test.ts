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

/* 2026-10-05 分支补测：此前 term-protect.ts 分支 83.3%（3 个分支未覆盖）
   —— 行 88 的长度门槛、行 107 与 114 的「词边界延伸」两侧。 */
describe("term-protect：词边界延伸与长度门槛", () => {
  /** 选一个 ≥3 字、且其前 2 字不与其它内置词重叠的词，避免别的词先命中导致断言错位 */
  function pickLongTerm(): string {
    const list = builtinProtectedTerms();
    const t = list.find(
      (w) => w.length >= 3 && list.filter((o) => o !== w && o.includes(w.slice(0, 2))).length === 0,
    );
    expect(t, "词表里应存在这样的术语").toBeTruthy();
    return t as string;
  }

  it("切片是内置术语的子串、且上下文能拼回完整术语 → 保护（行 107 真支）", () => {
    const term = pickLongTerm();
    const text = `${term}模型`;
    expect(isProtectedTerm(text, 0, 2)).toBe(true); // seg = 该词前 2 字，是其真子串
  });

  it("同样是子串、但前后文拼不出完整术语 → 不保护（避免过度拦截）", () => {
    const seg = pickLongTerm().slice(0, 2);
    const text = `${seg}无关填充内容`; // 后续字不会恰好拼成术语
    expect(isProtectedTerm(text, 0, 2)).toBe(false);
  });

  it("用户自定义术语同样有词边界延伸（行 114 真支）", () => {
    const user = "北冥神功心法";
    const seg = user.slice(0, 2);
    // 前置条件：该子串不在内置词表里，保证真正走的是 userTerms 那一圈
    expect(builtinProtectedTerms().some((t) => t.includes(seg))).toBe(false);
    setProtectedTerms([user]);
    expect(isProtectedTerm(`${user}详解`, 0, 2)).toBe(true);
    clearProtectedTerms();
  });

  it("长度门槛：1 字术语被忽略、≥2 字才注册（行 88 的两侧）", () => {
    setProtectedTerms(["喵", "喵呜"]);
    // 关键断言：单独问「喵」必须是 false——若 k.length >= 2 那道门槛不存在，
    // 「喵」会被注册，line 100 的 userTerms.has(seg) 就会直接返回 true。
    // （注意不能写成 "喵呜…" 的 0..1：那会走 line 114 的词边界延伸返回 true，
    //   测的就不是长度门槛了。）
    expect(isProtectedTerm("喵", 0, 1)).toBe(false);
    // 对照组：同一次注入里 2 字的「喵呜」确实注册成功
    expect(isProtectedTerm("喵呜", 0, 2)).toBe(true);
    clearProtectedTerms();
  });
});
