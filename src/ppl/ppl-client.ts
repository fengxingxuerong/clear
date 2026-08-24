/**
 * 趣AI味 · 困惑度客户端：双宿主选择 + 策略编排。
 *
 * - Electron：window.ppl 桥 → 主进程原生 ONNX 推理（快）
 * - Web：ppl-worker.ts（WASM，不卡 UI）
 *
 * 切窗与聚合一律走共享内核 scorer-core.ts，判定在 humanize-metrics.pplIssues。
 */
import { aggregateText, planWindows, type PplFeature, type PplWindow } from "./scorer-core.ts";

let readyFlag = false;

/** 模型是否已确认就绪（显式下载成功后置位；用于首次使用门控，避免误触发大流量下载） */
export function isPplReady(): boolean {
  return readyFlag;
}

export interface PplProgressInfo {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export interface PplStatus {
  /** 当前宿主是否支持困惑度功能（Web 无 Worker 能力时为 false） */
  supported: boolean;
  /** 模型是否已就绪（Web 版无法廉价探测缓存，恒 false，下载调用幂等） */
  ready: boolean;
}

type ScoreResult = { meanNll: number | null; scoredCount: number };

interface ElectronPplBridge {
  status(): Promise<PplStatus>;
  download(
    onProgress?: (p: PplProgressInfo) => void,
  ): Promise<{ ok: boolean; error?: string }>;
  score(
    windows: string[],
  ): Promise<{ ok: boolean; results?: ScoreResult[]; error?: string }>;
}

function electronBridge(): ElectronPplBridge | null {
  const b = (window as unknown as { ppl?: unknown }).ppl;
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (
    typeof o.status !== "function" ||
    typeof o.download !== "function" ||
    typeof o.score !== "function"
  ) {
    return null;
  }
  return b as ElectronPplBridge;
}

/* ----------------------------- Web Worker 通道 ----------------------------- */

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = new Promise<Worker>((resolve, reject) => {
      try {
        const w = new Worker(new URL("./ppl-worker.ts", import.meta.url), { type: "module" });
        const onMessage = (ev: MessageEvent) => {
          const d = ev.data as { type?: string; error?: string };
          if (d?.type === "ready") {
            w.removeEventListener("message", onMessage);
            resolve(w);
          } else if (d?.type === "error") {
            reject(new Error(d.error ?? "worker 初始化失败"));
          }
        };
        w.addEventListener("message", onMessage);
        w.addEventListener("error", () => reject(new Error("Worker 加载失败")));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }).catch((e) => {
      workerPromise = null; // 失败可重试
      throw e;
    });
  }
  return workerPromise;
}

function workerCall<T>(
  w: Worker,
  msg: Record<string, unknown>,
  onProgress?: (p: PplProgressInfo) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { type: string; error?: string; result?: T; progress?: PplProgressInfo };
      if (d.type === "progress") {
        if (onProgress && d.progress) onProgress(d.progress);
        return;
      }
      w.removeEventListener("message", onMessage);
      if (d.type === "ok") resolve(d.result as T);
      else reject(new Error(d.error ?? "未知错误"));
    };
    w.addEventListener("message", onMessage);
    w.postMessage(msg);
  });
}

/* ----------------------------- 公共 API ----------------------------- */

/** 探测当前宿主的困惑度能力。永不抛错。 */
export async function pplStatus(): Promise<PplStatus> {
  const bridge = electronBridge();
  if (bridge) {
    try {
      return await bridge.status();
    } catch {
      return { supported: false, ready: false };
    }
  }
  return { supported: typeof Worker !== "undefined", ready: false };
}

/** 确保模型就绪；未下载则触发下载（幂等，已缓存时秒回）。 */
export async function ensurePplModel(onProgress?: (p: PplProgressInfo) => void): Promise<void> {
  const bridge = electronBridge();
  if (bridge) {
    const r = await bridge.download(onProgress);
    if (!r.ok) throw new Error(r.error ?? "模型下载失败");
    readyFlag = true;
    return;
  }
  const w = await getWorker();
  await workerCall(w, { type: "download" }, onProgress);
  readyFlag = true;
}

/** 全文打分并聚合为特征。抛错由调用方决定降级展示。 */
export async function computePplFeature(text: string): Promise<PplFeature> {
  const planned = planWindows(text);
  if (planned.length === 0) return aggregateText([]);
  const windowStrings = planned.map((w) => w.chars.join(""));
  const bridge = electronBridge();

  let raw: ScoreResult[];
  if (bridge) {
    const r = await bridge.score(windowStrings);
    if (!r.ok || !r.results) throw new Error(r.error ?? "主进程打分失败");
    raw = r.results;
  } else {
    const w = await getWorker();
    const r = await workerCall<{ ok: boolean; results: ScoreResult[] }>(
      w,
      { type: "score", windows: windowStrings },
    );
    if (!r.ok || !r.results) throw new Error("worker 打分失败");
    raw = r.results;
  }

  readyFlag = true;
  const wins: PplWindow[] = [];
  planned.forEach((pw, i) => {
    const res = raw[i];
    if (res && res.meanNll != null && Number.isFinite(res.meanNll) && res.scoredCount > 0) {
      wins.push({
        charStart: pw.offsets[0][0],
        charEnd: pw.offsets[pw.offsets.length - 1][1],
        scoredCount: res.scoredCount,
        meanNll: res.meanNll,
      });
    }
  });
  return aggregateText(wins);
}
