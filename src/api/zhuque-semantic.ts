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

/** 朱雀检测员提示词：按官方实测的篇章层抓法出题（区别于通用表层检测） */
export const ZHUQUE_DETECT_SYSTEM = `你是基于腾讯混元的 AI 文本检测引擎"朱雀"的复刻检测员，只关注语义与篇章层，不关心错别字和个别用词。逐项审查这段中文文本：

1. 论点骨架：是否是标准的"总-分-总"或"提纲式展开"？分论点是否工整对仗、每段首句是否像小标题？
2. 指代链：代词和指代是否具体落地？还是全文都在空转泛指（"我们""人们""这"无锚点）？
3. 因果推进：论证是逐层推进、有真实取舍，还是"一方面/另一方面"式的并列罗列、观点不产生摩擦？
4. 段落节奏：段落长度与信息密度是否均匀得像模板填充？有没有信息密度突然变化的人类痕迹？
5. 具体性：事件、时间、场景是否可落地验证？还是停留在抽象概括层（"提升了效率""带来了挑战"）？

第一步：列出命中的篇章层痕迹，最多 5 条，每条不超过 18 个字，一行一条（没命中的维度不要硬凑）。
第二步：最后一行单独输出一个 0 到 100 的整数，表示该文本被朱雀判为 AI 生成内容的综合概率（100=几乎必然判AI，0=几乎必然判人写）。参考口径：典型 AI 议论文 95+，深度改写稿 60~85，真人随笔 <20。按真实判断打分。
除了痕迹清单和最后的数字，不要输出任何其他内容。`;

/** 朱雀语义层稳定检测：交叉模型均值 / 单模型中位数（复用 llm-judge 的稳健聚合） */
export async function detectSemanticStable(
  text: string,
  cfg: ApiConfig,
): Promise<SemanticLayer> {
  const r = await judgeScoreStable(text, cfg, 3, ZHUQUE_DETECT_SYSTEM);
  const cross = cfg.judgeModel.trim() && cfg.judgeModel.trim() !== cfg.model;
  const source = cross
    ? `朱雀检测员提示词 · ${cfg.model} + ${cfg.judgeModel}（交叉取均值）`
    : `朱雀检测员提示词 · ${cfg.model}（3 次取中位数）`;
  return { score: r.score, critique: r.critique, source };
}

/** 语义层可用性判定（Key 池口径，与 UI 守卫一致） */
export function semanticAvailable(cfg: ApiConfig): boolean {
  return cfg.enabled && effectiveKeys(cfg).length > 0;
}
