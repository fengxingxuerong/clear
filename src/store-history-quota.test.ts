// @vitest-environment happy-dom
/**
 * store-history-quota.test.ts —— saveHistory 写入失败路径的回归锁。
 *
 * 起因（2026-10-05 全面优化验证轮发现的真缺陷）：
 * 原实现的裁剪是 `keep = keep.slice(0, Math.max(1, keep.length - 1))`，恒保留 1 条，
 * 而放弃条件写的是 `if (!keep.length) return` —— **永不可达**。于是当「单条历史本身
 * 就超出 localStorage 配额」（正是 saveHistory 头部注释描述的长文场景）时，
 * 同一份写入会被无限重试，界面直接挂死。
 * 现修为 `if (keep.length <= 1) return` + `keep.slice(0, keep.length - 1)`，
 * 语义回到注释承诺的「全丢仍失败则静默放弃」。
 *
 * 本文件只盯这条路径：**任何一条断言变红，都说明挂死风险回来了**。
 * 与 store-history.test.ts（常规读写/去重/淘汰）分工，不重复断言。
 */
import { describe, it, expect, afterEach } from "vitest";
import { saveHistory, loadHistory, type HistoryEntry } from "./store-history.ts";

const K = "aihumanizer.history";

function entry(id: string): HistoryEntry {
  return {
    id,
    input: "原文" + id,
    output: "去味结果" + id,
    beforeScore: 60,
    afterScore: 5,
    intensity: 0.9,
    usedApi: false,
    timestamp: 1700000000000,
  };
}

/** 真实读写：模块加载时就绑好原方法（打桩期间也走它），以及打桩/还原助手。
 *  还原必须用 defineProperty 覆盖回去，不能 delete —— happy-dom 的 localStorage 是
 *  Proxy，Reflect.deleteProperty 对自己 defineProperty 出来的桩不生效（会泄漏到下个用例）。 */
const ORIG = {
  setItem: localStorage.setItem.bind(localStorage),
  getItem: localStorage.getItem.bind(localStorage),
};
const realSetItem = (k: string, v: string): void => ORIG.setItem(k, v);
function stub(name: "setItem" | "getItem", fn: (...a: never[]) => unknown): void {
  Object.defineProperty(localStorage, name, { value: fn, configurable: true, writable: true });
}
function unstub(name: "setItem" | "getItem"): void {
  Object.defineProperty(localStorage, name, { value: ORIG[name], configurable: true, writable: true });
}

afterEach(() => {
  unstub("setItem");
  unstub("getItem");
  localStorage.removeItem(K);
});

describe("saveHistory 写入失败路径（防挂死）", () => {
  it("setItem 永久抛错：有限次重试后静默放弃，绝不无限循环", () => {
    let calls = 0;
    stub("setItem", () => {
      calls++;
      throw new Error("QuotaExceededError");
    });

    const t0 = performance.now();
    expect(() => saveHistory(entry("a"))).not.toThrow();
    const dt = performance.now() - t0;

    // 旧实现：恒保留 1 条 ⇒ 同一份 payload 无限重试（本断言会超时而非失败）
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(10);
    expect(dt).toBeLessThan(1000); // 挂死是「秒级卡住」，不是慢
    expect(localStorage.getItem(K)).toBeNull(); // 放弃即不落盘
  });

  it("存量 12 条 + 本条 = 13 条预算：最多裁到 1 条（10 次）后放弃，次数有界", () => {
    const old = Array.from({ length: 12 }, (_, i) => entry("old" + i));
    realSetItem(K, JSON.stringify(old));

    let calls = 0;
    stub("setItem", () => {
      calls++;
      throw new Error("QuotaExceededError");
    });
    expect(() => saveHistory(entry("new"))).not.toThrow();
    expect(calls).toBe(10); // slice(0, MAX=10) 起步，逐条裁到只剩本条
  });

  it("第 1 次失败、第 2 次成功：只丢最旧的一条，新条目与较新条目都保住", () => {
    realSetItem(K, JSON.stringify([entry("old1"), entry("old2")]));

    let calls = 0;
    stub("setItem", (k: string, v: string) => {
      calls++;
      if (calls === 1) throw new Error("QuotaExceededError");
      realSetItem(k, v);
    });

    saveHistory(entry("new"));
    expect(calls).toBe(2); // 3 条 → 裁到 2 条即写成功

    const saved = JSON.parse(localStorage.getItem(K) ?? "[]") as HistoryEntry[];
    expect(saved.map((e) => e.id)).toEqual(["new", "old1"]); // 淘汰的是最旧的 old2
    expect(loadHistory()).toHaveLength(2);
  });

  it("只剩本条仍失败时立即返回：不重复写同一份 payload", () => {
    let calls = 0;
    stub("setItem", () => {
      calls++;
      throw new Error("QuotaExceededError");
    });
    saveHistory(entry("only"));
    // 1 条起步：call#1 失败 → keep.length<=1 → 放弃（旧实现此处继续死循环）
    expect(calls).toBe(1);
  });
});

describe("loadHistory 读取失败路径", () => {
  it("getItem 抛错 → 返回 []，异常不冒泡", () => {
    realSetItem(K, JSON.stringify([entry("x")]));
    stub("getItem", () => {
      throw new Error("SecurityError");
    });
    expect(loadHistory()).toEqual([]);
  });

  it("存量损坏（非 JSON）→ 返回 []；打桩还原后可正常读", () => {
    realSetItem(K, "{broken json");
    expect(loadHistory()).toEqual([]);
    realSetItem(K, JSON.stringify([entry("ok")]));
    expect(loadHistory().map((e) => e.id)).toEqual(["ok"]);
  });
});
