/**
 * classifyExpositionScore / preDetectHumanFingerprint
 *
 * 这个模块此前没有测试文件。补它时踩了一个很值得记的坑，
 * 写进下面的 BASELINE 注释里。
 *
 * ## 关键：为什么探针前五版全返回 0
 *
 * classifyExpositionScore 的 score **起于 0**，只被两类东西推动：
 *   正向：A. 论说词密度（strong × 0.18 + weak × 0.06，除以千字数，上限 0.55）
 *   负向：B 对话体 -0.2/-0.45、C 引号对白密度 -0.2、D 叙事时空词 -0.1/-0.35
 * 末尾 `Math.max(0, Math.min(1, score))` 把负分夹回 0。
 *
 * 于是：**只带负特征的文本必然返回 0**，因为它没有正向分可扣。
 * 探针前五版分别踩了「语料太短（40 字下限）」「pad 天书不含任何标记词」
 * 「只加负特征」三个坑，全部返回 0.0000，看起来像"功能坏了"。
 *
 * 正确做法：先造一个**正向分拉满的基线**（0.55），再往上加负特征，
 * 惩罚量才可见。BASELINE 就是干这个的。
 */
import { describe, it, expect } from "vitest";
import { classifyExpositionScore, preDetectHumanFingerprint } from "./fingerprint";

/** 正向分拉满的基线文本：重复 8 个强论说词 + 填充句，探针实测 score = 0.55 */
const BASELINE =
  "综上所述，基于以上分析，研究表明，数据显示，白皮书显示，报告显示，众所周知，这意味着。".repeat(
    2,
  ) + "这是一段用来凑长度的普通文字，不含任何论说词也不含叙事词。".repeat(3);

describe("classifyExpositionScore：正向基线", () => {
  it("论说词拉满 → 0.55（0.18 × 8 词 / 千字，上限封顶）", () => {
    expect(classifyExpositionScore(BASELINE)).toBeCloseTo(0.55, 5);
  });

  it("不足 40 字一律返回 0（低于下限不评分）", () => {
    // 探针实测：39 / 40 / 41 字的天书语料全是 0
    for (const t of ["甲乙丙。", "甲".repeat(39), "甲".repeat(41)]) {
      expect(classifyExpositionScore(t), `${t.length} 字`).toBe(0);
    }
  });

  it("空串返回 0", () => {
    expect(classifyExpositionScore("")).toBe(0);
  });
});

describe("classifyExpositionScore：三类负特征惩罚", () => {
  it("对话体：1 处 -0.2、2 处及以上 -0.45", () => {
    // 探针实测：0 块 0.55 → 1 块 0.35 → 2 块 0.10 → 3 块 0.10（封顶不再叠加）
    expect(classifyExpositionScore(BASELINE + "\n【场景：会议室】")).toBeCloseTo(0.35, 5);
    expect(classifyExpositionScore(BASELINE + "\n【场景：会议室】\n【人物：张三】")).toBeCloseTo(
      0.1,
      5,
    );
    // 第 3 处不再叠加——if/else if 结构，不是累加
    expect(
      classifyExpositionScore(BASELINE + "\n【场景：会议室】\n【人物：张三】\n【时间：上午】"),
    ).toBeCloseTo(0.1, 5);
  });

  it("引号对白密度：不足 3 处不扣、达到 3 处扣 0.2", () => {
    const quotes = (n: number) =>
      Array.from({ length: n }, (_, i) => `“观点${i}很重要”，`).join("");
    expect(classifyExpositionScore(BASELINE)).toBeCloseTo(0.55, 5);
    expect(classifyExpositionScore(BASELINE + quotes(2))).toBeCloseTo(0.55, 5);
    expect(classifyExpositionScore(BASELINE + quotes(3))).toBeCloseTo(0.35, 5);
  });

  it("叙事时空词：1 处 -0.1、3 处及以上 -0.35", () => {
    const marks = (n: number) => Array.from({ length: n }, () => "那天").join("，");
    expect(classifyExpositionScore(BASELINE + marks(1))).toBeCloseTo(0.45, 5);
    expect(classifyExpositionScore(BASELINE + marks(3))).toBeCloseTo(0.2, 5);
  });

  it("三类惩罚可叠加，扣到底后被 Math.max(0) 夹住不会变负", () => {
    // 全都打满：0.55 - 0.45 - 0.2 - 0.35 = -0.45 → 夹回 0
    const all =
      BASELINE +
      "\n【场景：会议室】\n【人物：张三】" +
      `“观点0很重要”，“观点1很重要”，“观点2很重要”，` +
      "那天，那天，那天";
    expect(classifyExpositionScore(all)).toBe(0);
  });

  it("只带负特征而无正向分 → 恒为 0（这条钉住夹取行为）", () => {
    // 探针前五版就是被这个现象骗了：不是功能坏，是没有可扣的分。
    const onlyNegative =
      "这是一段没有任何论说词的普通文字。\n【场景：会议室】\n【人物：张三】\n那天，那天，那天。";
    expect(classifyExpositionScore(onlyNegative)).toBe(0);
  });
});

describe("preDetectHumanFingerprint：50 字下限与段首 CV", () => {
  const empty = {
    isHumanHand: false,
    hits: 0,
    metrics: { burstiness: 0, typosPerK: 0, shortRatio: 0, paraLeadCV: 0, personPronPerK: 0 },
  };

  it("空串与纯空白返回全零报告", () => {
    expect(preDetectHumanFingerprint("")).toEqual(empty);
    expect(preDetectHumanFingerprint("   ")).toEqual(empty);
  });

  it("不足 50 字一律返回全零报告", () => {
    // 探针实测 49 / 50 / 51 字的纯填充文本 hits 均为 0
    expect(preDetectHumanFingerprint("甲".repeat(49))).toEqual(empty);
    expect(preDetectHumanFingerprint("甲".repeat(51))).toEqual(empty);
  });

  it("只切出 1 句时 shortRatio 为 0（不除零）", () => {
    // 探针实测：单句 51 字 → shortRatio=0、paraLeadCV=0
    const r = preDetectHumanFingerprint("甲".repeat(50) + "。");
    expect(r.metrics.shortRatio).toBe(0);
    expect(r.metrics.paraLeadCV).toBe(0);
  });

  it("多段且段首长度参差时 paraLeadCV > 0", () => {
    // 探针实测：4 段、段首长度差异大 → paraLeadCV=0.59、shortRatio=0.5、hits=4
    const r = preDetectHumanFingerprint(
      [
        "很短的开始。",
        "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己庚辛壬癸的内容在这里。",
        "中段。",
        "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉的尾巴。",
      ].join("\n\n"),
    );
    expect(r.metrics.paraLeadCV).toBeGreaterThan(0);
    expect(r.metrics.shortRatio).toBeGreaterThan(0);
  });

  it("无手写错别字 → typosPerK 为 0（反证：补上错别字后应上升）", () => {
    const clean = preDetectHumanFingerprint("这是一段干净的文字没有错字。" + "内容重复".repeat(10));
    const typo = preDetectHumanFingerprint("做为一件事的到结果按装。" + "内容重复".repeat(10));
    expect(clean.metrics.typosPerK).toBe(0);
    expect(typo.metrics.typosPerK).toBeGreaterThan(clean.metrics.typosPerK);
  });
});
