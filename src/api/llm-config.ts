/**
 * 趣AI味 · API 配置模型与深度闭环常量
 */

import type { RewriteStyle } from "../engine/humanize-primitives";

export type { RewriteStyle };


export interface ApiConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  /** Key 池：多个 Key 换行/逗号分隔，429/401 自动切下一个（与 apiKey 合并去重） */
  apiKeys?: string;
  model: string;
  temperature: number;
  /** 深度模式：多轮"改写→评分→再改写"闭环，直到达标或用完轮数 */
  deepMode: boolean;
  /** 交叉评判模型（可选但强烈建议）：与主模型不同家族，消除自评偏差。 */
  judgeModel: string;
  /** 备选改写模型（可选）：配置后深度模式首轮"双模型竞争"择优。 */
  altModel: string;
  /** 文风预设：casual=自然口语 / plain=平实书面 / academic=学术体保术语 */
  style: RewriteStyle;
  /** 推理强度（可选，仅推理模型如 Ox Alpha / o1 / DeepSeek-R1 支持）：
   *  low / medium / high / max / x-high。max 最强但最慢。
   *  OpenRouter 的推理模型通过 reasoning.effort 参数传入。 */
  reasoningEffort?: "low" | "medium" | "high" | "max" | "x-high";
  /** 深度模式最长等待时间（秒）：0 = 不限制，超过后带当前最优结果收场。
   *  推理模型（Ox Alpha max 档约 50s/轮）跑 4 轮可能 3-4 分钟，用户可设 60/120/300 控制耐心。 */
  maxWaitSeconds?: number;
  /** 深度模式最大 LLM 调用次数（0 = 不限制，v0.8.5）：时间预算之外再给次数预算——
   *  计费类网关按调用计费，一篇深度闭环约消耗 4~6 次（改写+质检+评判），竞争模式首轮翻倍。
   *  粒度说明：轮间检查，轮内不中断，超预算后带当前最优结果收场。 */
  maxApiCalls?: number;
}

/* ---------------------- SenseNova 常驻预置 ----------------------
 * 2026-09-01 实测（3 Key × 5 模型）：
 *   deepseek-v4-flash      ✅ 1.5~3s，改写质量最好 → 默认主力
 *   deepseek-v4-pro        ✅ 2~22s，质量稳但慢     → 备选改写（altModel）
 *   glm-5.2                ✅ 2~16s，思考型（max_tokens≥1024 才有 content）→ 交叉评判
 *   sensenova-6.8-flash-lite ⚠️ 可用但 12s+ 波动大，不预置
 *   kimi-k3                ⚠️ 网关仅允许 temperature=1 且 TPM 限流紧，不预置（chat 已自动适配）
 *   Key1 曾 429（配额）→ Key 池轮换是刚需，不是锦上添花
 * baseUrl 用同源相对路径 /sensenova/v1：dev 由 vite 代理转发、桌面版由 Electron
 * main.js 内置代理转发（网关 OPTIONS 预检 404，浏览器直连必挂）。静态托管 dist
 * 的用户需自备反代或改填 CORS 放行的服务商。
 */
export const SENSENOVA_PRESET = {
  baseUrl: "/sensenova/v1",
  keys: [
    "***REMOVED***",
    "***REMOVED***",
    "***REMOVED***",
  ],
  models: ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2", "sensenova-6.8-flash-lite", "kimi-k3"],
};

export const DEFAULT_API: ApiConfig = {
  enabled: false,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  temperature: 0.9,
  deepMode: true,
  judgeModel: "",
  altModel: "",
  style: "casual",
  reasoningEffort: undefined,
  maxWaitSeconds: 0,
  maxApiCalls: 0,
};

/** 解析 Key 池：apiKey 与 apiKeys 合并去重（换行/逗号/分号分隔均可） */
export function effectiveKeys(cfg: ApiConfig): string[] {
  const raw = [cfg.apiKey || "", cfg.apiKeys || ""].join("\n");
  const seen = new Set<string>();
  for (const k of raw.split(/[\n,;，；]+/)) {
    const t = k.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/* ----------------------------- 深度去味闭环常量 ----------------------------- */

/** 达标分：LLM 评判 ≤ 此分即视为"压到了目标以下"，提前收手 */
export const DEEP_TARGET_SCORE = 10;
/** 深度去味最大轮数：UI 提示、分块收敛与主循环统一引用，避免文案与逻辑脱节 */
export const DEEP_MAX_ROUNDS = 4;
