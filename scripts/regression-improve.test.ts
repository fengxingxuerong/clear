/**
 * regression-improve 自证门禁的单测。
 *
 * 覆盖两件事：① 判定逻辑（阈值边界、skip 语义）② 度量的确定性。
 * 为什么不测"当前改善率是多少"：那是**基线**，由
 * `npx tsx scripts/regression-improve.ts --samples ...` 现场跑出来看；
 * 把它写进断言等于把基线钉死在测试里，改引擎时会在两个地方同时红。
 */
import { describe, it, expect } from "vitest";
import {
  measureImprove,
  badRows,
  IMPROVE_MIN_DROP,
  type ImproveRow,
} from "./regression-improve.ts";

const row = (id: string, drop: number, skip = false): ImproveRow => ({
  id,
  label: id,
  before: 100,
  after: Math.round(100 * (1 - drop)),
  drop,
  skip,
});

describe("badRows —— 阈值判定", () => {
  it("阈值边界：刚好等于阈值算达标，低一点即判红", () => {
    expect(badRows([row("A", IMPROVE_MIN_DROP)])).toHaveLength(0);
    expect(badRows([row("B", IMPROVE_MIN_DROP - 0.01)])).toHaveLength(1);
  });

  it("负改善（越改越像 AI）必须判红", () => {
    expect(badRows([row("C", -0.3)])).toHaveLength(1);
  });

  it("阈值是 50%（实测最低样本 65.3%，留 15pp 余量）", () => {
    expect(IMPROVE_MIN_DROP).toBe(0.5);
  });
});

describe("badRows —— skip 语义", () => {
  it("skip 行即使改善率为 0 也不判红（人写稿：本地尺与官方口径反向）", () => {
    expect(badRows([row("HUMAN-NAR", 0, true)])).toHaveLength(0);
  });

  it("同样的数据不 skip 就要判红 ⇒ skip 真的在起作用，不是恒过", () => {
    expect(badRows([row("HUMAN-NAR", 0, false)])).toHaveLength(1);
  });
});

describe("measureImprove —— 度量本身", () => {
  const samples: [string, string, string, boolean?][] = [
    ["S1", "样本", "随着人工智能技术的不断发展，其在各个领域的应用日益广泛。首先，人工智能技术能够有效提升生产效率，降低企业运营成本；其次，值得注意的是，人工智能的普及也带来了一些挑战。综上所述，我们应当积极拥抱人工智能技术，同时也要建立健全相关的法律法规，以确保其在健康有序的轨道上稳步推进。总而言之，人工智能的发展具有十分重要的意义，值得社会各界给予高度关注。"],
    ["S2", "人写", "那年夏天我第一次离开县城。火车开了整整一夜，硬座。", true],
  ];

  it("同 seed 两次结果逐位相同（引擎纯确定性 ⇒ 门禁可复现）", () => {
    const a = measureImprove(samples, 20260826);
    const b = measureImprove(samples, 20260826);
    expect(b).toEqual(a);
  });

  it("skip 标记原样带回结果行", () => {
    const rows = measureImprove(samples, 20260826);
    expect(rows.find((r) => r.id === "S2")?.skip).toBe(true);
    expect(rows.find((r) => r.id === "S1")?.skip).toBeUndefined();
  });

  it("改善率 = (before - after) / before，且 before=0 时不产生 NaN/Infinity", () => {
    const rows = measureImprove(samples, 20260826);
    for (const r of rows) {
      const want = r.before === 0 ? 0 : (r.before - r.after) / r.before;
      expect(r.drop).toBe(want);
      expect(Number.isFinite(r.drop)).toBe(true);
    }
  });

  it("AI 味原文经引擎改写后改善率为正 —— 门禁的正向自证", () => {
    const rows = measureImprove(samples, 20260826);
    expect(rows.find((r) => r.id === "S1")!.drop).toBeGreaterThan(0);
  });
});
