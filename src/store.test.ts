/**
 * store.ts 单元测试：localStorage 配置持久化 + 逐字段校验 + Electron safeStore 桥接。
 * happy-dom 环境提供 localStorage 与 window。
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadApi,
  saveApi,
  loadDetector,
  saveDetector,
  loadIntensity,
  saveIntensity,
  loadZhuqueMode,
  saveZhuqueMode,
  loadPplEnabled,
  savePplEnabled,
  loadFuseWeight,
  saveFuseWeight,
  loadLocal,
  saveLocal,
  hasSecureStore,
  loadApiKeySecure,
  saveApiKeySecure,
  loadDetectorKeySecure,
  saveDetectorKeySecure,
  DEFAULT_LOCAL,
} from "./store";
import { DEFAULT_API } from "./api/llm-config";
import { DEFAULT_DETECTOR } from "./api/detector";
import { DEFAULT_SEMANTIC_WEIGHT } from "./engine/zhuque";

beforeEach(() => {
  localStorage.clear();
});

describe("loadApi / saveApi（逐字段清洗）", () => {
  it("空库返回默认配置（深拷贝，不共享引用）", () => {
    const a = loadApi();
    const b = loadApi();
    expect(a).toEqual(DEFAULT_API);
    expect(a).not.toBe(b);
  });

  it("save → load 往返一致", () => {
    const cfg = {
      ...DEFAULT_API,
      enabled: true,
      baseUrl: "/sensenova/v1",
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
      temperature: 0.5,
      deepMode: false,
      judgeModel: "glm-5.2",
      altModel: "deepseek-v4-pro",
      style: "academic" as const,
      reasoningEffort: "high" as const,
      maxWaitSeconds: 120,
      maxApiCalls: 20,
    };
    saveApi(cfg);
    expect(loadApi()).toEqual(cfg);
  });

  /**
   * v0.9.5 回归守卫：此前 DEFAULT_API 与 loadApi 各自漏掉字段时，
   * 「往返一致」用例抓不到——因为 cfg 是 `{...DEFAULT_API}` 展开的，
   * 缺失字段在两边都是 undefined，而 toEqual 又忽略 undefined 属性。
   * 该模式已让漏读三次溜进发布（apiKeys / contestSamples / strictFidelity+persona）。
   * 这里改用「每个字段都设成非默认值 + 逐字段严格比对」来钉死。
   */
  it("DEFAULT_API 声明的每个字段都能被 loadApi 读回（防白名单漏读复发）", () => {
    const probe = {
      enabled: true,
      baseUrl: "https://probe.invalid/v1",
      apiKey: "sk-probe",
      apiKeys: "sk-pool-a\nsk-pool-b",
      model: "probe-model",
      temperature: 0.42,
      deepMode: false,
      judgeModel: "probe-judge",
      altModel: "probe-alt",
      style: "academic" as const,
      reasoningEffort: "high" as const,
      maxWaitSeconds: 77,
      maxApiCalls: 33,
      contestSamples: 3,
      strictFidelity: true,
      persona: "netgen" as const,
    };
    saveApi(probe);
    const back = loadApi();

    // 逐字段严格比对：漏读的字段会回退成默认值，当场暴露
    for (const k of Object.keys(probe) as (keyof typeof probe)[]) {
      expect(back[k], `字段 ${String(k)} 未被 loadApi 读回（白名单漏读）`).toBe(probe[k]);
    }

    // 反向守卫：DEFAULT_API 将来新增字段时，若忘了同步 loadApi，本断言会红
    const missing = Object.keys(DEFAULT_API).filter((k) => !(k in back));
    expect(missing, `loadApi 未覆盖 DEFAULT_API 的字段：${missing.join(", ")}`).toEqual([]);
  });

  it("非法字段逐个回退默认：温度非有限数、style 越界、reasoningEffort 越界、负预算", () => {
    localStorage.setItem(
      "aihumanizer.api",
      JSON.stringify({
        enabled: true,
        temperature: "0.9", // 字符串 → 默认
        style: "poetry", // 越界 → 默认 casual
        reasoningEffort: "ultra", // 越界 → undefined
        maxWaitSeconds: -5, // 负数 → 0
        maxApiCalls: -1, // 负数 → 0
      }),
    );
    const cfg = loadApi();
    expect(cfg.temperature).toBe(DEFAULT_API.temperature);
    expect(cfg.style).toBe(DEFAULT_API.style);
    expect(cfg.reasoningEffort).toBeUndefined();
    expect(cfg.maxWaitSeconds).toBe(0);
    expect(cfg.maxApiCalls).toBe(0);
  });

  it("JSON 坏数据 / 数组 / 基本类型按缺失处理返回默认", () => {
    localStorage.setItem("aihumanizer.api", "{oops");
    expect(loadApi()).toEqual(DEFAULT_API);
    localStorage.setItem("aihumanizer.api", "[1,2]");
    expect(loadApi()).toEqual(DEFAULT_API);
    localStorage.setItem("aihumanizer.api", "42");
    expect(loadApi()).toEqual(DEFAULT_API);
  });

  it("apiKeys 字段透传（Key 池）", () => {
    saveApi({ ...DEFAULT_API, apiKeys: "k1\nk2, k3" });
    expect(loadApi().apiKeys).toBe("k1\nk2, k3");
  });
});

// v0.9：loadApi 是逐字段白名单解析，新增字段漏读会导致刷新后配置静默丢失
//（v0.8.7 的 apiKeys 就踩过这个坑）
it("contestSamples 持久化并做范围收敛", () => {
  saveApi({ ...DEFAULT_API, contestSamples: 3 });
  expect(loadApi().contestSamples).toBe(3);

  localStorage.setItem("aihumanizer.api", JSON.stringify({ ...DEFAULT_API, contestSamples: 99 }));
  expect(loadApi().contestSamples).toBe(5); // 上限 5，防手改配置炸掉调用预算

  localStorage.setItem("aihumanizer.api", JSON.stringify({ ...DEFAULT_API, contestSamples: 0 }));
  expect(loadApi().contestSamples).toBe(1); // 非法值回落默认
});

describe("loadDetector / saveDetector", () => {
  it("空库返回默认；往返一致", () => {
    expect(loadDetector()).toEqual(DEFAULT_DETECTOR);
    const cfg = {
      ...DEFAULT_DETECTOR,
      enabled: true,
      url: "https://x/api",
      scorePath: "p",
      scale: "0-1" as const,
    };
    saveDetector(cfg);
    expect(loadDetector()).toEqual(cfg);
  });

  it("scale 越界回退 0-100", () => {
    localStorage.setItem("aihumanizer.detector", JSON.stringify({ scale: "0-5" }));
    expect(loadDetector().scale).toBe("0-100");
  });
});

describe("强度 / 朱雀模式 / 困惑度开关 / 融合权重 / 本地设置", () => {
  it("强度：默认 0.6，保存后读回，越界夹取 0~1", () => {
    expect(loadIntensity()).toBe(0.6);
    saveIntensity(0.85);
    expect(loadIntensity()).toBe(0.85);
    saveIntensity(1.5);
    expect(loadIntensity()).toBe(1);
    saveIntensity(-0.2);
    expect(loadIntensity()).toBe(0);
  });

  it("朱雀模式：默认 false，true 正常往返", () => {
    expect(loadZhuqueMode()).toBe(false);
    saveZhuqueMode(true);
    expect(loadZhuqueMode()).toBe(true);
  });

  it("困惑度开关：默认开（无值 !== 'false'），保存关闭后读回 false", () => {
    expect(loadPplEnabled()).toBe(true);
    savePplEnabled(false);
    expect(loadPplEnabled()).toBe(false);
  });

  it("融合权重：默认 DEFAULT_SEMANTIC_WEIGHT，越界夹取 0~1", () => {
    expect(loadFuseWeight()).toBe(DEFAULT_SEMANTIC_WEIGHT);
    saveFuseWeight(0.7);
    expect(loadFuseWeight()).toBe(0.7);
    saveFuseWeight(2);
    expect(loadFuseWeight()).toBe(1);
    saveFuseWeight(-1);
    expect(loadFuseWeight()).toBe(0);
  });

  it("本地设置：默认 bestOf=true/8 候选，candidates 夹取 1~30", () => {
    expect(loadLocal()).toEqual(DEFAULT_LOCAL);
    saveLocal({ bestOf: false, candidates: 99 });
    expect(loadLocal()).toEqual({ bestOf: false, candidates: 30 });
    saveLocal({ bestOf: true, candidates: 0 });
    expect(loadLocal().candidates).toBe(1);
  });
});

describe("Electron secureStore 桥接", () => {
  it("Web 版（无 secureStore）：hasSecureStore=false，读返回 undefined，写静默跳过", async () => {
    expect(hasSecureStore()).toBe(false);
    expect(await loadApiKeySecure()).toBeUndefined();
    expect(await loadDetectorKeySecure()).toBeUndefined();
    await expect(saveApiKeySecure("sk-x")).resolves.toBeUndefined();
    await expect(saveDetectorKeySecure("sk-y")).resolves.toBeUndefined();
  });

  it("Electron 版（挂 secureStore 桥）：读写走桥接", async () => {
    const store = new Map<string, string | null>();
    (window as unknown as { secureStore: unknown }).secureStore = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string | null) => (store.set(k, v), true),
    };
    try {
      expect(hasSecureStore()).toBe(true);
      await saveApiKeySecure("sk-main");
      await saveDetectorKeySecure("sk-det");
      expect(await loadApiKeySecure()).toBe("sk-main");
      expect(await loadDetectorKeySecure()).toBe("sk-det");
      // 空值清除
      await saveApiKeySecure("");
      expect(store.get("apiKey")).toBeNull();
    } finally {
      delete (window as unknown as { secureStore?: unknown }).secureStore;
    }
  });

  it("secureStore.get 抛错时静默回退 undefined（不崩主流程）", async () => {
    (window as unknown as { secureStore: unknown }).secureStore = {
      get: async () => {
        throw new Error("bridge broken");
      },
      set: async () => true,
    };
    try {
      expect(await loadApiKeySecure()).toBeUndefined();
      expect(await loadDetectorKeySecure()).toBeUndefined();
    } finally {
      delete (window as unknown as { secureStore?: unknown }).secureStore;
    }
  });
});
