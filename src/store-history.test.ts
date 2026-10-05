// @vitest-environment happy-dom
/**
 * store-history 历史存储边界（v0.9.16 长尾清扫 + 配额分支补盲）：
 *  - loadHistory 对坏 JSON / 非数组 / getItem 抛错 / 字段缺失记录的兜底
 *  - saveHistory 的 10 条淘汰边界（恰好 10 条 / 第 11 条才淘汰）与同 id 去重
 *  - 配额溢出逐条裁剪（defineProperty 桩才真生效：happy-dom Storage 是 Proxy，
 *    直接赋值会被 set 陷阱静默丢弃）、只剩本条写不下则放弃、
 *    永久失败的有限次重试回归锁（防 `keep.length <= 1` 条件被改回永假死循环）
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

/** 替换 localStorage 的方法并返回还原函数。
 *  happy-dom 的 localStorage 是 Proxy：`ls.setItem = fn` 会被 set 陷阱静默丢弃
 *  （旧配额桩因此从未生效、catch 分支一直没被测到），必须走 defineProperty 才能真正换掉。 */
function mockStorageMethod(
  name: "getItem" | "setItem",
  factory: (original: (...args: any[]) => any) => (...args: any[]) => any,
): () => void {
  const original: (...args: any[]) => any = (localStorage as any)[name];
  Object.defineProperty(localStorage, name, {
    value: factory(original),
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(localStorage, name, { value: original, configurable: true, writable: true });
  };
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

describe("容错与边界补测（配额分支补盲）", () => {
  it("localStorage.getItem 抛错（存储被禁用/隐私模式）返回空数组不抛错", () => {
    const restore = mockStorageMethod("getItem", () => () => {
      throw new Error("SecurityError: storage disabled");
    });
    try {
      expect(loadHistory()).toEqual([]);
    } finally {
      restore();
    }
    // 桩回收后读写恢复正常，不污染后续用例
    saveHistory(entry(7));
    expect(loadHistory()).toHaveLength(1);
  });

  it("字段缺失的旧记录原样透传（store 不做字段校验，容错交给消费方）", () => {
    localStorage.setItem("aihumanizer.history", JSON.stringify([{ id: "old", input: "缺字段" }]));
    const list = loadHistory();
    expect(list).toHaveLength(1);
    expect(list[0].input).toBe("缺字段");
    expect("engine" in list[0]).toBe(false);
    expect("timestamp" in list[0]).toBe(false);
  });

  it("相同 id 重复保存：旧条目去重回队首，不产生重复记录", () => {
    const a = entry(1);
    const b = entry(2);
    saveHistory(a);
    saveHistory(b);
    saveHistory({ ...a, input: "原文1改写稿" }); // 同 id 再存（新一轮产出）
    const list = loadHistory();
    expect(list).toHaveLength(2);
    expect(list.filter((e) => e.id === a.id)).toHaveLength(1);
    expect(list[0].id).toBe(a.id);
    expect(list[0].input).toBe("原文1改写稿");
    expect(list[1].input).toBe("原文2");
  });

  it("恰好 10 条全部保留；第 11 条才淘汰最旧一条（边界值）", () => {
    for (let i = 0; i < 10; i++) saveHistory(entry(i));
    let list = loadHistory();
    expect(list).toHaveLength(10);
    expect(list[9].input).toBe("原文0"); // 满额但未超额：最旧的仍在
    saveHistory(entry(10));
    list = loadHistory();
    expect(list).toHaveLength(10);
    expect(list[0].input).toBe("原文10");
    expect(list.some((e) => e.input === "原文0")).toBe(false); // 第 11 条触发淘汰
  });
});

describe("saveHistory 写入与配额溢出", () => {
  it("正常保存一条", () => {
    saveHistory(entry(1));
    expect(loadHistory()).toHaveLength(1);
  });

  /** 配额桩（defineProperty 真生效版）：前 failCalls 次 setItem 必抛配额错，
   *  之后放行原实现——重试循环必然有限次收尾，绝不挂死测试。 */
  function breakSetItem(failCalls = 2) {
    let failed = 0;
    return mockStorageMethod("setItem", (orig) => (...args) => {
      if (failed < failCalls) {
        failed++;
        throw new Error("QuotaExceededError");
      }
      return orig(...args);
    });
  }

  it("配额溢出且历史多条：逐条裁剪重试，不抛错", () => {
    for (let i = 0; i < 5; i++) saveHistory(entry(i));
    const restore = breakSetItem();
    try {
      expect(() => saveHistory(entry(99))).not.toThrow();
    } finally {
      restore();
    }
    // 桩真实生效：6 条载荷被拒 2 次、每次裁 1 条，第 3 次以 4 条的更小载荷落盘
    const list = loadHistory();
    expect(list).toHaveLength(4);
    expect(list[0].input).toBe("原文99");
  });

  it("配额溢出且只剩本条也写不下：放弃持久化，不抛错", () => {
    const restore = breakSetItem();
    try {
      expect(() => saveHistory(entry(1))).not.toThrow();
    } finally {
      restore();
    }
    // 裁到只剩本条仍写不下 → 立即放弃：库里保持为空，不落半截数据
    expect(loadHistory()).toEqual([]);
  });

  it("永久失败回归锁：setItem 每次必抛时有限次裁剪后放弃（绝不无限重试）", () => {
    for (let i = 0; i < 3; i++) saveHistory(entry(i)); // 先铺 3 条正常数据
    let calls = 0;
    const restore = mockStorageMethod("setItem", (orig) => (...args) => {
      calls++;
      // 保险阀：即便源码回归成死循环，也在第 101 次放行原实现收尾——
      // 断言随之变红，而不是挂死整个测试套件
      if (calls <= 100) throw new Error("QuotaExceededError");
      return orig(...args);
    });
    try {
      expect(() => saveHistory(entry(99))).not.toThrow();
    } finally {
      restore();
    }
    // 载荷 4 条（3 旧 + 1 新）：每失败一次裁 1 条，裁到只剩本条仍失败 → 立即放弃。
    // 恰好 4 次 = 进入循环时的载荷条数，证明同一份写入不会被无限重试
    expect(calls).toBe(4);
    expect(calls).toBeLessThanOrEqual(10);
    // 放弃持久化：旧数据原样保留，新条目没写进去
    const list = loadHistory();
    expect(list).toHaveLength(3);
    expect(list.some((e) => e.input === "原文99")).toBe(false);
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
