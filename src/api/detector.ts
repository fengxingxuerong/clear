/**
 * 外部检测器钩子（对标朱雀等）
 * 通用 HTTP 接口：把 {text} POST 到 url，从返回的 JSON 里按 scorePath 取分数。
 * 朱雀官方 API 已于 2026-09 确认可用，见下方 ZHUQUE_OFFICIAL_DETECTOR。
 * 没有外部接口时，用 llm.ts 的 judgeAiScore（复用已配的 LLM）当评判也行。
 */
export interface DetectorConfig {
  enabled: boolean;
  url: string;
  apiKey: string;
  /** JSON 中点路径，如 "score" 或 "data.prob" */
  scorePath: string;
  /** 分数刻度：0-100 或 0-1 */
  scale: "0-100" | "0-1";
}

export const DEFAULT_DETECTOR: DetectorConfig = {
  enabled: false,
  url: "",
  apiKey: "",
  scorePath: "score",
  scale: "0-100",
};

/**
 * 朱雀官方 API 预设——腾讯云 EdgeOne Makers 的内置模型 @makers/zhuque-text。
 * 文档：https://cloud.tencent.com/document/product/1552/137539
 * 逐条按官方文档核对过，并实测过未授权分支（401 + {"error":{...}}）：
 *   - 网关域名是**固定**的，用户不需要自建网关，只在 EdgeOne 控制台 Makers→Models→API Key 建 Key；
 *   - 分数在 softmax_confidence（0~1，「越大越可能命中风险内容」），与网页版「AI 生成概率」同向；
 *     labels_ratio 另给三档占比（0=人工 1=AI 2=疑似AI），需要档位时取那里；
 *   - 每月 50 万 token 免费，扣减按 makers_models_usage.total_tokens 核算（不是 usage.total_tokens）；
 *   - 当前只有文本检测，图片检测要走企业版；
 *   - is_merge 不传即默认 true（合并整篇判定），与网页版一次性给一个总分的口径一致。
 * enabled 保持 false：勾上就等于每跑一次都花外部账号的额度，必须由用户自己开。
 */
export const ZHUQUE_OFFICIAL_DETECTOR: DetectorConfig = {
  ...DEFAULT_DETECTOR,
  url: "https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify",
  scorePath: "softmax_confidence",
  scale: "0-1",
};

/** status 字段白名单。只在响应**自报**状态时开火；没有 status 的第三方接口不受影响。 */
const SUCCESS_STATUS = /^(success|ok|true|passed)$/i;

/**
 * 显式失败信号。要挡的是这种最危险的形态：
 *   HTTP 200 + {"status":"error","msg":"quota exceeded","softmax_confidence":0}
 * 老逻辑只看 scorePath 能不能取到数——取得到 0 就当成「0 分 = 完全人类」，
 * 一次配额耗尽会被记成一次完美的去味成功。getPath 的 null 守卫挡住了路径断裂，
 * 挡不住「路径存在但整体是失败的」，所以这里补上。
 */
function failureSignal(data: Record<string, unknown>): string | null {
  // 全部信号都收进消息里：只报第一个会把「status=error」背后的真实原因
  // （配额耗尽 / 字数不足 / Key 失效）留在暗处，排查时等于没有现场。
  const why: string[] = [];
  const st = data.status;
  if (typeof st === "string" && st.trim() && !SUCCESS_STATUS.test(st.trim())) {
    why.push(`接口自报状态 status=${st.trim()}`);
  }
  const msg = data.msg;
  if (typeof msg === "string" && msg.trim()) why.push(`错误信息：${msg.trim().slice(0, 120)}`);
  const err = data.error;
  if (err != null && err !== false && err !== "") {
    const s = typeof err === "string" ? err : JSON.stringify(err);
    if (s.trim() && s !== "{}" && s !== "[]") why.push(`接口返回错误：${s.slice(0, 120)}`);
  }
  return why.length ? why.join("；") : null;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((o: unknown, k: string) => {
    // 中途断裂必须显式返回 undefined：若原样返回 null，外层 Number(null) === 0，
    // 检测器故障会被静默读成「0 分 = 完全人类」——失败方向最危险的一种。
    if (o == null) return undefined;
    if (typeof o === "object" && k in (o as Record<string, unknown>)) {
      return (o as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

export interface DetectorVerdict {
  /** 0~100 的整数分，与本地 aiScore 同刻度 */
  score: number;
  /** 原始响应：档位占比、本次扣了多少 token 这些只能从这里拿 */
  raw: Record<string, unknown>;
}

/**
 * 送检并保留原始响应。scoreViaDetector 是它的投影——
 * 分开写两份请求逻辑必然出现「守卫只在一处生效」，所以只留这一条出网路径。
 */
export async function classifyViaDetector(
  text: string,
  cfg: DetectorConfig,
): Promise<DetectorVerdict> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) headers["Authorization"] = "Bearer " + cfg.apiKey;
  const resp = await fetch(cfg.url, {
    method: "POST",
    signal: AbortSignal.timeout(30_000), // 防挂起
    headers,
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) throw new Error(`检测器返回 ${resp.status}`);
  const data = await resp.json();
  if (data === null || typeof data !== "object") throw new Error("检测器返回的不是 JSON 对象");
  const fail = failureSignal(data as Record<string, unknown>);
  if (fail) throw new Error(`检测器未给出分数（${fail}）`);
  let n = Number(getPath(data, cfg.scorePath));
  if (!isFinite(n)) throw new Error("无法从响应解析分数");
  if (cfg.scale === "0-1") n = n * 100;
  return { score: Math.max(0, Math.min(100, Math.round(n))), raw: data as Record<string, unknown> };
}

export async function scoreViaDetector(text: string, cfg: DetectorConfig): Promise<number> {
  return (await classifyViaDetector(text, cfg)).score;
}
