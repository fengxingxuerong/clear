import { describe, it, expect } from "vitest";
import { humanizeBestOf } from "./humanize-bestof";

/** 带 AI 特征的样本（套话 + 骨架 + 中英空格） */
const AI_TEXT = `随着信息技术的不断发展，数字化转型成为了热议的话题。值得注意的是，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。综上所述，建立完善的监管体系，推动可持续发展，具有十分重要的意义。因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的发展。`;

describe("humanizeBestOf（多候选择优）", () => {
  it("固定种子结果可复现", () => {
    const a = humanizeBestOf(AI_TEXT, { seed: 42, candidates: 3 });
    const b = humanizeBestOf(AI_TEXT, { seed: 42, candidates: 3 });
    expect(a.text).toBe(b.text);
    expect(a.seed).toBe(b.seed);
  });

  it("tried 等于候选数，rejected 不为负", () => {
    const r = humanizeBestOf(AI_TEXT, { seed: 7, candidates: 5 });
    expect(r.tried).toBe(5);
    expect(r.rejected).toBeGreaterThanOrEqual(0);
    expect(r.rejected).toBeLessThanOrEqual(5);
    expect(r.text.trim().length).toBeGreaterThan(0);
  });

  it("候选数被夹在 1~30", () => {
    expect(humanizeBestOf(AI_TEXT, { seed: 1, candidates: 99 }).tried).toBe(30);
    expect(humanizeBestOf(AI_TEXT, { seed: 1, candidates: 0 }).tried).toBe(1);
  });

  it("中选稿忠实度通过且长度比在门槛内", () => {
    const srcLen = AI_TEXT.replace(/\s/g, "").length;
    const r = humanizeBestOf(AI_TEXT, { seed: 99, candidates: 4 });
    const ratio = r.text.replace(/\s/g, "").length / srcLen;
    expect(ratio).toBeGreaterThanOrEqual(0.6);
    expect(ratio).toBeLessThanOrEqual(1.4);
  });

  it("zhuqueMode/style 选项透传给引擎", () => {
    const r = humanizeBestOf(AI_TEXT, {
      seed: 5,
      candidates: 2,
      intensity: 0.9,
      zhuqueMode: true,
      style: "casual",
    });
    expect(r.text.trim().length).toBeGreaterThan(0);
    expect(r.after.score).toBeLessThanOrEqual(r.before.score + 5);
  });
});
