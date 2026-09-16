/**
 * 外部检测器钩子测试
 * ---------------------------------------------------------
 * 这是「接第三方检测 API」的唯一出入口：分数刻度换算（0-1 ↔ 0-100）、
 * 嵌套 scorePath 取值、越界夹取、非数字/非 2xx 的失败路径，全都在这里。
 * 换算错一位 = 全盘分数系统性偏差 100 倍，且 UI 上看不出来，必须锁死。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DEFAULT_DETECTOR, scoreViaDetector, type DetectorConfig } from "./detector";

const realFetch = globalThis.fetch;

function cfg(partial: Partial<DetectorConfig> = {}): DetectorConfig {
  return { ...DEFAULT_DETECTOR, url: "https://det.example.com/score", ...partial };
}

/** 装一个返回给定 body 的假 fetch，并记录调用参数 */
function stubFetch(opts: { ok?: boolean; status?: number; body?: unknown } = {}) {
  const spy = vi.fn(async (_url?: unknown, _init?: unknown) => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.body,
  }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("scoreViaDetector（正常路径）", () => {
  it("0-100 刻度：原样返回并取整", async () => {
    stubFetch({ body: { score: 73.4 } });
    await expect(scoreViaDetector("文本", cfg())).resolves.toBe(73);
  });

  it("0-1 刻度：乘 100 后返回（0.73 → 73）", async () => {
    stubFetch({ body: { score: 0.73 } });
    await expect(scoreViaDetector("文本", cfg({ scale: "0-1" }))).resolves.toBe(73);
  });

  it("嵌套 scorePath 支持点路径取值（data.prob）", async () => {
    stubFetch({ body: { data: { prob: 42 } } });
    await expect(scoreViaDetector("文本", cfg({ scorePath: "data.prob" }))).resolves.toBe(42);
  });

  it("数字字符串也能解析（部分接口返回 string）", async () => {
    stubFetch({ body: { score: "88" } });
    await expect(scoreViaDetector("文本", cfg())).resolves.toBe(88);
  });
});

describe("scoreViaDetector（夹取与边界）", () => {
  it("超过 100 夹到 100", async () => {
    stubFetch({ body: { score: 250 } });
    await expect(scoreViaDetector("文本", cfg())).resolves.toBe(100);
  });

  it("负数夹到 0", async () => {
    stubFetch({ body: { score: -12 } });
    await expect(scoreViaDetector("文本", cfg())).resolves.toBe(0);
  });

  it("0-1 刻度下 1.0 → 100", async () => {
    stubFetch({ body: { score: 1 } });
    await expect(scoreViaDetector("文本", cfg({ scale: "0-1" }))).resolves.toBe(100);
  });
});

describe("scoreViaDetector（失败路径）", () => {
  it("非 2xx 抛出带状态码的错误", async () => {
    stubFetch({ ok: false, status: 503 });
    await expect(scoreViaDetector("文本", cfg())).rejects.toThrow(/503/);
  });

  it("scorePath 取不到值时抛错，不返回 NaN", async () => {
    stubFetch({ body: { other: 1 } });
    await expect(scoreViaDetector("文本", cfg())).rejects.toThrow("无法从响应解析分数");
  });

  it("scorePath 命中的是非数字时抛错", async () => {
    stubFetch({ body: { score: "很高" } });
    await expect(scoreViaDetector("文本", cfg())).rejects.toThrow("无法从响应解析分数");
  });

  it("嵌套路径中途断裂（data 为 null）时抛错而不是崩溃", async () => {
    stubFetch({ body: { data: null } });
    await expect(scoreViaDetector("文本", cfg({ scorePath: "data.prob" }))).rejects.toThrow(
      "无法从响应解析分数",
    );
  });
});

describe("scoreViaDetector（请求构造）", () => {
  it("配了 apiKey 才带 Authorization 头", async () => {
    const spy = stubFetch({ body: { score: 1 } });
    await scoreViaDetector("文本", cfg({ apiKey: "sk-1" }));
    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-1");
  });

  it("未配 apiKey 时不应出现 Authorization 头", async () => {
    const spy = stubFetch({ body: { score: 1 } });
    await scoreViaDetector("文本", cfg({ apiKey: "" }));
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("POST 且 body 带原文，并带超时 signal（防挂起）", async () => {
    const spy = stubFetch({ body: { score: 1 } });
    await scoreViaDetector("待检测文本", cfg());
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://det.example.com/score");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "待检测文本" });
    expect(init.signal).toBeTruthy();
  });
});

describe("DEFAULT_DETECTOR", () => {
  it("默认关闭且刻度为 0-100（避免误配外部接口）", () => {
    expect(DEFAULT_DETECTOR.enabled).toBe(false);
    expect(DEFAULT_DETECTOR.url).toBe("");
    expect(DEFAULT_DETECTOR.scale).toBe("0-100");
  });
});
