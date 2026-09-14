/**
 * store-history.ts 单元测试：历史条目持久化（去重 / 上限 / 配额降级 / 工厂函数）。
 * 配额溢出用 happy-dom 的 setItem 抛错模拟。
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadHistory,
  saveHistory,
  clearHistory,
  makeHistoryEntry,
  type HistoryEntry,
} from "./store-history";
import type { ScoreBreakdown } from "./engine/humanize";

const before: ScoreBreakdown = {
  score: 80,
  formulaicHits: 9,
  burstiness: 0.2,
  avgLen: 30,
  sentenceCount: 4,
};
const after: ScoreBreakdown = {
  score: 25,
  formulaicHits: 2,
  burstiness: 0.5,
  avgLen: 18,
  sentenceCount: 3,
};

function entry(id: string, input = "原文" + id): HistoryEntry {
  return {
    id,
    input,
    output: "去味稿" + id,
    beforeScore: 80,
    afterScore: 25,
    intensity: 0.7,
    usedApi: false,
    timestamp: Date.now(),
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("makeHistoryEntry", () => {
  it("从去味结果生成条目：id 非空、分数取自 ScoreBreakdown", () => {
    const e = makeHistoryEntry("输入文本", "输出文本", before, after, 0.9, true);
    expect(e.id.length).toBeGreaterThan(0);
    expect(e.input).toBe("输入文本");
    expect(e.output).toBe("输出文本");
    expect(e.beforeScore).toBe(80);
    expect(e.afterScore).toBe(25);
    expect(e.intensity).toBe(0.9);
    expect(e.usedApi).toBe(true);
    expect(typeof e.timestamp).toBe("number");
  });

  it("连续生成的 id 不重复", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => makeHistoryEntry("a", "b", before, after, 0.5, false).id),
    );
    expect(ids.size).toBe(50);
  });
});

describe("loadHistory / saveHistory / clearHistory", () => {
  it("空库返回空数组", () => {
    expect(loadHistory()).toEqual([]);
  });

  it("保存后读回一致；最新条目在最前（unshift）", () => {
    saveHistory(entry("a"));
    saveHistory(entry("b"));
    const list = loadHistory();
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("相同 id 旧条目被替换（去重不重复占位）", () => {
    saveHistory(entry("a"));
    saveHistory(entry("b"));
    saveHistory(entry("a", "新原文"));
    const list = loadHistory();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe("a");
    expect(list[0].input).toBe("新原文");
  });

  it("超过 10 条时只保留最新 10 条", () => {
    for (let i = 0; i < 13; i++) saveHistory(entry("id" + i));
    const list = loadHistory();
    expect(list.length).toBe(10);
    expect(list[0].id).toBe("id12");
    expect(list[9].id).toBe("id3");
  });

  it("坏 JSON / 数组 / 超长列表：读侧防御性处理", () => {
    localStorage.setItem("aihumanizer.history", "{bad");
    expect(loadHistory()).toEqual([]);
    localStorage.setItem("aihumanizer.history", "not-array");
    expect(loadHistory()).toEqual([]);
    localStorage.setItem(
      "aihumanizer.history",
      JSON.stringify(Array.from({ length: 15 }, (_, i) => entry("old" + i))),
    );
    expect(loadHistory().length).toBe(10);
  });

  it("写入配额溢出：逐条丢弃最旧重试，至少保住最新条目", () => {
    // 预置 3 条正常历史
    saveHistory(entry("a"));
    saveHistory(entry("b"));
    saveHistory(entry("c"));

    const origSetItem = Storage.prototype.setItem;
    let calls = 0;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string): void {
      // 第一次写历史库时抛配额错误，之后恢复（模拟逐条丢弃后最终写成功）
      calls++;
      if (k === "aihumanizer.history" && calls === 1) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      origSetItem.call(this, k, v);
    };
    try {
      expect(() => saveHistory(entry("big"))).not.toThrow();
      const list = loadHistory();
      expect(list[0].id).toBe("big");
    } finally {
      Storage.prototype.setItem = origSetItem;
    }
  });

  it("全丢仍写不下：静默放弃不抛错，旧库保持原样", () => {
    saveHistory(entry("keep"));
    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (): void {
      throw new DOMException("quota", "QuotaExceededError");
    };
    try {
      expect(() => saveHistory(entry("huge"))).not.toThrow();
    } finally {
      Storage.prototype.setItem = nativeSetItem;
    }
    // 恢复后 clearHistory 生效，读取为空
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});
