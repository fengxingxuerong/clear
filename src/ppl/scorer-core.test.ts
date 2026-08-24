import { describe, expect, it } from "vitest";
import {
  aggregateText,
  aggregateWindow,
  nllToPerplexity,
  planWindows,
  selectTargets,
  type PplFeature,
  type PplWindow,
} from "./scorer-core.ts";
import {
  pplIssues,
  PPL_MAX_WIN_STD,
  PPL_MIN_CHARS,
  PPL_MIN_MEAN_NLL,
  PPL_MIN_WINDOWS,
} from "../engine/humanize-metrics.ts";

describe("planWindows", () => {
  it("短文本单窗覆盖且跳过空白", () => {
    const wins = planWindows("你好， 世界！", 384, 320);
    expect(wins.length).toBe(1);
    expect(wins[0].chars.join("")).toBe("你好，世界！");
    expect(wins[0].chars.length).toBe(6);
  });

  it("超长文本多窗且步进正确", () => {
    const text = "甲".repeat(1000);
    const wins = planWindows(text, 100, 80);
    expect(wins.length).toBe(Math.ceil((1000 - 100) / 80) + 1);
    expect(wins[0].chars.length).toBe(100);
    expect(wins[1].chars[0]).toBe(text[80]);
    expect(wins[wins.length - 1].chars[wins[wins.length - 1].chars.length - 1]).toBe(text[999]);
  });

  it("全空白文本返回空窗序列", () => {
    expect(planWindows("   \n\t ").length).toBe(0);
  });
});

describe("selectTargets（免对齐选点）", () => {
  it("跳过特殊 token 与 UNK，其余位置全部保留原词 id", () => {
    // 模拟：[CLS] 你 好 ， [UNK] 。 [SEP]
    const ids = [101, 872, 1962, 8024, 100, 511, 102];
    const tg = selectTargets(ids);
    expect(tg.map((t) => t.pos)).toEqual([1, 2, 3, 5]);
    expect(tg.map((t) => t.origId)).toEqual([872, 1962, 8024, 511]);
  });

  it("纯特殊 token 序列返回空数组", () => {
    expect(selectTargets([101, 102])).toEqual([]);
  });

  it("标点也参与打分（贴近生成式困惑度口径）", () => {
    const tg = selectTargets([101, 8024, 102]);
    expect(tg.length).toBe(1);
    expect(tg[0].origId).toBe(8024);
  });
});

describe("aggregateWindow", () => {
  it("均值只统计未掩码位置", () => {
    const m = aggregateWindow([Math.LN2, Math.log(3), Math.LN2], [true, false, true]);
    expect(m).toBeCloseTo(Math.LN2, 12);
  });

  it("全掩码返回 null", () => {
    expect(aggregateWindow([1, 2], [false, false])).toBeNull();
  });

  it("长度不一致直接抛错", () => {
    expect(() => aggregateWindow([1], [true, true])).toThrow(/长度不一致/);
  });

  it("NaN 视为不可用被忽略", () => {
    expect(aggregateWindow([NaN, Math.log(3)], [true, true])).toBeCloseTo(Math.log(3), 12);
  });
});

describe("aggregateText", () => {
  it("按字数加权的全文均值与窗间样本标准差", () => {
    const wins: PplWindow[] = [
      { charStart: 0, charEnd: 10, scoredCount: 8, meanNll: 1.0 },
      { charStart: 10, charEnd: 20, scoredCount: 2, meanNll: 3.0 },
    ];
    const f = aggregateText(wins);
    expect(f.meanNll).toBeCloseTo(1.4, 12);
    expect(f.scoredChars).toBe(10);
    expect(f.winStd).toBeCloseTo(Math.SQRT2, 12);
  });

  it("单窗 winStd 为 0（不足以谈起伏）", () => {
    const f = aggregateText([{ charStart: 0, charEnd: 5, scoredCount: 5, meanNll: 2 }]);
    expect(f.winStd).toBe(0);
    expect(f.meanNll).toBeCloseTo(2, 12);
  });

  it("空输入零值兜底", () => {
    expect(aggregateText([])).toEqual({ meanNll: 0, winStd: 0, scoredChars: 0, windows: [] });
  });

  it("非有限均值窗口被过滤", () => {
    const f = aggregateText([
      { charStart: 0, charEnd: 5, scoredCount: 5, meanNll: NaN },
      { charStart: 5, charEnd: 10, scoredCount: 5, meanNll: 1 },
    ]);
    expect(f.scoredChars).toBe(5);
    expect(f.windows.length).toBe(1);
  });
});

it("nllToPerplexity 口径换算", () => {
  expect(nllToPerplexity(0)).toBe(1);
  expect(nllToPerplexity(Math.LN10)).toBeCloseTo(10, 12);
});

describe("pplIssues（metrics 层第 8 项判定）", () => {
  const mk = (o: Partial<PplFeature>): PplFeature => ({
    meanNll: 2.5,
    winStd: 0.5,
    scoredChars: 200,
    windows: [
      { charStart: 0, charEnd: 100, scoredCount: 100, meanNll: 2.5 },
      { charStart: 100, charEnd: 200, scoredCount: 100, meanNll: 2.5 },
      { charStart: 200, charEnd: 300, scoredCount: 100, meanNll: 2.5 },
    ],
    ...o,
  });

  it("正常人类特征双通道都不报", () => {
    expect(pplIssues(mk({}))).toEqual([]);
  });

  it("均值过低报困惑度异常低", () => {
    const r = pplIssues(mk({ meanNll: PPL_MIN_MEAN_NLL - 0.5 }));
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("困惑度异常低");
  });

  it("均值恰好等于阈值不报（严格小于）", () => {
    expect(pplIssues(mk({ meanNll: PPL_MIN_MEAN_NLL }))).toEqual([]);
  });

  it("窗间过平报困惑度曲线过平", () => {
    const r = pplIssues(mk({ winStd: PPL_MAX_WIN_STD / 2 }));
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("困惑度曲线过平");
  });

  it("双通道同时触发时报两项", () => {
    const r = pplIssues(mk({ meanNll: PPL_MIN_MEAN_NLL / 2, winStd: PPL_MAX_WIN_STD / 2 }));
    expect(r.map((x) => x.name)).toEqual(["困惑度异常低", "困惑度曲线过平"]);
  });

  it(`不足 ${PPL_MIN_CHARS} 字不判定`, () => {
    expect(pplIssues(mk({ scoredChars: PPL_MIN_CHARS - 1, meanNll: 0.1, winStd: 0 }))).toEqual([]);
  });

  it(`窗口少于 ${PPL_MIN_WINDOWS} 个时平坦通道沉默`, () => {
    const r = pplIssues(
      mk({
        winStd: 0,
        windows: [
          { charStart: 0, charEnd: 150, scoredCount: 150, meanNll: 2.5 },
          { charStart: 150, charEnd: 300, scoredCount: 50, meanNll: 2.5 },
        ],
      }),
    );
    expect(r).toEqual([]);
  });
});
