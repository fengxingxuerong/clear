import { describe, it, expect, beforeAll } from "vitest";
import { textHash, loadSemanticCache, saveSemanticCache } from "./zhuque-semantic";
import type { ApiConfig } from "./llm-config";

// 语义层缓存在函数调用时才触碰 localStorage，node 环境下先打桩
const store = new Map<string, string>();
beforeAll(() => {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

const cfg: ApiConfig = {
  enabled: true,
  baseUrl: "/x/v1",
  apiKey: "k",
  model: "m1",
  temperature: 0.9,
  deepMode: false,
  judgeModel: "j1",
  altModel: "",
  style: "casual",
};

const sem = { score: 88, critique: ["论点骨架工整"], source: "朱雀检测员提示词 · m1" };

describe("textHash（FNV-1a 文本指纹）", () => {
  it("同文本哈希稳定，异文本哈希不同", () => {
    const a = "值得注意的是，人工智能正在改变世界。";
    expect(textHash(a)).toBe(textHash(a));
    expect(textHash(a)).not.toBe(textHash(a + "。"));
  });

  it("带长度后缀，不同长度不同键", () => {
    expect(textHash("abc")).not.toBe(textHash("abcd"));
    expect(textHash("")).toBe(textHash(""));
  });
});

describe("语义层缓存", () => {
  it("存取回环：同文本同模型命中", () => {
    saveSemanticCache("测试文本一", cfg, sem);
    const hit = loadSemanticCache("测试文本一", cfg);
    expect(hit).not.toBeNull();
    expect(hit!.score).toBe(88);
    expect(hit!.critique).toEqual(["论点骨架工整"]);
  });

  it("换主模型 / 换评判模型即视为不同键（不串味）", () => {
    saveSemanticCache("测试文本二", cfg, sem);
    expect(loadSemanticCache("测试文本二", { ...cfg, model: "m2" })).toBeNull();
    expect(loadSemanticCache("测试文本二", { ...cfg, judgeModel: "j2" })).toBeNull();
    expect(loadSemanticCache("测试文本二", cfg)).not.toBeNull();
  });

  it("分数越界与坏数据不命中", () => {
    saveSemanticCache("坏分数文本", cfg, { score: 150, critique: [], source: "s" });
    expect(loadSemanticCache("坏分数文本", cfg)!.score).toBe(100); // 夹取而非信任
    const raw = JSON.parse(store.get("quaiwei.zhuque.semcache")!);
    raw[textHash("损坏条目") + "|m1|j1"] = { score: "not-a-number" };
    store.set("quaiwei.zhuque.semcache", JSON.stringify(raw));
    expect(loadSemanticCache("损坏条目", cfg)).toBeNull();
  });

  it("上限 50 条按时间淘汰最旧", () => {
    for (let i = 0; i < 55; i++) {
      saveSemanticCache(`淘汰测试文本-${i}`, cfg, { score: i, critique: [], source: "s" });
    }
    const raw = JSON.parse(store.get("quaiwei.zhuque.semcache")!);
    expect(Object.keys(raw).length).toBe(50);
    expect(loadSemanticCache("淘汰测试文本-0", cfg)).toBeNull(); // 最旧被淘汰
    expect(loadSemanticCache("淘汰测试文本-54", cfg)).not.toBeNull();
  });
});
