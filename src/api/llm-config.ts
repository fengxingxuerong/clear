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
  /**
   * v0.8.9：首轮多候选竞争采样数（默认 1 = 关闭）。仅在<b>未配置 altModel</b> 时生效——
   * 配了 altModel 就走原来的双模型竞争。
   *
   * 依据：专项实测同一 temperature=0.9 的改写稿质量在 20~88 分之间横跳（极差 89），
   * 而评判尺子极稳（同文本重复评判极差 2）——瓶颈是改写采样的运气，不是尺子。
   * 首轮多采 N 稿、评判后取最低分，能直接抹掉"运气差"的下限。
   *
   * 代价：首轮调用数 × N（每稿含改写 + 质检 + 评判）。建议 2~3，配合 maxApiCalls 使用。
   */
  contestSamples?: number;
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
  /** v0.9.4 P1 严格保真模式：财经/新闻/学术等事实敏感场景开启。
   *  背景：实测深度闭环超时/未达标收场时，最后一轮未修复的编造类质检项
   *  （如现编「我见过不少例子」）会随最优稿交付。开启后：收稿前做一轮预算外
   *  定向补偿修订（只修事实错误不追分数），修不掉则保留原稿并在 note 显式警告。 */
  strictFidelity?: boolean;
  /** v0.9.5 P4 人味人格：同一 casual 语体下的风格分档（对抗单一模板被针对）。
   *  default=自然口语（现行范例教学的那套）；netgen=网络世代（句更碎、判断更直接，
   *  禁网络烂梗——绝绝子/yyds 式表演反而是 AI 模仿人类的破绽）；
   *  classic=老派文青（书面骨架+人味态度，垫词降浓度，句有呼吸，结尾留余韵）。 */
  persona?: "default" | "netgen" | "classic";
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
 *
 * v0.8.6 安全改造：Key 不再硬编码。读取优先级：
 *   1) 环境变量 SENSENOVA_KEYS（换行/逗号分隔多个）
 *   2) 开发者本地 scripts/.sensenova-keys（gitignore，格式同上）
 *   3) 都没有 → keys 为空数组，UI「填入 SenseNova 常驻通道」仍可用（用户自己填）
 * 注意：若你从旧版本升级，旧 Key 已随 git 历史泄露，请到商汤后台轮换。
 */
/** v0.8.7 修复后导出：供测试锁死「ESM 下 Key 池不得静默丢失」回归 */
export function loadPresetKeys(): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) return;
    for (const k of raw.split(/[\n,;，；]+/)) {
      const t = k.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  };
  // 1) 环境变量（优先，适合 CI / 一次性运行）
  push(typeof process !== "undefined" ? process.env?.SENSENOVA_KEYS : undefined);
  // 2) 本地非托管文件（适合日常开发；.gitignore 已忽略）
  try {
    // Node 环境（tsx 脚本 / Electron 主进程）才读文件；浏览器构建时 fs 不存在
    if (typeof process !== "undefined" && process.versions?.node) {
      // 取 node:fs / node:path 必须避开静态 import（浏览器构建会被 rollup 解析报错）。
      // 历史教训：此前用 new Function("return require") 在 ESM 下必挂——本项目
      // "type": "module"，脚本全走 ESM，require 未定义被 catch 吞掉后 keys 恒为空，
      // Node 侧 LLM 通道静默失效（v0.8.7 实测发现并修复）。
      // 现按优先级：process.getBuiltinModule（Node ≥22.3，同步且对打包器不可见）
      // → new Function require（CJS 场景如 Electron main 的旧路径兜底）→ 静默降级。
      type FsLike = {
        existsSync(p: string): boolean;
        readFileSync(p: string, enc: string): string;
      };
      type PathLike = { resolve(...parts: string[]): string };
      let fs: FsLike | undefined;
      let path: PathLike | undefined;
      const proc = process as NodeJS.Process;
      if (typeof proc.getBuiltinModule === "function") {
        fs = proc.getBuiltinModule("node:fs") as unknown as FsLike;
        path = proc.getBuiltinModule("node:path") as unknown as PathLike;
      } else {
        try {
          const nodeRequire = new Function("return require") as () => (m: string) => unknown;
          const req = nodeRequire();
          fs = req("node:fs") as FsLike;
          path = req("node:path") as PathLike;
        } catch {
          // ESM 且无 getBuiltinModule 的老 Node：放弃文件读取（env 变量路径仍可用）
        }
      }
      if (fs && path) {
        const candidates = [
          path.resolve(process.cwd(), "scripts/.sensenova-keys"),
          path.resolve(process.cwd(), "../scripts/.sensenova-keys"),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) {
            push(fs.readFileSync(p, "utf-8"));
            break;
          }
        }
      }
    }
  } catch {
    // 浏览器/无文件系统环境静默降级
  }
  return out;
}

export const SENSENOVA_PRESET = {
  baseUrl: "/sensenova/v1",
  keys: loadPresetKeys(),
  models: [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "glm-5.2",
    "sensenova-6.8-flash-lite",
    "kimi-k3",
  ],
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
  // v0.9.8 P0 收敛（七）：默认风格 casual → plain。
  //
  // 实测依据（scripts/_style_cost.ts，4 组真实 AI 文本 × 4 档 × 20 seed = 320 次）：
  //
  //   文本             原文   casual 成功/均值/max    plain 成功/均值/max
  //   A 公众号议论文     39    69/80 · 14.7 / 38       80/80 · 11.7 / 20
  //   B 工作总结        12    76/80 ·  8.0 / 34       80/80 ·  3.4 /  8
  //   C 产品介绍         6    80/80 ·  2.9 / 24       80/80 ·  1.4 /  6
  //   D 议论文长文       18    76/80 ·  4.3 / 40       80/80 ·  0.8 /  8
  //
  // plain 四组全部 80/80 通过且 max 全在 20 以下；casual 三组漏判、max 冲到 38/34/40。
  // 交叉验证（scripts/_inj_ab.ts）：casual 的污染上界 T1=100 / T2=56 / T4=40，
  // plain 对应 56 / 30 / 16。差异全部来自 casual 独有的四个口语注入器
  // （injectParentheticals / injectOpinion / injectParentheticNotes / injectFragments）。
  //
  // 关键反直觉点：plain 不是"去味更弱"而是"去味更强"。
  // 原先的假设是 casual 更口语化 → 更像人 → 分数更低，实测相反：
  // 引擎的"口语化手法"就是往文本里塞垫词，而垫词正是标尺判定的机器味。
  // casual 等于一边拆机器味、一边造机器味。
  //
  // 另验证（scripts/_dialogue_style.ts）：casual 在对话/叙事/人写三体裁上
  // 与 plain、academic 完全同分（这些体裁本就被 skipSelfQA 挡住注入器），
  // 即 casual 没有任何一个体裁上的量化优势。
  style: "plain",
  reasoningEffort: undefined,
  maxWaitSeconds: 0,
  maxApiCalls: 0,
  contestSamples: 1,
  // v0.9.5 补默认值：此前 DEFAULT_API 与 store.loadApi 均漏这两个字段，
  // 导致设置面板里勾了「严格保真」/选了「人味人格」，刷新后静默回默认——
  // 而 strictFidelity 正是编造复核的开关，静默失效等于防线漏空。
  strictFidelity: false,
  persona: "default",
};

/**
 * 拆分 Key 串：换行/半角逗号分号/全角逗号分号均可，去空白、去重、保序。
 * 全角必须支持——设置面板是中文界面，用户复制粘贴时带「，」「；」是常态；
 * 只认半角会导致第二个之后的 Key 被静默吞掉（表现：明明填了 3 个 Key 却照样 429）。
 * 全局唯一实现：multi-roles 读本地 Key 文件也走这里，避免两套规则漂移。
 */
export function splitKeys(raw: string): string[] {
  const seen = new Set<string>();
  for (const k of raw.split(/[\n,;，；]+/)) {
    const t = k.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** 解析 Key 池：apiKey 与 apiKeys 合并去重（换行/逗号/分号分隔均可） */
export function effectiveKeys(cfg: ApiConfig): string[] {
  return splitKeys([cfg.apiKey || "", cfg.apiKeys || ""].join("\n"));
}

/* ----------------------------- 深度去味闭环常量 ----------------------------- */

/** 达标分：LLM 评判 ≤ 此分即视为"压到了目标以下"，提前收手 */
export const DEEP_TARGET_SCORE = 10;
/** 深度去味最大轮数：UI 提示、分块收敛与主循环统一引用，避免文案与逻辑脱节 */
export const DEEP_MAX_ROUNDS = 4;

/**
 * v0.9.5 竞争段自适应阈值：可见字符数超过此值的文本，竞争段自动降级为
 * 「仅主力模型首稿」，不再双模型/多采样赛马。
 *
 * 实测依据（2026-09-12）：1200 字文本双模型竞争在 420s 预算内零产出
 * （deepseek-v4-pro 对长文极慢，整篇回退本地）；而短文竞争有真实收益
 * （s6 小说 pro 14 分 vs flash 39 分，pro 大幅胜出）。阈值取 600：
 * 覆盖 CHUNK_SIZE=1000 的分块场景（分块后单块 ≤1000 字，仍可赛马），
 * 同时把实测必超时的单篇长文挡在赛马之外。
 */
export const ADAPTIVE_CONTEST_CHARS = 600;
