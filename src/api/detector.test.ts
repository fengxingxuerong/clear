/**
 * 外部检测器钩子测试
 * ---------------------------------------------------------
 * 这是「接第三方检测 API」的唯一出入口：分数刻度换算（0-1 ↔ 0-100）、
 * 嵌套 scorePath 取值、越界夹取、非数字/非 2xx 的失败路径，全都在这里。
 * 换算错一位 = 全盘分数系统性偏差 100 倍，且 UI 上看不出来，必须锁死。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_DETECTOR,
  ZHUQUE_OFFICIAL_DETECTOR,
  scoreViaDetector,
  type DetectorConfig,
} from "./detector";

const realFetch = globalThis.fetch;

function cfg(partial: Partial<DetectorConfig> = {}): DetectorConfig {
  return { ...DEFAULT_DETECTOR, url: "https://det.example.com/score", ...partial };
}

/** 装一个返回给定 body 的假 fetch，并记录调用参数 */
function stubFetch(opts: { ok?: boolean; status?: number; body?: unknown; text?: string } = {}) {
  const spy = vi.fn(async (_url?: unknown, _init?: unknown) => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.body,
    text: async () => opts.text ?? JSON.stringify(opts.body ?? ""),
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

  it("HTTP 200 但自报失败（status=error + 分数为 0）必须抛错，不能读成 0 分=完全人类", async () => {
    // 这是本模块最危险的一条路径：配额耗尽若被当成「人类写作」，
    // 一次失败的去味会被记成一次完美的成功。
    stubFetch({ body: { status: "error", msg: "quota exceeded", softmax_confidence: 0 } });
    await expect(
      scoreViaDetector("文本", cfg({ scorePath: "softmax_confidence", scale: "0-1" })),
    ).rejects.toThrow(/quota exceeded/);
  });

  it("status 为失败词但没有 msg 时也抛错", async () => {
    stubFetch({ body: { status: "failed", score: 0 } });
    await expect(scoreViaDetector("文本", cfg())).rejects.toThrow(/status=failed/);
  });

  it("error 字段非空（朱雀未授权时的真实形态）抛错", async () => {
    stubFetch({
      body: { error: { message: "API key not found.", type: "auth_failed", code: "auth_failed" } },
    });
    await expect(scoreViaDetector("文本", cfg())).rejects.toThrow(/auth_failed/);
  });

  it("msg 非空即使分数正常也抛错（自相矛盾的响应不该产出分数）", async () => {
    stubFetch({ body: { status: "success", msg: "degraded: fallback model", score: 5 } });
    await expect(scoreViaDetector("文本", cfg())).rejects.toThrow(/degraded/);
  });

  it("error:false / msg 空串 / status=success 的正常响应不误伤", async () => {
    stubFetch({ body: { status: "success", msg: "", error: false, score: 12 } });
    await expect(scoreViaDetector("文本", cfg())).resolves.toBe(12);
  });

  it("没有 status 字段的第三方接口不受白名单影响（向后兼容）", async () => {
    stubFetch({ body: { score: 41 } });
    await expect(scoreViaDetector("文本", cfg())).resolves.toBe(41);
  });

  it("返回非对象 JSON（数组/裸数字）时抛错而不是崩在属性访问上", async () => {
    stubFetch({ body: 42 });
    await expect(scoreViaDetector("文本", cfg())).rejects.toThrow(/不是 JSON 对象/);
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

describe("非 2xx 的现场材料（2026-09-22 补）", () => {
  // 起因：拿别家平台的凭证打朱雀官方网关，旧代码只抛「检测器返回 401」，
  // 网关写在响应体里的原因被整个丢掉，排查全靠猜。这几条钉的是"报错要带现场"。
  it("非 2xx 时把响应体里的原因带进消息，而不是只报状态码", async () => {
    stubFetch({
      ok: false,
      status: 400,
      text: '{"error":{"message":"text length 128 below the 350 character minimum"}}',
    });
    await expect(scoreViaDetector("短", cfg())).rejects.toThrow(/350 character minimum/);
  });

  it("401/403 追加「凭证与网关不配套」提示（400 不加，避免误导）", async () => {
    stubFetch({ ok: false, status: 401, text: '{"error":{"message":"API key not found."}}' });
    await expect(scoreViaDetector("文本", cfg({ apiKey: "not-a-real-cred" }))).rejects.toThrow(
      /凭证与网关不配套/,
    );
    stubFetch({ ok: false, status: 400, text: "bad request" });
    await expect(scoreViaDetector("文本", cfg())).rejects.not.toThrow(/凭证与网关不配套/);
  });

  it("网关回显凭证时，消息里必须是隐去后的占位符（错误会被贴进日志）", async () => {
    const fake = "本条仅为单元测试用凭证";
    stubFetch({ ok: false, status: 403, text: `rejected bearer ${fake} for this zone` });
    const msg = await scoreViaDetector("文本", cfg({ apiKey: fake })).catch((e: Error) => e.message);
    expect(msg).not.toContain(fake);
    expect(msg).toContain("⟨凭证已隐去⟩");
    expect(msg).toContain("403");
  });

  it("响应体读不出来时仍然抛带状态码的错（不能因为取现场失败就把异常吞了）", async () => {
    const spy = vi.fn(async () => ({ ok: false, status: 502, json: async () => null }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(scoreViaDetector("文本", cfg())).rejects.toThrow(/502/);
  });
});

describe("DEFAULT_DETECTOR", () => {
  it("默认关闭且刻度为 0-100（避免误配外部接口）", () => {
    expect(DEFAULT_DETECTOR.enabled).toBe(false);
    expect(DEFAULT_DETECTOR.url).toBe("");
    expect(DEFAULT_DETECTOR.scale).toBe("0-100");
  });
});

describe("ZHUQUE_OFFICIAL_DETECTOR（朱雀官方预设）", () => {
  it("预设本身就是官方文档口径：固定网关 + softmax_confidence + 0-1 刻度", async () => {
    expect(ZHUQUE_OFFICIAL_DETECTOR.url).toBe(
      "https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify",
    );
    expect(ZHUQUE_OFFICIAL_DETECTOR.scorePath).toBe("softmax_confidence");
    expect(ZHUQUE_OFFICIAL_DETECTOR.scale).toBe("0-1");
    // 接上就自动送检会静默花掉外部账号的额度，预设不得替用户打开
    expect(ZHUQUE_OFFICIAL_DETECTOR.enabled).toBe(false);
  });

  it("拿文档里的真实响应样例能跑出分数（0.0019 → 0 分，且不被失败守卫误杀）", async () => {
    stubFetch({
      body: {
        status: "success",
        softmax_confidence: 0.19,
        ratio_confidence: 0,
        labels_ratio: { "0": 1, "1": 0, "2": 0 },
        segment_labels: [],
        usage: { total_tokens: 7 },
        msg: "",
        makers_models_usage: { total_tokens: 12 },
      },
    });
    await expect(
      scoreViaDetector("hello world", { ...ZHUQUE_OFFICIAL_DETECTOR, apiKey: "k" }),
    ).resolves.toBe(19);
  });
});
