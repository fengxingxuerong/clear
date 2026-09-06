// @vitest-environment happy-dom
/**
 * ppl-client 集成测试（v0.8.7 补盲）：Worker 通信层与 Electron 桥双宿主路径。
 * mock Worker 构造器模拟消息协议，验证 ppl-client 的编排逻辑
 * （协议收发、失败语义、readyFlag 门控、错误可重试）。
 *
 * 注意：ppl-client 有模块级单例状态（workerPromise/readyFlag），本文件
 * 不做 resetModules——用例按"探测→下载→打分→失败重试"的真实时序排列，
 * 失败重试用例放在最后（workerPromise 失败会清缓存可重建，正好验证）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const defaultHandler = (msg: unknown) => {
  const m = msg as { type: string; windows?: string[] };
  if (m.type === "score" && m.windows) {
    return {
      type: "ok",
      result: { ok: true, results: m.windows.map(() => ({ meanNll: 0.8, scoredCount: 100 })) },
    };
  }
  return { type: "ok", result: { ok: true } };
};

class FakeWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  sent: unknown[] = [];
  /** getWorker 通过 addEventListener 等 ready 消息——须真实记录 listener */
  private listeners: Array<(ev: MessageEvent) => void> = [];
  /** 每条收到的消息 → 响应；默认 download/score 都成功，用例可覆写 */
  handler: (msg: unknown) => { type: string; result?: unknown; error?: string } | null = defaultHandler;

  constructor(_url: URL | string, _opts?: { type?: string }) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 测试桩需要全局引用当前实例
    lastFake = this;
    // 真实 ppl-worker.ts 末尾会 post({type:"ready"})——构造即发，getWorker 才能解析
    queueMicrotask(() => this.emit({ type: "ready" }));
  }

  private emit(data: unknown): void {
    const ev = new MessageEvent("message", { data });
    for (const l of this.listeners) l(ev);
    this.onmessage?.(ev);
  }

  postMessage(msg: unknown): void {
    this.sent.push(msg);
    const r = this.handler(msg);
    if (r) queueMicrotask(() => this.emit(r));
  }
  addEventListener(_t: string, l: (ev: MessageEvent) => void): void {
    this.listeners.push(l);
  }
  removeEventListener(_t: string, l: (ev: MessageEvent) => void): void {
    this.listeners = this.listeners.filter((x) => x !== l);
  }
  terminate(): void {}
}

let lastFake: FakeWorker | null = null;

/** 默认协议：download/score 都成功 */
vi.stubGlobal("Worker", FakeWorker);

afterEach(() => {
  if (lastFake) lastFake.handler = defaultHandler;
});

const { pplStatus, ensurePplModel, isPplReady, computePplFeature } = await import("./ppl-client");

describe("pplStatus（能力探测）", () => {
  it("Web 宿主：有 Worker 能力 → supported=true, ready=false", async () => {
    const s = await pplStatus();
    expect(s.supported).toBe(true);
    expect(s.ready).toBe(false);
  });

  it("Electron 桥存在：透传桥的 status；桥抛错 → 降级 supported=false", async () => {
    const origWindow = globalThis.window;
    vi.stubGlobal("window", {
      ppl: {
        status: async () => ({ supported: true, ready: true }),
        download: async () => ({ ok: true }),
        score: async () => ({ ok: true, results: [] }),
      },
    });
    const s = await pplStatus();
    expect(s.supported).toBe(true);
    expect(s.ready).toBe(true);

    vi.stubGlobal("window", {
      ppl: {
        status: async () => {
          throw new Error("bridge dead");
        },
        download: async () => ({ ok: true }),
        score: async () => ({ ok: true, results: [] }),
      },
    });
    const s2 = await pplStatus();
    expect(s2.supported).toBe(false);
    if (origWindow) vi.stubGlobal("window", origWindow);
  });
});

describe("ensurePplModel + readyFlag 门控", () => {
  it("download 成功后 isPplReady 置位", async () => {
    expect(isPplReady()).toBe(false);
    // ensurePplModel 触发 Worker 构造（lastFake 就位）
    const pending = ensurePplModel();
    expect(lastFake).not.toBeNull();
    lastFake!.handler = (msg) => {
      const m = msg as { type: string };
      if (m.type === "download") return { type: "ok", result: { ok: true } };
      return defaultHandler(msg);
    };
    await pending;
    expect(isPplReady()).toBe(true);
    // 协议校验：确实发了 download 消息
    expect(lastFake!.sent.some((m) => (m as { type: string }).type === "download")).toBe(true);
  });
});

describe("computePplFeature（Worker 通道编排）", () => {
  it("短文本：切窗→发 score 消息→聚合 meanNll", async () => {
    const f = await computePplFeature("一二三四五六七八九十");
    expect(f.scoredChars).toBeGreaterThan(0);
    expect(f.meanNll).toBeCloseTo(0.8, 5);
    expect(f.windows.length).toBeGreaterThan(0);
    const scoreMsg = lastFake!.sent.find((m) => (m as { type: string }).type === "score") as {
      windows: string[];
    };
    expect(scoreMsg.windows[0]).toContain("一");
  });

  it("空文本：零窗直接返回聚合空特征，不发消息", async () => {
    const sentBefore = lastFake!.sent.length;
    const f = await computePplFeature("");
    expect(f.scoredChars).toBe(0);
    expect(f.windows.length).toBe(0);
    expect(lastFake!.sent.length).toBe(sentBefore);
  });

  it("worker 返回 ok 但 results 缺失：抛错", async () => {
    lastFake!.handler = () => ({ type: "ok", result: { ok: true } });
    await expect(computePplFeature("一段测试文本。")).rejects.toThrow(/worker 打分失败/);
    lastFake!.handler = defaultHandler;
  });

  it("worker 返回 error：抛错由调用方降级", async () => {
    lastFake!.handler = () => ({ type: "error", error: "模型加载超时" });
    await expect(computePplFeature("一段测试文本。")).rejects.toThrow();
    lastFake!.handler = defaultHandler;
  });
});
