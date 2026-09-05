/**
 * 趣AI味 · 朱雀语义层（LLM 检测员 · 篇章/语义层专用提示词）
 *
 * 项目 2026-08-30 官方实测结论：朱雀主要看**语义与篇章规律**（指代链、因果推进、
 * 论点骨架、段落节奏），而本地启发式只看得见表层（词汇/句法/格式）。这一层让
 * 已配置的 LLM 专司"朱雀式篇章检测"——提示词按官方实测抓法定制，区别于
 * llm-judge 的通用检测员提示词（那个为去味修订设计，偏表层痕迹）。
 *
 * 诚实边界：LLM 不是朱雀，同一文本不同模型评分会漂移（实测 20~80），
 * 只作为第二层证据参与 fuseLayers 加权，不单独定档。
 */

import { judgeScoreStable } from "./llm-judge";
import { effectiveKeys, type ApiConfig } from "./llm-config";
import type { SemanticLayer } from "../engine/zhuque";

/** 朱雀检测员提示词：按官方实测的篇章层抓法出题（区别于通用表层检测）。
 *  v0.8.3：补第 6 维「表演性人味」——官方对深度改写稿仍实测给出 98.47%（样本 D 去味稿），
 *  说明官方能识别"表层伪装的人味"：编造轶事、语气词堆叠、刻意碎句这类表演痕迹。
 *  提示词同时作为深度去味闭环的收敛目标（llm-quality 评分走此提示词），优化目标=检测目标。 */
export const ZHUQUE_DETECT_SYSTEM = `你是基于腾讯混元的 AI 文本检测引擎"朱雀"的复刻检测员，只关注语义与篇章层，不关心个别用词的对错。逐项审查这段中文文本：

1. 论点骨架：是否是标准的"总-分-总"或"提纲式展开"？分论点是否工整对仗、每段首句是否像小标题？
2. 指代链：代词和指代是否具体落地？还是全文都在空转泛指（"我们""人们""这"无锚点）？
3. 因果推进：论证是逐层推进、有真实取舍，还是"一方面/另一方面"式的并列罗列、观点不产生摩擦？
4. 段落节奏：段落长度与信息密度是否均匀得像模板填充？有没有信息密度突然变化的人类痕迹？
5. 具体性：事件、时间、场景是否可落地验证？还是停留在抽象概括层（"提升了效率""带来了挑战"）？
6. 表演性人味：有没有刻意伪装的人味——编造的轶事朋友、堆叠的语气词（啊/吧/呢连用）、刻意碎句、口头禅复读？真人随手写不会到处撒"说真的""说白了"。
7. 反检测引擎指纹（v0.8.6 新增，实测盲区）：有没有去味工具注入的"过度人味"——句尾刻意挂语气词（"行业呀""本质嗯"）、自问自答模板（"你可能会问""有人要抬杠了"）、硬造的口语对仗（"效率上去，成本下来"式刻意的工整口语）、转折词机械轮换（可是/不过/话说回来按序出现）、模仿口语却露怯的表达（"可麻烦跟着就来了"）？这些是改写工具注入的特征，真人随机写作不会这么密集地"表演随意"。

注意：表层伪装（换了几个口语词、删了几个"然而"）不改写篇章规律的，照样判 AI——官方对只做表层润色的改写稿仍然给高分。

第一步：列出命中的篇章层痕迹，最多 6 条，每条不超过 18 个字，一行一条（没命中的维度不要硬凑；第 7 维反检测引擎指纹命中时优先列出）。
第二步：最后一行单独输出一个 0 到 100 的整数，表示该文本被朱雀判为 AI 生成内容的综合概率（100=几乎必然判AI，0=几乎必然判人写）。参考口径：典型 AI 议论文 95+，只做表层润色的改写稿 85+，篇章真被打散的深度改写稿 40~70，带反检测引擎指纹的过度人味稿 45~65，真人随笔 <20。按真实判断打分。
除了痕迹清单和最后的数字，不要输出任何其他内容。`;

/** 朱雀语义层稳定检测：交叉模型均值 / 单模型中位数（复用 llm-judge 的稳健聚合）。
 *  默认带 localStorage 缓存（键 = 文本指纹 + 模型签名）：同一文本重复检测不重复烧 API；
 *  bypassCache=true 时强制真跑（面板「重跑语义层」按钮用）。 */
export async function detectSemanticStable(
  text: string,
  cfg: ApiConfig,
  opts: { bypassCache?: boolean } = {},
): Promise<SemanticLayer> {
  if (!opts.bypassCache) {
    const hit = loadSemanticCache(text, cfg);
    if (hit) return { ...hit, source: hit.source + "（缓存）" };
  }
  const r = await judgeScoreStable(text, cfg, 3, ZHUQUE_DETECT_SYSTEM);
  const cross = cfg.judgeModel.trim() && cfg.judgeModel.trim() !== cfg.model;
  const source = cross
    ? `朱雀检测员提示词 · ${cfg.model} + ${cfg.judgeModel}（交叉取均值）`
    : `朱雀检测员提示词 · ${cfg.model}（3 次取中位数）`;
  const sem: SemanticLayer = { score: r.score, critique: r.critique, source };
  saveSemanticCache(text, cfg, sem);
  return sem;
}

/** 语义层可用性判定（Key 池口径，与 UI 守卫一致） */
export function semanticAvailable(cfg: ApiConfig): boolean {
  return cfg.enabled && effectiveKeys(cfg).length > 0;
}

/* ----------------------------- 语义层缓存 -----------------------------
 * 同一段文本重复点「补语义层」每次真烧 2 次 LLM 调用（主+交叉），成本最高的一层。
 * 缓存键 = 文本指纹 + 模型签名：换主模型/评判模型即视为不同评分，绝不串味。
 * 存 localStorage，上限 50 条按时间淘汰；LLM 评分有漂移，「重跑」按钮显式绕过。
 */

const K_SEM_CACHE = "quaiwei.zhuque.semcache";
const SEM_CACHE_MAX = 50;

/** FNV-1a 32 位文本指纹 + 长度后缀（零依赖，长文碰撞概率可忽略） */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + s.length.toString(36);
}

function semanticCacheKey(text: string, cfg: ApiConfig): string {
  return `${textHash(text)}|${cfg.model}|${cfg.judgeModel.trim()}`;
}

function readSemanticCache(): Record<string, SemanticLayer & { ts: number }> {
  try {
    const raw = localStorage.getItem(K_SEM_CACHE);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, SemanticLayer & { ts: number }>;
    }
  } catch {
    /* 解析失败按空缓存处理 */
  }
  return {};
}

export function loadSemanticCache(text: string, cfg: ApiConfig): SemanticLayer | null {
  const hit = readSemanticCache()[semanticCacheKey(text, cfg)];
  if (!hit || typeof hit.score !== "number" || !isFinite(hit.score)) return null;
  return {
    score: Math.max(0, Math.min(100, hit.score)),
    critique: hit.critique ?? [],
    source: hit.source ?? "",
  };
}

export function saveSemanticCache(text: string, cfg: ApiConfig, sem: SemanticLayer): void {
  try {
    const cache = readSemanticCache();
    cache[semanticCacheKey(text, cfg)] = { ...sem, ts: Date.now() };
    // 升序取末尾 50 条 = 保留最新：同毫秒写入时稳定排序仍按插入序，最旧的正确出局
    const entries = Object.entries(cache)
      .sort((a, b) => (a[1].ts ?? 0) - (b[1].ts ?? 0))
      .slice(-SEM_CACHE_MAX);
    localStorage.setItem(K_SEM_CACHE, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 存储不可用则静默跳过（语义层本身不受影响） */
  }
}
