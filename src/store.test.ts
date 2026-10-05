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
  loadProtectedTerms,
  saveProtectedTerms,
  parseProtectedTerms,
  hasSecureStore,
  loadApiKeySecure,
  saveApiKeySecure,
  loadApiKeysSecure,
  saveApiKeysSecure,
  loadDetectorKeySecure,
  saveDetectorKeySecure,
  adoptSecureApiKeys,
  persistApiConfig,
  DEFAULT_LOCAL,
  loadDraft,
  saveDraft,
} from "./store";
import { DEFAULT_API, effectiveKeys } from "./api/llm-config";
import { DEFAULT_DETECTOR } from "./api/detector";
import { DEFAULT_SEMANTIC_WEIGHT } from "./engine/zhuque";

beforeEach(() => {
  localStorage.clear();
});

describe("自定义保护术语持久化（v0.9.15）", () => {
  it("空库返回空串，不返回 undefined", () => {
    expect(loadProtectedTerms()).toBe("");
  });

  it("存取往返一致", () => {
    saveProtectedTerms("量子跃迁式改革\n张三丰算法");
    expect(loadProtectedTerms()).toBe("量子跃迁式改革\n张三丰算法");
  });

  it("切词：换行/半角逗号分号/全角逗号分号，去空白去重，丢弃单字", () => {
    expect(parseProtectedTerms("量子跃迁\n张三丰，算法；算法 、 我的产品")).toEqual([
      "量子跃迁",
      "张三丰",
      "算法",
      "我的产品",
    ]);
    // 单字不保护：单字命中率太高，会把正常改写全挡掉（空格不是分隔符，故用逗号隔开单字）
    expect(parseProtectedTerms("a，算法，b")).toEqual(["算法"]);
  });
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
  it("Web 版（无 secureStore）：hasSecureStore=false，读返回 undefined，写返回 false 且不抛", async () => {
    expect(hasSecureStore()).toBe(false);
    expect(await loadApiKeySecure()).toBeUndefined();
    expect(await loadApiKeysSecure()).toBeUndefined();
    expect(await loadDetectorKeySecure()).toBeUndefined();
    await expect(saveApiKeySecure("sk-x")).resolves.toBe(false);
    await expect(saveApiKeysSecure("sk-y")).resolves.toBe(false);
    await expect(saveDetectorKeySecure("sk-z")).resolves.toBe(false);
  });

  it("Electron 版（挂 secureStore 桥）：读写走桥接", async () => {
    const store = bridge();
    try {
      expect(hasSecureStore()).toBe(true);
      await saveApiKeySecure("sk-main");
      await saveApiKeysSecure("sk-pool-1\nsk-pool-2");
      await saveDetectorKeySecure("sk-det");
      expect(await loadApiKeySecure()).toBe("sk-main");
      expect(await loadApiKeysSecure()).toBe("sk-pool-1\nsk-pool-2");
      expect(await loadDetectorKeySecure()).toBe("sk-det");
      // 空值清除
      await saveApiKeySecure("");
      expect(store.get("apiKey")).toBeNull();
    } finally {
      unbridge();
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
      expect(await loadApiKeysSecure()).toBeUndefined();
      expect(await loadDetectorKeySecure()).toBeUndefined();
    } finally {
      unbridge();
    }
  });
});

/* ────────── Key 池明文泄漏（v0.9.14 修复）的回归锁 ──────────
 * 修复前：桌面版加密通道只覆盖 apiKey，Key 池 apiKeys 被 saveApi 明文写进 localStorage，
 * 而 loadApi 又会把它读回来——于是唯一承载多个可用 Key 的字段绕开了整条 safeStorage。
 * 下面这组断言盯三件事：明文里一个 Key 都不许出现、重启后两个字段都能恢复、
 * 以及"加密不可用时绝不抹掉用户已存的 Key"（抹了就是拿数据安全的名义制造数据丢失）。
 */

const K_API = "aihumanizer.api";
const SECRET_MAIN = "sk-MAIN-SECRET-0001";
const SECRET_POOL_A = "sk-POOL-A-0002";
const SECRET_POOL_B = "sk-POOL-B-0003";

function apiWithKeys() {
  return {
    ...DEFAULT_API,
    baseUrl: "https://example.test/v1",
    apiKey: SECRET_MAIN,
    apiKeys: `${SECRET_POOL_A}\n${SECRET_POOL_B}`,
  };
}

/** 桥接存储：set 返回 true 模拟 safeStorage 可用 */
function bridge(fail = false): Map<string, string | null> {
  const store = new Map<string, string | null>();
  (window as unknown as { secureStore: unknown }).secureStore = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string | null) => {
      if (fail) return false; // safeStorage.isEncryptionAvailable() === false
      store.set(k, v);
      return true;
    },
  };
  return store;
}

function unbridge() {
  delete (window as unknown as { secureStore?: unknown }).secureStore;
}

describe("persistApiConfig：桌面版不留明文", () => {
  it("桥可用：两个 Key 字段都进加密存储，localStorage 里搜不到任何 Key 片段", async () => {
    const store = bridge();
    try {
      expect(await persistApiConfig(apiWithKeys())).toBe(true);
      expect(store.get("apiKey")).toBe(SECRET_MAIN);
      expect(store.get("apiKeys")).toBe(`${SECRET_POOL_A}\n${SECRET_POOL_B}`);
      const raw = localStorage.getItem(K_API) ?? "";
      expect(raw).not.toContain(SECRET_MAIN);
      expect(raw).not.toContain(SECRET_POOL_A);
      expect(raw).not.toContain(SECRET_POOL_B);
      // 非敏感字段照旧留存
      expect(loadApi().baseUrl).toBe("https://example.test/v1");
    } finally {
      unbridge();
    }
  });

  it("重启后两个字段都能注回来（effectiveKeys 用得上的那个池子不能丢）", async () => {
    bridge();
    try {
      await persistApiConfig(apiWithKeys());
      const adopted = await adoptSecureApiKeys();
      expect(adopted.apiKey).toBe(SECRET_MAIN);
      expect(adopted.apiKeys).toBe(`${SECRET_POOL_A}\n${SECRET_POOL_B}`);
      const merged = { ...loadApi(), apiKey: adopted.apiKey ?? "", apiKeys: adopted.apiKeys };
      expect(effectiveKeys(merged).sort()).toEqual(
        [SECRET_MAIN, SECRET_POOL_A, SECRET_POOL_B].sort(),
      );
    } finally {
      unbridge();
    }
  });

  it("safeStorage 不可用：退回明文（不销毁用户已存的 Key），并如实返回 false", async () => {
    const store = bridge(true);
    try {
      expect(await persistApiConfig(apiWithKeys())).toBe(false);
      expect(store.size).toBe(0); // 什么都没写进"加密存储"
      const raw = localStorage.getItem(K_API) ?? "";
      expect(raw).toContain(SECRET_POOL_A); // 明文保留 = 用户的 Key 还在
      expect(loadApi().apiKey).toBe(SECRET_MAIN);
    } finally {
      unbridge();
    }
  });

  it("Web 版：走 localStorage，返回 false（没有加密通道可言）", async () => {
    expect(await persistApiConfig(apiWithKeys())).toBe(false);
    expect(loadApi().apiKeys).toBe(`${SECRET_POOL_A}\n${SECRET_POOL_B}`);
  });
});

describe("adoptSecureApiKeys：把老版本留在 localStorage 的明文迁进加密存储", () => {
  it("桌面版：明文池搬进加密存储后，localStorage 里的明文被抹掉", async () => {
    saveApi(apiWithKeys()); // 模拟 v0.9.14 之前存下的明文
    const store = bridge();
    try {
      const adopted = await adoptSecureApiKeys();
      expect(adopted.apiKeys).toBe(`${SECRET_POOL_A}\n${SECRET_POOL_B}`);
      expect(store.get("apiKeys")).toBe(`${SECRET_POOL_A}\n${SECRET_POOL_B}`);
      expect(localStorage.getItem(K_API) ?? "").not.toContain(SECRET_POOL_A);
      expect(localStorage.getItem(K_API) ?? "").not.toContain(SECRET_MAIN);
    } finally {
      unbridge();
    }
  });

  it("加密存储里已有值时不被明文覆盖（用户可能已在界面上改过）", async () => {
    saveApi(apiWithKeys());
    const store = bridge();
    try {
      await saveApiKeysSecure("sk-NEWER-only");
      const adopted = await adoptSecureApiKeys();
      expect(adopted.apiKeys).toBe("sk-NEWER-only");
      expect(store.get("apiKeys")).toBe("sk-NEWER-only");
    } finally {
      unbridge();
    }
  });

  it("写不进加密存储时**不抹**明文（否则就是销毁用户的 Key）", async () => {
    saveApi(apiWithKeys());
    const store = bridge(true);
    try {
      await adoptSecureApiKeys();
      expect(store.size).toBe(0);
      expect(localStorage.getItem(K_API) ?? "").toContain(SECRET_POOL_A);
    } finally {
      unbridge();
    }
  });

  it("Web 版返回空对象：启动路径不因这次修复而改变", async () => {
    saveApi(apiWithKeys());
    expect(await adoptSecureApiKeys()).toEqual({});
    expect(loadApi().apiKeys).toBe(`${SECRET_POOL_A}\n${SECRET_POOL_B}`);
  });
});

describe("loadApi：persona 白名单的两个分支", () => {
  beforeEach(() => localStorage.clear());

  it.each(["netgen", "classic"])("persona=%s 被接受并透传", (p) => {
    localStorage.setItem(K_API, JSON.stringify({ persona: p }));
    expect(loadApi().persona).toBe(p);
  });

  it.each(["default", "unknown", "", "NETGEN"])(
    "persona=%o 不在白名单 → 回落到默认值（大小写敏感）",
    (p) => {
      localStorage.setItem(K_API, JSON.stringify({ persona: p }));
      expect(loadApi().persona).toBe(DEFAULT_API.persona ?? "default");
    },
  );

  it("persona 缺失 → 默认值", () => {
    localStorage.setItem(K_API, JSON.stringify({ model: "gpt-4" }));
    expect(loadApi().persona).toBe(DEFAULT_API.persona ?? "default");
  });
});

describe("secureStore 桥接：写入抛异常时不炸", () => {
  beforeEach(() => localStorage.clear());

  it("set() 抛异常 → 返回 false 而不是把异常冒给调用方", async () => {
    const orig = window.secureStore;
    window.secureStore = {
      get: async () => null,
      set: async () => {
        throw new Error("桥接断了");
      },
      del: async () => undefined,
    } as unknown as typeof window.secureStore;
    try {
      // 实测返回的是 false（不是 undefined）——调用方按布尔值判断，
      // 异常被 secureSet 的 catch 吞掉，不会让设置面板的保存流程崩掉。
      await expect(saveApiKeySecure("sk-test")).resolves.toBe(false);
    } finally {
      window.secureStore = orig;
    }
  });
});

/**
 * 草稿持久化（loadDraft / saveDraft）
 *
 * 这块此前一个用例都没有——而它恰好是全文件里**唯一带配额上限**的写入路径，
 * 上限判定用 `>` 而不是 `>=`（恰好 100 万字放行，100 万零 1 字丢弃）。
 * 这种边界最容易被后人「顺手改成 >=」而悄悄改掉语义，所以钉死。
 */
describe("loadDraft / saveDraft", () => {
  const K_DRAFT = "aihumanizer.draft";
  const put = (v: string) => localStorage.setItem(K_DRAFT, v);

  beforeEach(() => localStorage.clear());

  describe("loadDraft：坏数据一律降级为 null，绝不抛", () => {
    it.each([
      ["空串", ""],
      ["字面量 null", "null"],
      ["非法 JSON", "not json"],
      ["数组（不是对象）", "[]"],
      ["数字", "42"],
      ["字符串", '"hello"'],
    ])("%s → null", (_label, raw) => {
      put(raw);
      expect(loadDraft()).toBeNull();
    });

    it("input/output 都是空串 → null（没有内容的草稿不值得留）", () => {
      put(JSON.stringify({ input: "", output: "" }));
      expect(loadDraft()).toBeNull();
    });

    it("字段类型错（input 是数字、output 是对象）→ 按空串处理", () => {
      put(JSON.stringify({ input: 123, output: {} }));
      expect(loadDraft()).toBeNull();
    });

    it("只存了一半也能读出来", () => {
      put(JSON.stringify({ input: "甲" }));
      expect(loadDraft()).toEqual({ input: "甲", output: "", ts: 0 });
      put(JSON.stringify({ output: "乙" }));
      expect(loadDraft()).toEqual({ input: "", output: "乙", ts: 0 });
    });
  });

  describe("loadDraft：ts 的清洗", () => {
    it("正常数字原样保留", () => {
      put(JSON.stringify({ input: "甲", output: "乙", ts: 1700000000000 }));
      expect(loadDraft()?.ts).toBe(1700000000000);
    });

    it("非数字（字符串）→ 0", () => {
      put(JSON.stringify({ input: "甲", output: "乙", ts: "abc" }));
      expect(loadDraft()?.ts).toBe(0);
    });

    it("缺 ts → 0", () => {
      put(JSON.stringify({ input: "甲", output: "乙" }));
      expect(loadDraft()?.ts).toBe(0);
    });

    it("Infinity / NaN → 0（isFinite 守卫）", () => {
      // JSON.stringify(Infinity) 本身就会写成 null，所以这里直接构造字符串
      put('{"input":"甲","output":"乙","ts":1e999}');
      expect(loadDraft()?.ts).toBe(0);
      put('{"input":"甲","output":"乙","ts":null}');
      expect(loadDraft()?.ts).toBe(0);
    });
  });

  describe("saveDraft：配额上限是 `>` 不是 `>=`", () => {
    // DRAFT_MAX_CHARS = 1_000_000。实测：
    //   999_999 字 → 保存；1_000_000 字 → 保存；1_200_000 字 → 丢弃并删除旧草稿
    it("正常内容写入成功", () => {
      saveDraft("甲", "乙");
      expect(JSON.parse(localStorage.getItem(K_DRAFT) ?? "{}")).toMatchObject({
        input: "甲",
        output: "乙",
      });
    });

    it("恰好 1_000_000 字仍然写入（边界是 > 而非 >=）", () => {
      saveDraft("甲".repeat(999_999), "乙");
      expect(localStorage.getItem(K_DRAFT)).not.toBeNull();
    });

    it("超过上限则丢弃，并**删掉**已存在的旧草稿（不留半截）", () => {
      saveDraft("甲", "乙");
      expect(localStorage.getItem(K_DRAFT)).not.toBeNull();
      saveDraft("甲".repeat(600_000), "乙".repeat(600_000));
      expect(localStorage.getItem(K_DRAFT)).toBeNull();
    });

    it("超限时即使此前没有旧草稿也不报错", () => {
      localStorage.clear();
      expect(() => saveDraft("甲".repeat(1_200_000), "")).not.toThrow();
      expect(localStorage.getItem(K_DRAFT)).toBeNull();
    });
  });
});
