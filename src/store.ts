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
/** v0.9.15：自定义保护术语（原文原样存，换行/逗号分隔）。
 *  此前 term-protect.ts 的 setProtectedTerms 只被测试调用，UI 零入口——
 *  而「中文术语零改动」在竞品对标表里是标 ✅ 的卖点，用户却加不了自己的词。 */
const K_TERMS = "aihumanizer.protectedTerms";
/** v0.9.15：编辑中的草稿（input/output）。此前刷新即丢——粘了三千字误触刷新全没，
 *  这是最劝退的一条。只存本地 localStorage，与其他配置一样不上传。 */
const K_DRAFT = "aihumanizer.draft";

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
    reasoningEffort: ["low", "medium", "high", "max", "x-high"].includes(
      o.reasoningEffort as string,
    )
      ? (o.reasoningEffort as ApiConfig["reasoningEffort"])
      : undefined,
    maxWaitSeconds:
      typeof o.maxWaitSeconds === "number" && o.maxWaitSeconds >= 0 ? o.maxWaitSeconds : 0,
    maxApiCalls: typeof o.maxApiCalls === "number" && o.maxApiCalls >= 0 ? o.maxApiCalls : 0,
    // v0.9：首轮多候选竞争采样数（1=关闭）。白名单逐字段解析，漏读会导致刷新后配置丢失
    contestSamples:
      typeof o.contestSamples === "number" && o.contestSamples >= 1
        ? Math.min(5, Math.floor(o.contestSamples))
        : 1,
    // v0.9.5 补读：这两个字段此前被白名单漏掉，用户在面板里勾了「严格保真」/
    // 选了「人味人格」，刷新页面即静默回默认。strictFidelity 是编造复核开关，
    // 静默失效等于防编造防线漏空——同类漏读已第三次复发（apiKeys / contestSamples）。
    strictFidelity: bool(o, "strictFidelity", DEFAULT_API.strictFidelity ?? false),
    persona:
      o.persona === "netgen" || o.persona === "classic"
        ? o.persona
        : (DEFAULT_API.persona ?? "default"),
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
//
// v0.9.14 补漏：加密通道此前**只覆盖单 Key apiKey 一个字段**，而 Key 池字段 apiKeys 被
// saveApi 原样写进 localStorage（store.ts 的 loadApi 还专门把它读回来"防止刷新丢失"）。
// 桌面版上「填入 SenseNova 常驻通道」写的正是 apiKeys（SettingsModal:165），
// effectiveKeys() 又把两者合并使用——于是唯一会承载多个可用 Key 的那个字段绕开了加密落盘。
// 现在 apiKey / apiKeys 一律走安全存储，localStorage 里两个字段都抹成空串。

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

async function secureGet(name: string): Promise<string | undefined> {
  if (!hasSecureStore()) return undefined;
  try {
    const v = await window.secureStore!.get(name);
    return v ?? undefined;
  } catch {
    return undefined; // 桥坏/密文损坏：静默回退，不崩主流程
  }
}

async function secureSet(name: string, value: string): Promise<boolean> {
  if (!hasSecureStore()) return false; // Web 版没有加密通道可言
  try {
    return (await window.secureStore!.set(name, value || null)) === true; // 空值即清除
  } catch {
    return false;
  }
}

/** 安全存储里的单个 API Key；Web 版（无桥）返回 undefined */
export function loadApiKeySecure(): Promise<string | undefined> {
  return secureGet("apiKey");
}

/** 安全存储里的 Key 池（多行/逗号分隔）；Web 版返回 undefined */
export function loadApiKeysSecure(): Promise<string | undefined> {
  return secureGet("apiKeys");
}

/**
 * 把单个 API Key 存进安全存储；值为空时清除。
 * 返回**是否真的落了加密存储**——调用方据此决定能不能抹掉明文副本。
 * 桥不存在（Web）或系统加密不可用（safeStorage.isEncryptionAvailable()=false，
 * main.js 那侧会直接 return false）都返回 false，绝不能让调用方误以为已加密。
 */
export function saveApiKeySecure(apiKey: string): Promise<boolean> {
  return secureSet("apiKey", apiKey);
}

/** 把 Key 池存进安全存储；语义与 saveApiKeySecure 一致 */
export function saveApiKeysSecure(apiKeys: string): Promise<boolean> {
  return secureSet("apiKeys", apiKeys);
}

/** 安全存储里的外部检测器 Key；Web 版返回 undefined */
export function loadDetectorKeySecure(): Promise<string | undefined> {
  return secureGet("detectorApiKey");
}

/** 保存外部检测器 Key 到安全存储（与主 Key 同级保护）；语义同 saveApiKeySecure */
export function saveDetectorKeySecure(apiKey: string): Promise<boolean> {
  return secureSet("detectorApiKey", apiKey);
}

/**
 * 桌面版启动时把 Key 收进加密存储，并抹掉 localStorage 里的明文副本。
 * 返回最终应生效的 {apiKey, apiKeys}，调用方拿它覆盖到配置对象上。
 *
 * 为什么需要它：v0.9.14 之前这条加密通道只覆盖 apiKey，Key 池 apiKeys 由 saveApi
 * 明文写进 localStorage（loadApi 还会专门读回来）。老桌面用户的 userData 里因此
 * 躺着明文池——不主动迁移，就要等他碰巧再保存一次设置才清掉。
 *
 * 三条硬约束：
 *  1) **只在确认写进加密存储之后**才抹明文。safeStorage 不可用时 main.js 返回 false，
 *     此时无条件抹掉等于销毁用户的 Key——那是拿"数据安全"的名义制造数据丢失。
 *     这种情况下明文原样留在 localStorage（与修复前一致，不会更差），值照旧返回。
 *  2) 安全存储里已有值时以它为准，不用明文覆盖（用户可能已经在界面上改过）。
 *  3) Web 版（无桥）返回空对象：调用方据此保持原有"不注入 initialApi"的行为，
 *     避免这次修复顺带改变 Web 版的启动路径。
 */
export async function adoptSecureApiKeys(): Promise<{ apiKey?: string; apiKeys?: string }> {
  if (!hasSecureStore()) return {};
  const persisted = loadApi();
  let apiKey = await loadApiKeySecure();
  let apiKeys = await loadApiKeysSecure();
  let moved = false;
  if (apiKeys === undefined && persisted.apiKeys) {
    if (await saveApiKeysSecure(persisted.apiKeys)) {
      apiKeys = persisted.apiKeys;
      moved = true;
    }
  }
  if (apiKey === undefined && persisted.apiKey) {
    if (await saveApiKeySecure(persisted.apiKey)) {
      apiKey = persisted.apiKey;
      moved = true;
    }
  }
  if (moved) saveApi({ ...persisted, apiKey: "", apiKeys: "" });
  return { apiKey, apiKeys };
}

/**
 * 保存 API 配置的唯一入口（桌面版走加密存储，Web 版走 localStorage）。
 * 返回 true = 明文已从 localStorage 抹掉、Key 只在加密存储里。
 *
 * 之所以收进 store：抹明文这一步同时决定"Key 会不会丢"和"Key 会不会漏在明文里"，
 * 放在 App 的 handler 里就没人测得到——历史已经因此翻过一次车：加密通道只抹了
 * apiKey，没抹 apiKeys，于是 Key 池一直明文躺在 userData 里。
 */
export async function persistApiConfig(a: ApiConfig): Promise<boolean> {
  if (!hasSecureStore()) {
    saveApi(a); // Web 版本就没有加密通道，明文是既定事实（UI 另有醒目提示）
    return false;
  }
  const okMain = await saveApiKeySecure(a.apiKey);
  const okPool = await saveApiKeysSecure(a.apiKeys ?? "");
  if (okMain && okPool) {
    saveApi({ ...a, apiKey: "", apiKeys: "" });
    return true;
  }
  // 系统加密不可用：宁可继续留明文（与修复前一致）也不能把用户的 Key 抹掉
  saveApi(a);
  return false;
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

/** 自定义保护术语原文（空串 = 未设置，只用内置 58 项） */
export function loadProtectedTerms(): string {
  return localStorage.getItem(K_TERMS) ?? "";
}

export function saveProtectedTerms(v: string): void {
  localStorage.setItem(K_TERMS, v);
}

export interface Draft {
  input: string;
  output: string;
  /** 保存时间戳（ms）。恢复时用它告诉用户"这是什么时候的稿" */
  ts: number;
}

/**
 * 草稿上限 1MB（localStorage 整站额度通常 5MB，还要留给配置与历史）。
 * 超过就不写——宁可不恢复，也不能把配额撑爆导致配置与历史一起写不进去。
 */
const DRAFT_MAX_CHARS = 1_000_000;

export function loadDraft(): Draft | null {
  const o = parseObject(localStorage.getItem(K_DRAFT));
  if (!o) return null;
  const input = typeof o.input === "string" ? o.input : "";
  const output = typeof o.output === "string" ? o.output : "";
  if (!input && !output) return null;
  return {
    input,
    output,
    ts: typeof o.ts === "number" && isFinite(o.ts) ? o.ts : 0,
  };
}

export function saveDraft(input: string, output: string): void {
  try {
    if (input.length + output.length > DRAFT_MAX_CHARS) {
      // 超限：宁可丢草稿也不撑爆配额（配置/历史比草稿重要）
      localStorage.removeItem(K_DRAFT);
      return;
    }
    localStorage.setItem(
      K_DRAFT,
      JSON.stringify({ input, output, ts: Date.now() } satisfies Draft),
    );
  } catch {
    // 配额不足 / 隐私模式禁用 localStorage：草稿丢失不影响主流程
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(K_DRAFT);
  } catch {
    /* 同上 */
  }
}

/** 把原文切成术语数组：换行 / 半角逗号分号 / 全角逗号分号均可 */
export function parseProtectedTerms(raw: string): string[] {
  const seen = new Set<string>();
  for (const t of raw.split(/[\n,;，；、]+/)) {
    const k = t.trim();
    if (k.length >= 2) seen.add(k);
  }
  return [...seen];
}
