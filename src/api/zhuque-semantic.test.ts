// @vitest-environment happy-dom
/**
 * 朱雀语义层测试（v0.9.16 测试迭代第六轮）：
 *  - detectSemanticStable：缓存命中/绕过、模型签名隔离、交叉模型文案
 *  - semanticAvailable：Key 池口径
 *  - 语义缓存：50 条 LRU 淘汰、score 钳制、坏数据兜底
 *
 * judgeScoreStable（LLM 网关）整体 mock——本模块的职责是编排与缓存，不是推理。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectSemanticStable,
  semanticAvailable,
  loadSemanticCache,
  saveSemanticCache,
  ZHUQUE_DETECT_SYSTEM,
} from "./zhuque-semantic";
import { DEFAULT_API } from "./llm-config";
import type { ApiConfig } from "./llm-config";

const { judgeScoreStableMock } = vi.hoisted(() => ({ judgeScoreStableMock: vi.fn() }));

vi.mock("./llm-judge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llm-judge")>()),
  judgeScoreStable: judgeScoreStableMock,
}));

function cfg(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return { ...DEFAULT_API, enabled: true, apiKey: "sk-test-key", model: "m1", ...overrides };
}

const JUDGE_RET = { score: 42, critique: ["痕迹一", "痕迹二"] };

beforeEach(() => {
  localStorage.clear();
  judgeScoreStableMock.mockReset();
  judgeScoreStableMock.mockResolvedValue(JUDGE_RET);
});

describe("semanticAvailable（Key 池口径）", () => {
  it("enabled + 有 Key → true", () => {
    expect(semanticAvailable(cfg())).toBe(true);
  });

  it("未启用 → false；有 Key 但未启用也算 false", () => {
    expect(semanticAvailable(cfg({ enabled: false }))).toBe(false);
  });

  it("启用但无任何 Key → false", () => {
    expect(semanticAvailable(cfg({ apiKey: "", apiKeys: "" }))).toBe(false);
  });
});

describe("detectSemanticStable（编排与缓存）", () => {
  it("首次检测：调 LLM 并透传朱雀检测员提示词，source 标注单模型中位数口径", async () => {
    const text = "一段用来检测的文本。";
    const r = await detectSemanticStable(text, cfg());
    expect(judgeScoreStableMock).toHaveBeenCalledTimes(1);
    expect(judgeScoreStableMock).toHaveBeenCalledWith(
      text,
      expect.anything(),
      3,
      ZHUQUE_DETECT_SYSTEM,
    );
    expect(r.score).toBe(42);
    expect(r.critique).toEqual(["痕迹一", "痕迹二"]);
    expect(r.source).toContain("3 次取中位数");
    expect(r.source).not.toContain("缓存");
  });

  it("同文本同配置第二次：命中缓存不再烧 API，source 带（缓存）标记", async () => {
    const text = "缓存命中的文本。";
    await detectSemanticStable(text, cfg());
    const r2 = await detectSemanticStable(text, cfg());
    expect(judgeScoreStableMock).toHaveBeenCalledTimes(1);
    expect(r2.score).toBe(42);
    expect(r2.source).toContain("（缓存）");
  });

  it("bypassCache=true 强制真跑（重跑语义层按钮路径）", async () => {
    const text = "强制重跑的文本。";
    await detectSemanticStable(text, cfg());
    await detectSemanticStable(text, cfg(), { bypassCache: true });
    expect(judgeScoreStableMock).toHaveBeenCalledTimes(2);
  });

  it("换主模型视为不同评分：缓存绝不串味", async () => {
    const text = "换模型签名的文本。";
    await detectSemanticStable(text, cfg({ model: "m1" }));
    await detectSemanticStable(text, cfg({ model: "m2" }));
    expect(judgeScoreStableMock).toHaveBeenCalledTimes(2);
  });

  it("配置交叉评判模型：source 标注「交叉取均值」", async () => {
    const r = await detectSemanticStable("交叉模型的文本。", cfg({ judgeModel: "m-judge" }));
    expect(r.source).toContain("交叉取均值");
    expect(r.source).toContain("m-judge");
  });

  it("judgeModel 与主模型相同：不算交叉（单模型中位数口径）", async () => {
    const r = await detectSemanticStable("同模型评判的文本。", cfg({ judgeModel: "m1" }));
    expect(r.source).not.toContain("交叉");
  });
});

describe("语义缓存（50 条 LRU 与钳制）", () => {
  it("写入后可读回，score 钳制到 [0,100]", () => {
    const c = cfg();
    saveSemanticCache("超上限文本。", c, { score: 150, critique: [], source: "x" });
    const hit = loadSemanticCache("超上限文本。", c);
    expect(hit?.score).toBe(100);
    saveSemanticCache("负分文本。", c, { score: -5, critique: [], source: "x" });
    expect(loadSemanticCache("负分文本。", c)?.score).toBe(0);
  });

  it("score 非有限值的脏数据按未命中处理", () => {
    const c = cfg();
    localStorage.setItem(
      "quaiwei.zhuque.semcache",
      JSON.stringify({ badkey: { score: Number.NaN, critique: [], source: "x", ts: 1 } }),
    );
    // 直接按同 key 文本查不到（key 由指纹+模型签名生成），此处只验证坏条目不炸
    expect(loadSemanticCache("不存在的文本。", c)).toBeNull();
  });

  it("50 条上限：最旧出局、最新保留", () => {
    const c = cfg();
    for (let i = 0; i < 51; i++) {
      saveSemanticCache(`淘汰测试文本第${i}号。`, c, { score: i, critique: [], source: "x" });
    }
    expect(loadSemanticCache("淘汰测试文本第0号。", c)).toBeNull(); // 最旧出局
    expect(loadSemanticCache("淘汰测试文本第50号。", c)?.score).toBe(50); // 最新保留
  });

  it("模型签名参与缓存键：同文本不同模型互不覆盖", () => {
    const text = "签名隔离文本。";
    saveSemanticCache(text, cfg({ model: "m1" }), { score: 10, critique: [], source: "a" });
    saveSemanticCache(text, cfg({ model: "m2" }), { score: 90, critique: [], source: "b" });
    expect(loadSemanticCache(text, cfg({ model: "m1" }))?.score).toBe(10);
    expect(loadSemanticCache(text, cfg({ model: "m2" }))?.score).toBe(90);
  });

  /* 2026-10-05 分支补测：readSemanticCache 的兜底与 load/save 的 ?? 右支此前从未被走到。 */
  const SEM_KEY = "quaiwei.zhuque.semcache"; // 与源码 K_SEM_CACHE 同值（存储键，非私有逻辑）

  it("缓存值不是普通对象（数组 / null / 原始值）→ 按空缓存处理（行 92 false 与行 98）", () => {
    const c = cfg();
    for (const bad of [JSON.stringify([{ score: 1, ts: 1 }]), "null", "42", '"字符串"']) {
      localStorage.setItem(SEM_KEY, bad);
      expect(loadSemanticCache(`脏缓存文本${bad.length}号。`, c), bad).toBeNull();
    }
    // JSON 都解析不出来的直接进 catch，同样落到行 98
    localStorage.setItem(SEM_KEY, "{不是 json");
    expect(loadSemanticCache("坏 JSON 文本。", c)).toBeNull();
  });

  it("旧版条目缺 critique / source → 默认空数组与空串（行 106/107 的 ?? 右支）", () => {
    const c = cfg();
    saveSemanticCache("缺字段文本。", c, { score: 42, critique: ["x"], source: "s" });
    const raw = JSON.parse(localStorage.getItem(SEM_KEY) ?? "{}") as Record<
      string,
      Record<string, unknown>
    >;
    for (const k of Object.keys(raw)) {
      delete raw[k].critique;
      delete raw[k].source;
    }
    localStorage.setItem(SEM_KEY, JSON.stringify(raw));

    const hit = loadSemanticCache("缺字段文本。", c);
    expect(hit?.score).toBe(42);
    expect(hit?.critique).toEqual([]);
    expect(hit?.source).toBe("");
  });

  it("条目缺 ts → 排序用 0 兜底，不炸且新条目照常保留（行 117 的 ?? 0）", () => {
    const c = cfg();
    saveSemanticCache("无时间戳文本。", c, { score: 7, critique: [], source: "s" });
    const raw = JSON.parse(localStorage.getItem(SEM_KEY) ?? "{}") as Record<
      string,
      Record<string, unknown>
    >;
    for (const k of Object.keys(raw)) delete raw[k].ts;
    localStorage.setItem(SEM_KEY, JSON.stringify(raw));

    saveSemanticCache("新条目文本。", c, { score: 8, critique: [], source: "s" });
    expect(loadSemanticCache("无时间戳文本。", c)?.score).toBe(7); // 无 ts 那条按 0 排最前，仍保留
    expect(loadSemanticCache("新条目文本。", c)?.score).toBe(8);

    // 比较器两侧都要走到：把「有 ts」的排到「无 ts」之前，再存第三条触发排序，
    // 这样 a[1].ts ?? 0（左，无 ts 作 a）与 b[1].ts ?? 0（右，无 ts 作 b）两个兜底臂都被执行
    const cur = JSON.parse(localStorage.getItem(SEM_KEY) ?? "{}") as Record<
      string,
      Record<string, unknown>
    >;
    const ordered: Record<string, Record<string, unknown>> = {};
    for (const k of Object.keys(cur)) if (typeof cur[k].ts === "number") ordered[k] = cur[k];
    for (const k of Object.keys(cur)) if (typeof cur[k].ts !== "number") ordered[k] = cur[k];
    localStorage.setItem(SEM_KEY, JSON.stringify(ordered));

    saveSemanticCache("第三条文本。", c, { score: 9, critique: [], source: "s" });
    expect(loadSemanticCache("无时间戳文本。", c)?.score).toBe(7);
    expect(loadSemanticCache("第三条文本。", c)?.score).toBe(9);
  });
});
