/**
 * term-protect 切片拼接保护分支（v0.9.16 长尾清扫）：
 *  用户自定义术语的「前后文拼合」判定——切片是术语一部分且上下文能拼出
 *  完整术语时才保护（避免过度拦截），完整命中术语本身走此前已有分支。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { setProtectedTerms, clearProtectedTerms, isProtectedTerm } from "./term-protect";

// "我们研究量子计算的应用"：量4 子5 计6 算7
const TEXT = "我们研究量子计算的应用";

beforeEach(() => {
  clearProtectedTerms();
});

describe("isProtectedTerm（用户术语切片拼接保护）", () => {
  it("切片是用户术语前半、上下文能拼出完整术语 → 保护", () => {
    setProtectedTerms(["量子计算"]);
    expect(isProtectedTerm(TEXT, 4, 6)).toBe(true); // seg="量子"，前后文拼出"量子计算"
  });

  it("切片是用户术语后半、前文能拼出完整术语 → 保护", () => {
    setProtectedTerms(["量子计算"]);
    expect(isProtectedTerm(TEXT, 6, 8)).toBe(true); // seg="计算"，before 拼出"量子计算"
  });

  it("用户术语与切片上下文拼不合 → 不保护", () => {
    setProtectedTerms(["区块链"]);
    expect(isProtectedTerm(TEXT, 4, 6)).toBe(false);
  });

  it("用户术语恰好等于切片本身：exact 命中直接保护（101 行分支）", () => {
    setProtectedTerms(["量子"]);
    // 完整命中走 userTerms.has(seg) 的 exact 分支，不走拼接分支——锁现状
    expect(isProtectedTerm(TEXT, 4, 6)).toBe(true);
  });

  it("clearProtectedTerms 后用户术语保护失效", () => {
    setProtectedTerms(["量子计算"]);
    expect(isProtectedTerm(TEXT, 4, 6)).toBe(true);
    clearProtectedTerms();
    expect(isProtectedTerm(TEXT, 4, 6)).toBe(false);
  });
});
