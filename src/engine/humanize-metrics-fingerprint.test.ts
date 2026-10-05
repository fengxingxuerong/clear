/**
 * fingerprintCheck 的阈值边界
 *
 * 这个函数此前只有标尺区分度的测试（humanize-metrics-calibration.test.ts），
 * 而那几个用例都喂的是"正常文本"——于是所有**阈值判断的 `> N` 分支**
 * （省略号、破折号、半角逗号）一个都没被执行过。
 *
 * 这些分支的共同特点是"差一丁点就不报"，最容易被后人「顺手改成 >=」或
 * 「调宽一格」而悄悄改掉语义，所以每条都钉住两侧的边界值。
 *
 * 所有期望值都来自探针实测（seed 无关，fingerprintCheck 是纯函数），不是推测。
 */
import { describe, it, expect } from "vitest";
import { fingerprintCheck, aiScore } from "./humanize-metrics";

const issueOf = (text: string, key: string) =>
  fingerprintCheck(text).issues.find((i) => i.name.includes(key));

describe("fingerprintCheck：省略号 / 破折号阈值", () => {
  // 阈值是 `> 1`，即**整篇最多 1 个**。实测：
  //   0 个 → 不报；1 个 → 不报；2 个 → 报（count=2）
  it("省略号：0 个与 1 个都不报，2 个才报", () => {
    expect(issueOf("他说完就走了", "省略号")).toBeUndefined();
    expect(issueOf("他……走了", "省略号")).toBeUndefined();
    const hit = issueOf("他……走了，我……也走了", "省略号");
    expect(hit?.count).toBe(2);
  });

  it("破折号：1 个不报，2 个才报", () => {
    expect(issueOf("他走了——真的走了", "破折号")).toBeUndefined();
    expect(issueOf("他走了——真的走了——又走了", "破折号")?.count).toBe(2);
  });
});

describe("fingerprintCheck：半角逗号比例", () => {
  // 阈值 `halfC / (fullC + halfC) > 0.15`，理由写在源码注释里：
  // 人类手打文本偶尔有 5-15% 半角逗号（输入法切换失误），超过 15% 反而是新指纹。
  it("全角为主时不管有多少半角逗号都不报", () => {
    expect(issueOf("他走了，我来了。", "半角")).toBeUndefined();
  });

  it("半角为主（占比 > 15%）时报出个数", () => {
    expect(issueOf("a,b,c", "半角")?.count).toBe(2);
    expect(issueOf("甲,乙。丙,丁。", "半角")?.count).toBe(2);
    expect(issueOf("他走了,我来了,他走了,我来了。", "半角")?.count).toBe(3);
  });

  it("半角占比恰在 15% 时不报（边界是 > 而不是 >=）", () => {
    // 20 个逗号里 3 个半角 = 15%
    // 构造：18 个「甲」用全角逗号连接 = 17 个全角，追加 ",乙,丙,丁" = 3 个半角。
    const text = Array.from({ length: 18 }, () => "甲").join("，") + ",乙,丙,丁";
    expect(issueOf(text, "半角")).toBeUndefined();
  });

  it("低于阈值不报、超过阈值报（反向对照，别靠浮点巧合通过）", () => {
    // 19 个甲 = 18 个全角，再追加 3 个半角 → 3/21 ≈ 14.3% < 15% → 不报
    const under = Array.from({ length: 19 }, () => "甲").join("，") + ",乙,丙,丁";
    const h1 = (under.match(/,/g) || []).length;
    const f1 = (under.match(/，/g) || []).length;
    expect(h1 / (h1 + f1)).toBeLessThan(0.15);
    expect(issueOf(under, "半角")).toBeUndefined();

    // 同样 3 个半角，但全角只有 17 个 → 3/20 = 15% → 不报（边界）
    const edge = Array.from({ length: 18 }, () => "甲").join("，") + ",乙,丙,丁";
    const h2 = (edge.match(/,/g) || []).length;
    const f2 = (edge.match(/，/g) || []).length;
    expect(h2 / (h2 + f2)).toBe(0.15);
    expect(issueOf(edge, "半角")).toBeUndefined();

    // 4 个半角 + 17 个全角 → 4/21 ≈ 19% > 15% → 报
    const over = Array.from({ length: 18 }, () => "甲").join("，") + ",乙,丙,丁,戊";
    expect(issueOf(over, "半角")?.count).toBe(4);
  });
});

describe("fingerprintCheck / aiScore：空输入", () => {
  // countPollutedSentences 的 `sents.length === 0` 守卫：
  // 空串、纯空格、纯换行都必须给出全零而不是崩。
  it.each([
    ["空串", ""],
    ["纯空格", "   "],
    ["纯换行", "\n\n"],
  ])("%s → score 0 且零 issue", (_label, text) => {
    const s = aiScore(text);
    expect(s.score).toBe(0);
    expect(s.sentenceCount).toBe(0);
    expect(fingerprintCheck(text).issues).toEqual([]);
  });

  it("只有标点的文本：算 1 句、score 0、不报 issue", () => {
    // 实测：「。」→ sentenceCount=1；「！！！」同样。
    // 与上面空串的 sentenceCount=0 构成对照，说明守卫判的是「切完没有有效句」，
    // 不是「长度为零」。
    expect(aiScore("。").sentenceCount).toBe(1);
    expect(aiScore("！！！").sentenceCount).toBe(1);
    expect(aiScore("甲。").score).toBe(0);
  });
});

describe("fingerprintCheck：多项同时命中的报告", () => {
  it("段首过渡词 + AI 套话 + 半角逗号可同时报出", () => {
    // 实测这三项会一起报；断言 issue 名齐备，防止某次重构把某项悄悄漏推。
    const issues = fingerprintCheck(
      "综上所述，我们应该……加强抓手建设——通过机制优化,总之很重要,持续推进抓手。",
    ).issues.map((i) => i.name);
    expect(issues).toContain("段首过渡词残留");
    expect(issues).toContain("AI 套话残留");
    expect(issues).toContain("半角逗号过多");
  });

  it("干净文本不应报任何 issue（防止守卫整体失效而恒绿）", () => {
    // ⚠️ fingerprintCheck 返回的是 { pass, issues, ... } 报告对象，不是数组——
    // 第一版写成 expect(报告).toEqual([]) 直接红了。探针复核：这份语料确实零 issue。
    const report = fingerprintCheck("昨天我在菜市场买了两个西红柿，摊主说最近雨下得多光照不够。");
    expect(report.issues).toEqual([]);
    expect(report.pass).toBe(true);
  });
});
