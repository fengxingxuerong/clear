import { describe, expect, it } from "vitest";
import { detectAI } from "./detector";
import { formatReview, reviewText } from "./review";

/**
 * ⚠️ 断言纪律：判串必须是**独立常量**，不许从 `review.ts` 的生产表反查——
 * 否则删掉某条建议会连带删掉对它的检查，等于给缺陷发通行证。
 */

const AI_SAMPLE = [
  "综上所述，企业需要构建高效协同的组织机制，这是提升核心竞争力的关键所在。",
  "首先，数字化转型的深入推进赋能了业务协同能力；其次，精细化运营管理优化了资源配置效率。",
  "只有在夯实数据基础的前置条件下，才能真正释放数据要素的潜在价值。",
  "这是一次极具战略意义的重要实践。",
].join("\n");

const HUMAN_SAMPLE = [
  "周三下午的评审会开了三个小时，最后没结论。",
  "老张把需求文档改了第五版，前端还是没接。",
  "我记得刚入职那会儿，测试环境和生产就分不清。",
  "你要是午饭后去问，他准在看手机，别挑那个点。",
].join("\n");

/** 同时含负向（提纲骨架/抽象名词）与正向（主观视角）的句子，用于锁「正向项不给建议」 */
const MIXED_SENTENCE = "综上所述，我认为我们需要构建一套高效的协同机制体系。";

/** 独立常量：与 review.ts 内部一致，但重复写死 */
const RISK_FLOOR = 40;
const POSITIVE_REASONS = ["有主观视角", "有具体细节", "短句", "疑问句"];

/** 风险递增的样本：若实现改成按风险降序输出，下面那条用例会立刻分辨出来 */
const REVERSED_SAMPLE = [
  "其次，精细化运营管理优化了资源配置效率。",
  "综上所述，企业需要构建高效协同的组织机制，这是提升核心竞争力的关键所在。",
].join("\n");

describe("审题模式 reviewText", () => {
  it("AI 样本能标出痕迹，人类样本一句都不标", () => {
    const ai = reviewText(AI_SAMPLE);
    const human = reviewText(HUMAN_SAMPLE);

    expect(ai.marked).toBeGreaterThanOrEqual(3);
    expect(ai.probability).toBeGreaterThanOrEqual(48);
    expect(human.marked).toBe(0);
    expect(ai.probability).toBeGreaterThan(human.probability);
  });

  it("与 detectAI 用同一套打分，不得漂移", () => {
    for (const t of [AI_SAMPLE, HUMAN_SAMPLE]) {
      expect(reviewText(t).probability).toBe(detectAI(t).probability);
      expect(reviewText(t).levelText).toBe(detectAI(t).levelText);
    }
  });

  it("痕迹按文档顺序输出，不按风险排序", () => {
    const idx = reviewText(AI_SAMPLE).marks.map((m) => m.index);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));

    // 反例：两句都过门槛，但后句风险更高——按文档顺序应是 [1,2] 且风险升序
    const r = reviewText(REVERSED_SAMPLE);
    expect(r.marked).toBe(2);
    expect(r.marks.map((m) => m.index)).toEqual([1, 2]);
    expect(r.marks[0].risk).toBeLessThan(r.marks[1].risk);
  });

  it("列入地图的句子都过了门槛，且序号从 1 起、risk 在 0~100 内", () => {
    for (const m of reviewText(AI_SAMPLE).marks) {
      expect(m.risk).toBeGreaterThanOrEqual(RISK_FLOOR);
      expect(m.risk).toBeLessThanOrEqual(100);
      expect(m.index).toBeGreaterThanOrEqual(1);
    }
  });

  it("正向特征只解释分数，不进统计也不给建议", () => {
    const r = reviewText(MIXED_SENTENCE);
    expect(r.marked).toBe(1);
    const m = r.marks[0];
    expect(m.reasons).toContain("有主观视角");

    const maybePositive = m.suggestions.filter((s) => POSITIVE_REASONS.some((p) => s.includes(p)));
    expect(maybePositive).toEqual([]);

    for (const p of POSITIVE_REASONS) {
      expect(r.summary.map(([k]) => k)).not.toContain(p);
    }
    for (const s of m.suggestions) expect(s.length).toBeGreaterThan(0);
  });

  it("summary 按出现次数降序", () => {
    const { summary } = reviewText(AI_SAMPLE);
    expect(summary.length).toBeGreaterThan(0);
    const counts = summary.map(([, v]) => v);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("纯函数：不得改动传入文本", () => {
    const snapshot = AI_SAMPLE;
    reviewText(AI_SAMPLE);
    expect(AI_SAMPLE).toBe(snapshot);
  });

  it("空输入不炸，也给不出痕迹", () => {
    const r = reviewText("");
    expect(r.marked).toBe(0);
    expect(r.marks).toEqual([]);
    expect(r.summary).toEqual([]);
  });
});

describe("formatReview", () => {
  it("渲染出总分、门槛句数、每句序号与建议", () => {
    const out = formatReview(reviewText(AI_SAMPLE));
    expect(out).toContain("AI 味代理分");
    expect(out).toContain("本地启发式，非官方分");
    expect(out).toContain("第1句");
    expect(out).toContain("建议：");
  });

  it("无痕迹时给的是限定语，不是『保证像人写』", () => {
    const out = formatReview(reviewText(HUMAN_SAMPLE));
    expect(out).toContain("不代表一定像人写");
    expect(out).not.toMatch(/保证|一定通过|必定/);
  });
});
