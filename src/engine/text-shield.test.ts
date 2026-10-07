/**
 * v0.9.25 结构化串（URL / 邮箱）区间表单元测试
 *
 * 锁的是**承载方式**这件事本身：v0.9.24 ⑩ 用「U+E000~U+E00F 占位符 + 还原」做同一件事，
 * 实测有两个洞（槽位上限 16、压字符破坏偏移），本文件把这两个洞钉成回归。
 *
 * 覆盖：
 * 1. `structuredSpans` 区间正确性（左闭右开、升序不重叠、URL 与邮箱）
 * 2. **40 个 URL 一个不少** —— 占位符方案在此处必崩（第 17 个起溢出成乱码并永久丢失）
 * 3. `spanGuard` 的二分与朴素线性实现逐下标一致（二分写错能被测出来）
 * 4. 切句联动：`humanize-text.splitSentences` 保真 + 纯中文语料的回归对照
 */
import { describe, it, expect } from "vitest";
import { structuredSpans, spanGuard, guardFor, type TextSpan } from "./text-shield";
import { splitSentences } from "./humanize-text";

/** 朴素实现：线性扫描，用来对照二分 */
function naiveInside(spans: TextSpan[], idx: number): boolean {
  for (const s of spans) {
    if (idx >= s.start && idx < s.end) return true;
  }
  return false;
}

function urlsOf(s: string): string[] {
  return s.match(/https?:\/\/[^\s，。；]+/g) || [];
}

describe("structuredSpans（区间表）", () => {
  it("空输入 / 无结构化串 → 空数组", () => {
    expect(structuredSpans("")).toEqual([]);
    expect(structuredSpans("今天天气不错，我们去公园。")).toEqual([]);
    expect(structuredSpans("版本号是 v1.2.3，时间是 14:30。")).toEqual([]);
  });

  it("URL 区间左闭右开，且不含紧随其后的中文标点", () => {
    const text = "详见 https://example.com/a?b=1 。";
    const spans = structuredSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("https://example.com/a?b=1");
    // 末尾那个 `。` 不在区间内 —— 否则切句会漏掉这个切点
    expect(spans[0].end).toBe(text.indexOf(" 。"));
  });

  it("邮箱同样纳入", () => {
    const text = "联系 a.b+c@ex-ample.com.cn 谢谢";
    const spans = structuredSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("a.b+c@ex-ample.com.cn");
  });

  it("多个串按起点升序且互不重叠", () => {
    const text = "见 https://a.com/x 与 http://b.org/y?z=1，或 mail@x.io。";
    const spans = structuredSpans(text);
    expect(spans.length).toBe(3);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThan(spans[i - 1].start);
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  });

  it("40 个 URL 一个都不能少 —— 占位符方案 16 槽位的死穴回归", () => {
    // 构造：每个 URL 后跟一个句号，逼切句真的动手
    const parts: string[] = [];
    for (let i = 0; i < 40; i++) parts.push(`链接${i} https://ex.com/${i}?q=${i}。`);
    const text = parts.join("");

    const spans = structuredSpans(text);
    expect(spans).toHaveLength(40);

    // 每个区间都精确对应它那个 URL（不是错位的、不是空的）
    for (let i = 0; i < 40; i++) {
      const seg = text.slice(spans[i].start, spans[i].end);
      expect(seg).toBe(`https://ex.com/${i}?q=${i}`);
    }
  });
});

describe("spanGuard（二分判定器）", () => {
  it("空数组 / null → 恒 false，调用方无需写分支", () => {
    const g0 = spanGuard([]);
    const gn = spanGuard(null);
    const gu = spanGuard(undefined);
    for (let i = 0; i < 5; i++) {
      expect(g0(i)).toBe(false);
      expect(gn(i)).toBe(false);
      expect(gu(i)).toBe(false);
    }
  });

  it("边界：start 命中、end 不命中（左闭右开）", () => {
    const g = spanGuard([{ start: 3, end: 7 }]);
    expect(g(2)).toBe(false);
    expect(g(3)).toBe(true);
    expect(g(6)).toBe(true);
    expect(g(7)).toBe(false);
  });

  it("与朴素实现逐下标一致（多区间下二分写错能被测出来）", () => {
    const text = "开头 https://a.com/x?y=1 中间 foo@bar.io 再一段 http://c.org/d 结尾。";
    const spans = structuredSpans(text);
    expect(spans.length).toBeGreaterThanOrEqual(3);
    const g = guardFor(text);
    for (let i = 0; i < text.length; i++) {
      expect(g(i)).toBe(naiveInside(spans, i));
    }
  });
});

describe("切句联动（humanize-text.splitSentences）", () => {
  it("URL 内的 ? / & 不再造出假句", () => {
    const text = "详见 https://example.com/a?b=1&c=2 的说明。后面还有一句。";
    const sents = splitSentences(text);
    expect(sents).toHaveLength(2);
    expect(sents[0]).toContain("https://example.com/a?b=1&c=2");
  });

  it("40 个 URL 的段落：切句后 URL 全部完整保留，无丢失、无私用区乱码", () => {
    const parts: string[] = [];
    for (let i = 0; i < 40; i++) parts.push(`链接${i} https://ex.com/${i}?q=${i}。`);
    const text = parts.join("");
    const sents = splitSentences(text);
    const joined = sents.join("");

    // 句数必须正好 40 —— 每个 URL 里的 `?` 都不该造出假句。
    // 这条**对区间表被截断/漏匹配敏感**（实测：把 guardFor 截到前 16 个区间，本断言即红），
    // 而上面的「URL 数 == 40」对新实现并不敏感（区间表缺了只会多切，不会丢字符），
    // 它锁的是「不许退回占位符方案」那条路。
    expect(sents).toHaveLength(40);
    expect(urlsOf(joined)).toHaveLength(40);
    // 私用区残留 = 占位符没还原，必须为零
    expect(/[\uE000-\uE00F]/.test(joined)).toBe(false);
    // 每个 URL 字面量都在
    for (let i = 0; i < 40; i++) {
      expect(joined).toContain(`https://ex.com/${i}?q=${i}`);
    }
  });

  it("纯中文语料：切句结果与改动前逐字一致（回归对照）", () => {
    expect(splitSentences("今天天气不错。我们去公园吧！你带水了吗？")).toEqual([
      "今天天气不错。",
      "我们去公园吧！",
      "你带水了吗？",
    ]);
    // 连续分隔符整体吃掉、拼到上一句尾，再 trim
    expect(splitSentences("第一段。\n第二段！\n")).toEqual(["第一段。", "第二段！"]);
    // 空段被滤掉
    expect(splitSentences("前面。；；；后面。")).toEqual(["前面。；；；", "后面。"]);
  });
});
