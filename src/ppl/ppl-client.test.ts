// @vitest-environment happy-dom
/**
 * ppl-client 测试：双宿主选择 + 策略编排（v0.9.16 测试迭代补盲）。
 *
 * 覆盖此前 0% 的分支：
 *  - Electron 桥路径（status/download/score、桥不完整回落、失败抛错）
 *  - Web Worker 路径（初始化握手、error 事件、progress 回调、构造失败重试）
 *  - computePplFeature 的窗结果过滤与聚合
 *
 * 模块内有 workerPromise / readyFlag 模块级状态，因此每个用例
 * 用 vi.resetModules() + 动态 import 保证互不污染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (ev: { data: unknown }) => void;

/** score 走通时默认返回的两窗结果（meanNll 2 与 4，各 10 字） */
const SCORE_RESULTS = [
  { meanNll: 2, scoredCount: 10 },
  { meanNll: 4, scoredCount: 10 },
];

class FakeWorker {
  /** 测试用例对 postMessage 的自定义响应脚本；缺省按消息类型给标准回包 */
  static script?: (w: FakeWorker, msg: { type: string }) => void;
  /** 置 true 时构造函数抛错（模拟无 Worker 能力的宿主） */
  static failConstruct = false;
  /** 置为文案时，构造完成后立刻发 {type:"error"} 消息（模拟 worker 内部初始化失败） */
  static initErrorMessage?: string;
  /** 置 true 时，构造完成后立刻派发 error 事件（模拟加载失败） */
  static initErrorEvent = false;

  static instances: FakeWorker[] = [];

  handlers: Record<string, Handler[]> = {};

  constructor() {
    if (FakeWorker.failConstruct) throw new Error("no worker env");
    FakeWorker.instances.push(this);
    queueMicrotask(() => {
      if (FakeWorker.initErrorMessage) {
        this.emit("message", { type: "error", error: FakeWorker.initErrorMessage });
      } else if (FakeWorker.initErrorEvent) {
        this.emit("error", {});
      } else {
        // 真实 ppl-worker.ts 加载完成后主动发的握手消息
        this.emit("message", { type: "ready" });
      }
    });
  }

  addEventListener(type: string, fn: Handler) {
    (this.handlers[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: Handler) {
    this.handlers[type] = (this.handlers[type] ?? []).filter((f) => f !== fn);
  }

  postMessage(msg: { type: string }) {
    queueMicrotask(() => {
      if (FakeWorker.script) {
        FakeWorker.script(this, msg);
        return;
      }
      if (msg.type === "download") this.emit("message", { type: "ok", result: { ok: true } });
      else if (msg.type === "score")
        this.emit("message", { type: "ok", result: { ok: true, results: SCORE_RESULTS } });
      else this.emit("message", { type: "ok", result: null });
    });
  }

  emit(type: string, data: unknown) {
    for (const fn of [...(this.handlers[type] ?? [])]) fn({ data });
  }
}

/** 每个用例独立加载模块（隔离 workerPromise / readyFlag） */
async function loadClient() {
  const mod = await import("./ppl-client.ts");
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  FakeWorker.instances = [];
  FakeWorker.script = undefined;
  FakeWorker.failConstruct = false;
  FakeWorker.initErrorMessage = undefined;
  FakeWorker.initErrorEvent = false;
  vi.stubGlobal("Worker", FakeWorker);
  delete (window as unknown as { ppl?: unknown }).ppl;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPplReady / readyFlag 状态门控", () => {
  it("初始未就绪", async () => {
    const mod = await loadClient();
    expect(mod.isPplReady()).toBe(false);
  });

  it("桥 download 成功后置位", async () => {
    (window as unknown as { ppl: unknown }).ppl = {
      status: async () => ({ supported: true, ready: false }),
      download: async () => ({ ok: true }),
      score: async () => ({ ok: true, results: [] }),
    };
    const mod = await loadClient();
    await mod.ensurePplModel();
    expect(mod.isPplReady()).toBe(true);
  });
});

describe("pplStatus（Electron 桥优先）", () => {
  it("桥存在：透传主进程 status 结果", async () => {
    (window as unknown as { ppl: unknown }).ppl = {
      status: async () => ({ supported: true, ready: true }),
      download: async () => ({ ok: true }),
      score: async () => ({ ok: true, results: [] }),
    };
    const mod = await loadClient();
    expect(await mod.pplStatus()).toEqual({ supported: true, ready: true });
  });

  it("桥 status 抛错：永不抛错承诺，回落 supported:false", async () => {
    (window as unknown as { ppl: unknown }).ppl = {
      status: async () => {
        throw new Error("bridge gone");
      },
      download: async () => ({ ok: true }),
      score: async () => ({ ok: true, results: [] }),
    };
    const mod = await loadClient();
    expect(await mod.pplStatus()).toEqual({ supported: false, ready: false });
  });

  it("桥对象不完整（缺 score 方法）：视为无桥回落 Worker 能力探测", async () => {
    (window as unknown as { ppl: unknown }).ppl = {
      status: async () => ({ supported: true, ready: true }),
      download: async () => ({ ok: true }),
    };
    const mod = await loadClient();
    // happy-dom 下 Worker 已被 stub 为 FakeWorker 构造器 → typeof 为 function
    expect(await mod.pplStatus()).toEqual({ supported: true, ready: false });
  });

  it("无桥且宿主无 Worker：supported=false", async () => {
    vi.stubGlobal("Worker", undefined);
    const mod = await loadClient();
    expect(await mod.pplStatus()).toEqual({ supported: false, ready: false });
  });
});

describe("ensurePplModel（下载幂等与失败抛错）", () => {
  it("桥 download 失败：抛出主进程给的原因", async () => {
    (window as unknown as { ppl: unknown }).ppl = {
      status: async () => ({ supported: true, ready: false }),
      download: async () => ({ ok: false, error: "磁盘空间不足" }),
      score: async () => ({ ok: true, results: [] }),
    };
    const mod = await loadClient();
    await expect(mod.ensurePplModel()).rejects.toThrow("磁盘空间不足");
    expect(mod.isPplReady()).toBe(false);
  });

  it("Worker 路径：download ok 后置位 ready", async () => {
    const mod = await loadClient();
    await mod.ensurePplModel();
    expect(FakeWorker.instances).toHaveLength(1);
    expect(mod.isPplReady()).toBe(true);
  });

  it("Worker 初始化消息报错：reject 并透传文案", async () => {
    FakeWorker.initErrorMessage = "模型文件损坏";
    const mod = await loadClient();
    await expect(mod.ensurePplModel()).rejects.toThrow("模型文件损坏");
  });

  it("Worker 加载失败（error 事件）：reject「Worker 加载失败」", async () => {
    FakeWorker.initErrorEvent = true;
    const mod = await loadClient();
    await expect(mod.ensurePplModel()).rejects.toThrow("Worker 加载失败");
  });

  it("Worker 构造失败：reject；且 workerPromise 被重置允许下次重试", async () => {
    FakeWorker.failConstruct = true;
    const mod = await loadClient();
    await expect(mod.ensurePplModel()).rejects.toThrow("no worker env");
    // 失败后解除故障 → 重试能走通（证明 workerPromise 已被重置为 null）
    FakeWorker.failConstruct = false;
    await expect(mod.ensurePplModel()).resolves.toBeUndefined();
    expect(FakeWorker.instances).toHaveLength(1);
  });
});

describe("computePplFeature（打分聚合与错误路径）", () => {
  it("桥路径：两窗结果正确聚合（加权均值 / 样本标准差 / 字数）", async () => {
    (window as unknown as { ppl: unknown }).ppl = {
      status: async () => ({ supported: true, ready: false }),
      download: async () => ({ ok: true }),
      score: async () => ({ ok: true, results: SCORE_RESULTS }),
    };
    const mod = await loadClient();
    // 400 字 → planWindows 切出 2 窗（win=384/stride=320），正好消费两窗回包
    const feat = await mod.computePplFeature("字".repeat(400));
    expect(feat.meanNll).toBeCloseTo(3, 6); // (2*10 + 4*10) / 20
    expect(feat.winStd).toBeCloseTo(Math.SQRT2, 6); // 两窗 2 与 4 的样本标准差
    expect(feat.scoredChars).toBe(20);
    expect(feat.windows).toHaveLength(2);
    expect(mod.isPplReady()).toBe(true);
  });

  it("桥 score 失败：透传主进程错误", async () => {
    (window as unknown as { ppl: unknown }).ppl = {
      status: async () => ({ supported: true, ready: false }),
      download: async () => ({ ok: true }),
      score: async () => ({ ok: false, error: "ONNX 会话崩了" }),
    };
    const mod = await loadClient();
    await expect(mod.computePplFeature("字".repeat(20))).rejects.toThrow("ONNX 会话崩了");
  });

  it("桥 score 缺 results：按失败处理", async () => {
    (window as unknown as { ppl: unknown }).ppl = {
      status: async () => ({ supported: true, ready: false }),
      download: async () => ({ ok: true }),
      score: async () => ({ ok: true }),
    };
    const mod = await loadClient();
    await expect(mod.computePplFeature("字".repeat(20))).rejects.toThrow("主进程打分失败");
  });

  it("空文本：不触碰任何宿主，直接返回零值特征", async () => {
    let bridgeCalls = 0;
    (window as unknown as { ppl: unknown }).ppl = {
      status: async () => ({ supported: true, ready: false }),
      download: async () => ({ ok: true }),
      score: async () => {
        bridgeCalls++;
        return { ok: true, results: [] };
      },
    };
    const mod = await loadClient();
    const feat = await mod.computePplFeature("   \n\t ");
    expect(bridgeCalls).toBe(0);
    expect(feat).toEqual({ meanNll: 0, winStd: 0, scoredChars: 0, windows: [] });
  });

  it("Worker 路径：默认脚本回包正确聚合", async () => {
    const mod = await loadClient();
    const feat = await mod.computePplFeature("字".repeat(400)); // 2 窗
    expect(feat.meanNll).toBeCloseTo(3, 6);
    expect(feat.scoredChars).toBe(20);
  });

  it("Worker 路径：progress 消息转发给 onProgress 回调", async () => {
    const seen: string[] = [];
    FakeWorker.script = (w, msg) => {
      if (msg.type === "download") {
        w.emit("message", { type: "progress", progress: { status: "加载分词器" } });
        w.emit("message", { type: "progress", progress: { status: "下载权重" } });
        w.emit("message", { type: "ok", result: { ok: true } });
      } else {
        w.emit("message", { type: "ok", result: { ok: true, results: SCORE_RESULTS } });
      }
    };
    const mod = await loadClient();
    await mod.ensurePplModel((p) => {
      if (p?.status) seen.push(p.status);
    });
    expect(seen).toEqual(["加载分词器", "下载权重"]);
  });

  it("窗结果过滤：meanNll 非有限或 scoredCount 为 0 的窗被丢弃", async () => {
    (window as unknown as { ppl: unknown }).ppl = {
      status: async () => ({ supported: true, ready: false }),
      download: async () => ({ ok: true }),
      score: async () => ({
        ok: true,
        results: [
          { meanNll: 2, scoredCount: 10 },
          { meanNll: Number.NaN, scoredCount: 10 }, // 丢弃
          { meanNll: 6, scoredCount: 0 }, // 丢弃
          { meanNll: 4, scoredCount: 10 },
        ],
      }),
    };
    const mod = await loadClient();
    // 1100 字 → 4 窗（0-384 / 320-704 / 640-1024 / 960-1100）：raw[1] NaN 丢、raw[2] 零分丢，
    // 只有第 1、4 窗有效
    const feat = await mod.computePplFeature("字".repeat(1100));
    expect(feat.windows).toHaveLength(2);
    expect(feat.meanNll).toBeCloseTo(3, 6);
    expect(feat.scoredChars).toBe(20);
  });
});
