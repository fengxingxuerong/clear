import { describe, it, expect } from "vitest";
import { humanize } from "./humanize";
import { explainChanges, explainSummary, formatExplain, lookupVocab } from "./explain";

/**
 * 这些用例全部走**真引擎真输出**，不手搓改写对：
 * 手搓出来的 before/after 容易恰好符合反查逻辑的形状，测的是"我猜它会怎么改"，
 * 而不是"引擎真这么改时反查对不对"。seed 固定保证可复现。
 */
const SRC =
  "值得注意的是，在当今社会，人工智能技术的发展至关重要。事实上，它在一定程度上改变了我们的生活方式。综上所述，这一趋势具有十分重要的意义。";
const SEED = 20260905;

describe("explainChanges（真引擎输出上的归因）", () => {
  it("6 处改动全部归因出来，且都命中明确规则表（certain 全 true）", () => {
    const out = humanize(SRC, { intensity: 0.6, seed: SEED });
    const items = explainChanges(SRC, out);

    // 断言**具体改了什么**，不是只断言条数 —— 条数对但归因错了照样过，那是空转断言
    const pairs = items.map((i) => `${i.before}→${i.after}`).sort();
    expect(pairs).toEqual(
      [
        "值得注意的是→说起来",
        "在当今社会→如今",
        "在一定程度上→多少",
        "事实上→平心来说",
        "具有十分重要的意义→很重要",
        "综上所述→归结起来",
      ].sort(),
    );
    expect(items.every((i) => i.certain)).toBe(true);
  });

  it("套话归 cliche、词表归 vocab —— 长条目不被短条目抢走", () => {
    const out = humanize(SRC, { intensity: 0.6, seed: SEED });
    const items = explainChanges(SRC, out);
    const cliche = items.filter((i) => i.kind === "cliche");

    // 「具有十分重要的意义」在 MECH_CLICHE_REWRITE 里，若被词表的短词先命中就会归错类
    expect(cliche.map((i) => i.before)).toEqual(["具有十分重要的意义"]);
    expect(explainSummary(items)).toEqual({ vocab: 5, cliche: 1 });
  });

  it("每条的依据都要指到具体文件，不许含糊其辞", () => {
    const out = humanize(SRC, { intensity: 0.6, seed: SEED });
    for (const it of explainChanges(SRC, out)) {
      expect(it.basis).toMatch(/\.ts\b/);
      expect(it.reason.length).toBeGreaterThan(5);
    }
  });
});

describe("边界", () => {
  it("两稿一致 → 空清单（不是「没改动」这种含糊文案）", () => {
    expect(explainChanges("同一句话。", "同一句话。")).toEqual([]);
  });

  it("空串 / 不传 → 空清单，不抛", () => {
    expect(explainChanges("", "")).toEqual([]);
    expect(explainChanges("有内容。", "")).toEqual([]);
  });

  it("整句被删（没有对应新增）→ trim，且标不确定", () => {
    // 注意：删一句的同时又冒出新句，那是 structure（整句重写），不是 trim —— 别混为一谈
    const items = explainChanges("第一句原样保留着。第二句整句都被删掉了。", "第一句原样保留着。");
    const trims = items.filter((i) => i.kind === "trim");
    expect(trims.length).toBe(1);
    expect(trims[0].before).toContain("第二句");
    expect(trims[0].certain).toBe(false);
  });

  it("整句被换掉（有删有增但归因不出）→ structure，不是 trim", () => {
    const items = explainChanges(
      "这是一句完全没有触发词表的话。",
      "换成了另一句同样没触发词表的话。",
    );
    expect(items.some((i) => i.kind === "structure" && i.certain === false)).toBe(true);
  });

  it("凭空多出来的内容 → inject，且标不确定", () => {
    const items = explainChanges("短句。", "短句。另外补了一整句话进来，原文并没有这句。");
    expect(items.some((i) => i.kind === "inject" && i.certain === false)).toBe(true);
  });
});

describe("汇总与渲染", () => {
  it("summary 只统计确定归因 —— 推断类不许混进「确定做了什么」", () => {
    const out = humanize(SRC, { intensity: 0.6, seed: SEED });
    const items = explainChanges(SRC, out);
    const certainCount = items.filter((i) => i.certain).length;

    const sum = explainSummary(items);
    const sumTotal = Object.values(sum).reduce((a, b) => a + b, 0);
    expect(sumTotal).toBe(certainCount);
  });

  it("formatExplain 列出每条的依据，且区分确定/推断", () => {
    const out = humanize(SRC, { intensity: 0.6, seed: SEED });
    const txt = formatExplain(explainChanges(SRC, out));
    expect(txt).toContain("依据：");
    expect(txt).toContain("值得注意");
  });

  it("lookupVocab 查不到就返回 null —— 不编一个替身出来", () => {
    expect(lookupVocab("值得注意的是")).toBeTruthy();
    expect(lookupVocab("这个词肯定不在词表里")).toBeNull();
  });
});
