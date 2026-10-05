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

/* 2026-10-05 分支补测：humanize-bestof.ts 此前分支 81.5%，
   未覆盖 47（候选数自适应三档）、48（?? 两侧）、49（srcLen 兜底）。 */
describe("humanizeBestOf：候选数自适应与空输入兜底", () => {
  it("未给 candidates 时按文本长度三档自适应（行 47 的 auto 支）", () => {
    const mid = AI_TEXT.repeat(12);
    const long = AI_TEXT.repeat(30);
    // 先钉住长度前提：三档一旦因语料改动而越界，失败信息直接指向构造而不是断言
    expect(AI_TEXT.length).toBeLessThanOrEqual(1500); // → 10
    expect(mid.length).toBeGreaterThan(1500);
    expect(mid.length).toBeLessThanOrEqual(4000); // → 6
    expect(long.length).toBeGreaterThan(4000); // → 4

    expect(humanizeBestOf(AI_TEXT, { seed: 1 }).tried).toBe(10);
    expect(humanizeBestOf(mid, { seed: 1 }).tried).toBe(6);
    expect(humanizeBestOf(long, { seed: 1 }).tried).toBe(4);
  });

  it("显式 candidates 优先于自动档（行 48 的 ?? 左支）", () => {
    const long = AI_TEXT.repeat(30); // 不给的话自动档是 4
    expect(humanizeBestOf(long, { seed: 1, candidates: 2 }).tried).toBe(2);
  });

  it("纯空白输入：srcLen 兜底为 1 且走兜底单次生成，不静默崩（行 49 的 ||1 右支）", () => {
    const r = humanizeBestOf("   ", { seed: 1, candidates: 1 });
    expect(r.tried).toBe(1);
    expect(r.rejected).toBe(0); // 空输出在 `!out.trim()` 处就 continue 了，不算淘汰
    expect(r.text).toBe(""); // 全部候选为空 → 走 84 行兜底，不抛异常
  });

  it("劣稿被淘汰：排比被拉长导致长度比 >1.4 → rejected 计数（行 73-75）", () => {
    // 探针实测（scripts/_probe_bestof.ts，已删）：该输入经引擎改写后 ratio≈1.558，
    // 超过 1.4 上限 → 6 个候选里 5 个被这条守卫淘汰，只剩 1 个进入择优。
    const text = "首先，我们要高度重视。其次，我们要认真落实。最后，我们要确保成效。".repeat(5);
    const r = humanizeBestOf(text, { seed: 1, candidates: 6, intensity: 0.9, zhuqueMode: true });

    expect(r.rejected, "这条守卫从未被触发过，等于没测").toBeGreaterThanOrEqual(1);
    expect(r.rejected).toBeLessThan(r.tried); // 至少留一个进择优，不许全军覆没
    expect(r.text.trim().length).toBeGreaterThan(0);
    expect(r.rejected).toBeLessThanOrEqual(r.tried);
  });

  /**
   * 行 71 的 `|| 1` 右支**结构性不可达**（2026-10-05 静态推演，非漏测）：
   * 该臂要求 `srcLen === 0`，即输入全是空白；而 humanize 对纯空白输入恒返回 ""
   * （见 humanize.test.ts「空/纯空白输入返回空串」），于是 65 行 `!out.trim()` 必然
   * 先 continue，永远走不到 71 行。两者互斥，任何测试都无法同时满足。
   */
});
