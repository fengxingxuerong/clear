// @vitest-environment happy-dom
/**
 * store-history 历史存储边界（v0.9.16 长尾清扫）：
 *  - loadHistory 对坏 JSON / 非数组 / 超上限的三种兜底
 *  - saveHistory 的 10 条上限淘汰与配额溢出逐条裁剪（只剩本条也写不下则放弃）
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  loadHistory,
  saveHistory,
  clearHistory,
  makeHistoryEntry,
  type HistoryEntry,
} from "./store-history";
import { aiScore } from "./engine/humanize";

function entry(n: number): HistoryEntry {
  return makeHistoryEntry(`原文${n}`, `产出${n}`, aiScore(`原文${n}`), aiScore(`产出${n}`), 0.6, false);
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadHistory 兜底", () => {
  it("空存储返回空数组", () => {
    expect(loadHistory()).toEqual([]);
  });

  it("坏 JSON 返回空数组不抛错", () => {
    localStorage.setItem("aihumanizer.history", "{not valid json");
    expect(loadHistory()).toEqual([]);
  });

  it("JSON 是数组以外的类型返回空数组", () => {
    localStorage.setItem("aihumanizer.history", JSON.stringify({ not: "array" }));
    expect(loadHistory()).toEqual([]);
  });

  it("超过 10 条上限截断到最新 10 条", () => {
    for (let i = 0; i < 13; i++) saveHistory(entry(i));
    const list = loadHistory();
    expect(list).toHaveLength(10);
    expect(list[0].input).toBe("原文12"); // 最新在头部
    expect(list[9].input).toBe("原文3"); // 最旧 3 条出局
  });
});

describe("saveHistory 写入与配额溢出", () => {
  it("正常保存一条", () => {
    saveHistory(entry(1));
    expect(loadHistory()).toHaveLength(1);
  });

  function breakSetItem() {
    const orig = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    return () => {
      window.localStorage.setItem = orig;
    };
  }

  it("配额溢出且历史多条：逐条裁剪重试，不抛错", () => {
    for (let i = 0; i < 5; i++) saveHistory(entry(i));
    const restore = breakSetItem();
    try {
      expect(() => saveHistory(entry(99))).not.toThrow();
    } finally {
      restore();
    }
  });

  it("配额溢出且只剩本条也写不下：放弃持久化，不抛错", () => {
    const restore = breakSetItem();
    try {
      expect(() => saveHistory(entry(1))).not.toThrow();
    } finally {
      restore();
    }
  });
});

describe("clearHistory", () => {
  it("清空后为空数组", () => {
    saveHistory(entry(1));
    saveHistory(entry(2));
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});
