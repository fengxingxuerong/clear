import { ApiConfig, DEFAULT_API } from "./api/llm";
import { DetectorConfig, DEFAULT_DETECTOR } from "./api/detector";
import { DEFAULT_SEMANTIC_WEIGHT } from "./engine/zhuque";

const K_API = "aihumanizer.api";
const K_IT = "aihumanizer.intensity";
const K_DET = "aihumanizer.detector";
const K_ZQ = "aihumanizer.zhuque";
const K_PPL = "aihumanizer.ppl";
const K_FUSE = "quaiwei.zhuque.fuse";
const K_LOCAL = "aihumanizer.local";

/** 本地引擎设置：多候选择优（自 C 盘副本 v0.6.0 吸收） */
export interface LocalSettings {
  bestOf: boolean;
  candidates: number;
}

export const DEFAULT_LOCAL: LocalSettings = { bestOf: true, candidates: 8 };

export function loadLocal(): LocalSettings {
  const o = parseObject(localStorage.getItem(K_LOCAL));
  if (!o) return { ...DEFAULT_LOCAL };
  return {
    bestOf: bool(o, "bestOf", DEFAULT_LOCAL.bestOf),
    candidates: Math.max(1, Math.min(30, num(o, "candidates", DEFAULT_LOCAL.candidates))),
  };
}

export function saveLocal(c: LocalSettings): void {
  localStorage.setItem(K_LOCAL, JSON.stringify(c));
}

/** 逐字段清洗解析：localStorage 里旧版本残存字段 / 手动篡改 / 类型错乱
 *  只会被回退到默认值，不会让整个配置静默坏掉。 */
function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // 解析失败按缺失处理
  }
  return null;
}

function str(o: Record<string, unknown>, k: string, fallback: string): string {
  return typeof o[k] === "string" ? (o[k] as string) : fallback;
}

function bool(o: Record<string, unknown>, k: string, fallback: boolean): boolean {
  return typeof o[k] === "boolean" ? (o[k] as boolean) : fallback;
}

function num(o: Record<string, unknown>, k: string, fallback: number): number {
  return typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : fallback;
}

export function loadApi(): ApiConfig {
  const o = parseObject(localStorage.getItem(K_API));
  if (!o) return { ...DEFAULT_API };
  return {
    enabled: bool(o, "enabled", DEFAULT_API.enabled),
    baseUrl: str(o, "baseUrl", DEFAULT_API.baseUrl),
    apiKey: str(o, "apiKey", DEFAULT_API.apiKey),
    model: str(o, "model", DEFAULT_API.model),
    temperature: num(o, "temperature", DEFAULT_API.temperature),
    deepMode: bool(o, "deepMode", DEFAULT_API.deepMode),
    judgeModel: str(o, "judgeModel", DEFAULT_API.judgeModel),
    altModel: str(o, "altModel", DEFAULT_API.altModel),
    style:
      o.style === "casual" || o.style === "plain" || o.style === "academic"
        ? o.style
        : DEFAULT_API.style,
    reasoningEffort: ["low", "medium", "high", "max", "x-high"].includes(o.reasoningEffort as string)
      ? (o.reasoningEffort as ApiConfig["reasoningEffort"])
      : undefined,
    maxWaitSeconds: typeof o.maxWaitSeconds === "number" && o.maxWaitSeconds >= 0 ? o.maxWaitSeconds : 0,
    maxApiCalls: typeof o.maxApiCalls === "number" && o.maxApiCalls >= 0 ? o.maxApiCalls : 0,
    // Key 池透传（v0.8.7 修复：此前 loadApi 漏读该字段，刷新页面后 Key 池丢失）
    ...(typeof o.apiKeys === "string" && o.apiKeys ? { apiKeys: o.apiKeys } : {}),
  };
}

export function saveApi(c: ApiConfig): void {
  localStorage.setItem(K_API, JSON.stringify(c));
}

/* ----------------------------- Electron 安全存储（safeStorage） ----------------------------- */
// 桌面版：API Key 用系统级加密落盘到 userData/secure-config.json，不存 localStorage 明文。
// Web 版：window.secureStore 不存在，回退到 localStorage（见 loadApi / saveApi）。

declare global {
  interface Window {
    secureStore?: {
      get: (key: string) => Promise<string | null>;
      set: (key: string, value: string | null) => Promise<boolean>;
    };
  }
}

/** 是否有安全存储桥接（Electron 桌面版） */
export function hasSecureStore(): boolean {
  return typeof window !== "undefined" && !!window.secureStore;
}

/** 从安全存储读取 API Key（异步）；Web 版返回 undefined 走 localStorage 默认 */
export async function loadApiKeySecure(): Promise<string | undefined> {
  if (!hasSecureStore()) return undefined;
  try {
    const key = await window.secureStore!.get("apiKey");
    return key ?? undefined;
  } catch {
    return undefined;
  }
}

/** 保存 API Key 到安全存储；值为空时清除。Web 版回退到 localStorage */
export async function saveApiKeySecure(apiKey: string): Promise<void> {
  if (!hasSecureStore()) return;
  await window.secureStore!.set("apiKey", apiKey || null);
}

/** 从安全存储读取外部检测器的 API Key（异步）；Web 版返回 undefined 走 localStorage 默认 */
export async function loadDetectorKeySecure(): Promise<string | undefined> {
  if (!hasSecureStore()) return undefined;
  try {
    const key = await window.secureStore!.get("detectorApiKey");
    return key ?? undefined;
  } catch {
    return undefined;
  }
}

/** 保存外部检测器的 API Key 到安全存储（与主 Key 同级的加密保护）；值为空时清除 */
export async function saveDetectorKeySecure(apiKey: string): Promise<void> {
  if (!hasSecureStore()) return;
  await window.secureStore!.set("detectorApiKey", apiKey || null);
}

export function loadDetector(): DetectorConfig {
  const o = parseObject(localStorage.getItem(K_DET));
  if (!o) return { ...DEFAULT_DETECTOR };
  return {
    enabled: bool(o, "enabled", DEFAULT_DETECTOR.enabled),
    url: str(o, "url", DEFAULT_DETECTOR.url),
    apiKey: str(o, "apiKey", DEFAULT_DETECTOR.apiKey),
    scorePath: str(o, "scorePath", DEFAULT_DETECTOR.scorePath),
    scale: o.scale === "0-1" ? "0-1" : "0-100",
  };
}

export function saveDetector(c: DetectorConfig): void {
  localStorage.setItem(K_DET, JSON.stringify(c));
}

export function loadIntensity(): number {
  const v = parseFloat(localStorage.getItem(K_IT) || "");
  return isNaN(v) ? 0.6 : Math.max(0, Math.min(1, v));
}

export function saveIntensity(v: number): void {
  localStorage.setItem(K_IT, String(v));
}

export function loadZhuqueMode(): boolean {
  return localStorage.getItem(K_ZQ) === "true";
}

export function saveZhuqueMode(v: boolean): void {
  localStorage.setItem(K_ZQ, String(v));
}

/** 困惑度体检开关（默认开）；关闭后指纹体检只跑前 7 项 */
export function loadPplEnabled(): boolean {
  return localStorage.getItem(K_PPL) !== "false";
}

export function savePplEnabled(v: boolean): void {
  localStorage.setItem(K_PPL, v ? "true" : "false");
}

/** 朱雀检测「语义层权重」：表层×语义层加权融合用的 w（0~1，默认 DEFAULT_SEMANTIC_WEIGHT） */
export function loadFuseWeight(): number {
  const v = parseFloat(localStorage.getItem(K_FUSE) || "");
  return isNaN(v) ? DEFAULT_SEMANTIC_WEIGHT : Math.max(0, Math.min(1, v));
}

export function saveFuseWeight(v: number): void {
  localStorage.setItem(K_FUSE, String(v));
}
