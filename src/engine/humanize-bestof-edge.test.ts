/**
 * humanizeBestOf 边界行为锁（v0.9.16 长尾清扫）：
 *  - 空候选跳过（不占 tried 名额）
 *  - 三重门槛（保真/长度比/塌陷）淘汰候选
 *  - 全部被淘汰时回退单次生成（硬承诺：绝不静默返回空）
 *
 * humanize 整体 mock（返回序列可控），三重门槛检查走真实实现。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { humanizeBestOf } from "./humanize-bestof";
import { aiScore } from "./humanize";

const TEXT =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。";

const { humanizeMock } = vi.hoisted(() => ({ humanizeMock: vi.fn() }));

vi.mock("./humanize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./humanize")>()),
  humanize: humanizeMock,
}));

// 合格候选 = 原文本身（保真 pass、长度比 1、无塌陷）
const GOOD = TEXT;

beforeEach(() => {
  humanizeMock.mockReset();
});

describe("humanizeBestOf（多候选择优）", () => {
  it("无关稿被三重门槛淘汰、合格稿入选：rejected=1", () => {
    humanizeMock.mockImplementationOnce(() => "完全无关的另一段话，跟原文没有任何关系。");
    humanizeMock.mockImplementationOnce(() => GOOD);
    const r = humanizeBestOf(TEXT, { candidates: 2, seed: 42 });
    expect(r.rejected).toBe(1);
    expect(r.tried).toBe(2);
    expect(r.text).toBe(GOOD);
    expect(r.seed).toBe((42 + 1 * 7919) & 0xffffffff); // 中选的是第 2 个候选
    expect(r.fingerprint).toBeDefined();
  });

  it("空候选被跳过（不产出即不计入择优）", () => {
    humanizeMock.mockImplementationOnce(() => "   ");
    humanizeMock.mockImplementationOnce(() => GOOD);
    const r = humanizeBestOf(TEXT, { candidates: 2, seed: 42 });
    expect(r.text).toBe(GOOD);
    expect(r.tried).toBe(2); // 两次都执行了（空候选算尝试）
    expect(r.rejected).toBe(0); // 空候选走 continue，不算淘汰
  });

  it("全部候选被淘汰：回退单次生成，保证一定有输出", () => {
    // 两次都返回无关稿 → 全部 rejected → 回退路径再调一次 humanize
    humanizeMock.mockImplementation(() => "无关稿内容，必然被保真检查淘汰。");
    const r = humanizeBestOf(TEXT, { candidates: 2, seed: 42 });
    expect(r.text.length).toBeGreaterThan(0);
    expect(humanizeMock).toHaveBeenCalledTimes(3); // 2 候选 + 1 回退
  });

  it("确定性：同 seed 同输入，中选稿一致", () => {
    humanizeMock.mockImplementation((t: string) => t);
    const a = humanizeBestOf(TEXT, { candidates: 3, seed: 7 });
    const b = humanizeBestOf(TEXT, { candidates: 3, seed: 7 });
    expect(a.text).toBe(b.text);
    expect(a.seed).toBe(b.seed);
  });
});

// 让 aiScore import 不被 tree-shake 报 unused（before 字段类型引用）
void aiScore;
