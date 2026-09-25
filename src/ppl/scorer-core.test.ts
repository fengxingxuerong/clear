import { describe, expect, it } from "vitest";
import {
  aggregateText,
  aggregateWindow,
  maskGroups,
  maskedMeanNll,
  nllToPerplexity,
  planWindows,
  selectTargets,
  toNumberList,
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

describe("toNumberList（张量归一）", () => {
  it("Tensor 对象：tolist() 返回一维数组", () => {
    expect(toNumberList({ tolist: () => [1, 2, 3] })).toEqual([1, 2, 3]);
  });

  it("Tensor 对象：tolist() 返回二维嵌套需展平", () => {
    expect(toNumberList({ tolist: () => [[101, 22], [33, 102]] })).toEqual([101, 22, 33, 102]);
  });

  it("Tensor 对象：tolist() 返回三维嵌套也展平", () => {
    expect(toNumberList({ tolist: () => [[[101, 22, 102]]] })).toEqual([101, 22, 102]);
  });

  it("降级路径：只有 .data（TypedArray）", () => {
    expect(toNumberList({ data: Int32Array.from([5, 6, 7]) })).toEqual([5, 6, 7]);
  });

  it("纯嵌套数组（测试桩）", () => {
    expect(toNumberList([[[1]], [[2]]])).toEqual([1, 2]);
  });

  it("BigInt64Array 也转成 number（worker 里张量是 int64）", () => {
    expect(toNumberList({ data: BigInt64Array.from([1n, 2n]) })).toEqual([1, 2]);
  });

  it("null / undefined 返回 null 而不是空数组（避免算出假性 0 分）", () => {
    expect(toNumberList(null)).toBeNull();
    expect(toNumberList(undefined)).toBeNull();
  });

  it("tolist() 返回非数组时返回 null", () => {
    expect(toNumberList({ tolist: () => 123 })).toBeNull();
  });

  it("既无 tolist 也无 data 且非数组时返回 null", () => {
    expect(toNumberList({ foo: 1 })).toBeNull();
  });
});

describe("maskGroups（打分目标分组轮转）", () => {
  it("6 项分 3 组：按序轮转，相邻项落不同组", () => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const groups = maskGroups(items, 3);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual(["a", "d"]);
    expect(groups[1]).toEqual(["b", "e"]);
    expect(groups[2]).toEqual(["c", "f"]);
  });

  it("10 项 5 组：组数与 MASK_GROUPS 默认一致时相邻 token 永不同组", () => {
    const groups = maskGroups([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
    expect(groups).toHaveLength(5);
    for (let i = 0; i + 1 < 10; i++) {
      const gi = groups.findIndex((g) => g.includes(i));
      const gj = groups.findIndex((g) => g.includes(i + 1));
      expect(gi).not.toBe(gj);
    }
  });

  it("groups=1 时全部归一组", () => {
    expect(maskGroups([1, 2, 3], 1)).toEqual([[1, 2, 3]]);
  });

  it("groups 非正数向下取整后兜底为 1 组", () => {
    expect(maskGroups([1, 2], 0)).toEqual([[1, 2]]);
    expect(maskGroups([1, 2], -3)).toEqual([[1, 2]]);
  });

  it("groups=2.7 向下取整为 2 组", () => {
    expect(maskGroups([1, 2, 3], 2.7)).toEqual([[1, 3], [2]]);
  });

  it("空输入返回 n 个空组", () => {
    expect(maskGroups([], 3)).toEqual([[], [], []]);
  });
});

describe("maskedMeanNll（log-softmax 均值负对数似然）", () => {
  it("单目标：与手算 log-softmax NLL 一致", () => {
    // vocabSize=3，pos=0 行 logits=[2,1,0]，原词 id=1
    // max=2；logSumExp=ln(exp(0)+exp(-1)+exp(-2))≈0.4076
    // NLL = -(1 - (2 + 0.4076)) ≈ 1.4076
    const nll = maskedMeanNll([2, 1, 0], 1, 3, [{ pos: 0, origId: 1 }]);
    expect(nll).toBeCloseTo(1.4076, 3);
  });

  it("多目标取均值", () => {
    // 目标 1：pos=0 行 [2,1,0]，原词 id=1 → ≈1.4076
    // 目标 2：pos=1 行 [0,1,2]，原词 id=2 → max=2，同 logSumExp≈0.4076 → -(2-2.4076)=0.4076
    // 均值 ≈ 0.9076
    const nll = maskedMeanNll(
      [2, 1, 0, 0, 1, 2],
      2,
      3,
      [
        { pos: 0, origId: 1 },
        { pos: 1, origId: 2 },
      ],
    );
    expect(nll).toBeCloseTo(0.9076, 3);
  });

  it("空 targets 返回 NaN（调用方应丢弃该窗）", () => {
    expect(maskedMeanNll([1, 2, 3], 1, 3, [])).toBeNaN();
  });

  it("数值稳定：logits 全 1000 时结果为 ln(vocabSize)，不产生 Infinity/NaN", () => {
    const nll = maskedMeanNll(
      [1000, 1000, 1000, 1000, 1000],
      1,
      5,
      [{ pos: 0, origId: 0 }],
    );
    expect(nll).toBeCloseTo(Math.log(5), 6);
  });

  it("原词概率远高于其它时 NLL 接近 0", () => {
    // pos=0 行 [10, 0, 0, 0]，原词 id=0 → softmax 几乎全在原词 → NLL≈0
    const nll = maskedMeanNll([10, 0, 0, 0], 1, 4, [{ pos: 0, origId: 0 }]);
    expect(nll).toBeLessThan(0.001);
  });
});
