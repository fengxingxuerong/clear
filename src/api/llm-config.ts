/**
 * 趣AI味 · API 配置模型与深度闭环常量
 */

import type { RewriteStyle } from "../engine/humanize-primitives";

export type { RewriteStyle };


export interface ApiConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
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
}

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
};

/* ----------------------------- 深度去味闭环常量 ----------------------------- */

/** 达标分：LLM 评判 ≤ 此分即视为"压到了目标以下"，提前收手 */
export const DEEP_TARGET_SCORE = 10;
/** 深度去味最大轮数：UI 提示、分块收敛与主循环统一引用，避免文案与逻辑脱节 */
export const DEEP_MAX_ROUNDS = 4;
