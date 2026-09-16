/**
 * 外部检测器钩子（对标朱雀等）
 * 通用 HTTP 接口：把 {text} POST 到 url，从返回的 JSON 里按 scorePath 取分数。
 * 例：朱雀若有开放接口，把 url/scorePath 配好即可直接拿真实 AI 概率。
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

export async function scoreViaDetector(text: string, cfg: DetectorConfig): Promise<number> {
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
  let n = Number(getPath(data, cfg.scorePath));
  if (!isFinite(n)) throw new Error("无法从响应解析分数");
  if (cfg.scale === "0-1") n = n * 100;
  return Math.max(0, Math.min(100, Math.round(n)));
}
