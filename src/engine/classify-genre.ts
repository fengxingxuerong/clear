/**
 * v3 自动体裁识别（BenchmarkPanel OLS 公式自动选曲用，也可给引擎做 P3 门控前置）
 *
 * 三分法输出：main(论说) / narrative(叙事) / dialogue(对话)，另外 "human" 纯人写不自动选
 *   → 理由：纯人写稿 vs 去味后的 AI 稿在表层特征上高度重合，自动选容易误判；
 *     只有用户明确勾选「这是纯人写原稿」时才切换到 human 负斜率公式。
 *
 * 启发式特征（无需训练、毫秒级）：
 *   (A) Dialogue 对话信号
 *     - dlgQuoteRatio  每100字中「」或""包裹的发言次数（「小明：好呀」/「他说"行"」）
 *     - dlgColonRatio  句子开头 "1~8字角色名 + [：:]" 的占比（小明：我去 / 主持人：各位好）
 *     - dlgShortTurn   句长 ≤5 的独立短句子占比（"嗯。"/"好。"/"为什么？"——对话体天然多）
 *   (B) Expository 论说信号
 *     - expoScore      classifyExpositionScore 的结果（≥0.55 = 论说文置信度高，P3 用的同一个指标）
 *   (C) Narrative 叙事信号
 *     - narPastRatio   每100字「了/过/已经/曾/曾经/刚刚/刚才」等过去时词汇
 *     - narSceneRatio  每100字「在…里/旁/中/家/学校/路上/房间/办公室/城市/国家」等场景指示
 *
 * 决策顺序（有优先级，先判高信度体裁再回落）：
 *   1. IF dlgQuoteRatio ≥ 0.05  OR  dlgColonRatio ≥ 0.15  →  dialogue（对话体）
 *   2. IF expoScore ≥ 0.55  →  main（论说文）
 *   3. IF narPastRatio ≥ 0.025  AND  narSceneRatio ≥ 0.018  AND  expoScore < 0.50  →  narrative（叙事文）
 *   4. 否则 回落  expoScore ≥ 0.35 ? main : narrative
 *
 * 返回 { genre, confidence, rawFeatures }，BenchmarkPanel 用 genre 选下拉、confidence 展示徽章。
 */
import { classifyExpositionScore } from "./humanize-shuffle.ts";

export type AutoGenre = "main" | "narrative" | "dialogue";

export interface GenreFeatures {
  /** 每 1 字单位的发言引号数（「」/ ""）*/
  dlgQuoteRatio: number;
  /** 每句的「角色名(+职称括号) + 冒号」开头占比 (0~1) — 兼容「小明：/张总（项目经理）：/李工_前端：：」等剧本格式 */
  dlgColonRatio: number;
  /** 句长 ≤5 字的独立句占比 (0~1) */
  dlgShortTurn: number;
  /** 剧本场景块的密度 (【…】中含「场景/人物/地点/时间」关键字的次数/字) */
  dlgSceneBlockRatio: number;
  /** classifyExpositionScore (0~1) 论说文指标，≥0.55=高置信 */
  expoScore: number;
  /** 每 1 字单位的过去时词汇数（了/过/曾/已经…）*/
  narPastRatio: number;
  /** 每 1 字单位的场景指示词汇数（在…里/旁/中等结构）*/
  narSceneRatio: number;
  /** 纯字字符数（不含标点），用于归一化 */
  pureChars: number;
  /** 句子总数 */
  sentCount: number;
}

export interface GenreResult {
  genre: AutoGenre;
  /** 0~1 的启发式置信度，用于徽章展示 */
  confidence: number;
  /** 命中的规则编号，可调试 */
  ruleHit: 1 | 2 | 3 | 4;
  /** 所有原始特征值（可用于调试面板展开）*/
  features: GenreFeatures;
}

/** 极简中文分句子（避免对 splitSentences 的循环依赖，分类器要能单独使用）*/
function splitSentencesLight(text: string): string[] {
  if (!text) return [];
  // 先在标点处切开，保留结尾标点
  const pieces: string[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if ("。！？!?".includes(ch) || ch === "…") {
      // 再吸收可能的叠词（……、！！、？？）
      let j = i + 1;
      while (j < text.length && "。！？!?…".includes(text[j])) { buf += text[j]; j++; }
      i = j - 1;
      pieces.push(buf);
      buf = "";
    }
  }
  if (buf.trim().length > 0) pieces.push(buf);
  return pieces.filter(s => s.trim().length > 0);
}

function pureLen(s: string): number {
  return (s.match(/[\u4e00-\u9fa5A-Za-z0-9]/g) ?? []).length;
}

export function classifyGenre(text: string): GenreResult {
  const empty = (): GenreFeatures => ({
    dlgQuoteRatio: 0, dlgColonRatio: 0, dlgShortTurn: 0, dlgSceneBlockRatio: 0,
    expoScore: 0, narPastRatio: 0, narSceneRatio: 0,
    pureChars: 0, sentCount: 0,
  });
  if (!text || text.trim().length < 30) {
    return { genre: "main", confidence: 0.3, ruleHit: 4, features: empty() };
  }

  const sents = splitSentencesLight(text);
  const pure = pureLen(text);
  const f: GenreFeatures = {
    dlgQuoteRatio: 0, dlgColonRatio: 0, dlgShortTurn: 0, dlgSceneBlockRatio: 0,
    expoScore: classifyExpositionScore(text),
    narPastRatio: 0, narSceneRatio: 0,
    pureChars: pure, sentCount: sents.length,
  };

  if (pure < 20) return { genre: "main", confidence: 0.35, ruleHit: 4, features: f };

  // —— (A) Dialogue 特征 ——
  // 「…」发言匹配 + "…"发言（英文双引号内中文 ≥2 字）
  const cornerQuotes = (text.match(/「[^」]{2,60}」/g) ?? []).length;
  const dblQuotes    = (text.match(/"[^"]{2,60}"/g) ?? []).length;
  f.dlgQuoteRatio = (cornerQuotes + dblQuotes) / Math.max(1, pure);

  // 冒号台词开头：
  //  v2 归档对话剧本式：「张总（项目经理）：」「李工（前端负责人）：」
  //  聊天式：「小明：」「主持人_小A：」
  //  放宽：句首 1~24 字符，允许中英文、数字、下划线、中英文括号，最后一个字符是冒号/全角冒号
  let colonHits = 0;
  const colonRe = /^[\u4e00-\u9fa5A-Za-z0-9_\-\s（）()【】[]]{1,24}?[：:]/;
  for (const s of sents) {
    const trimmed = s.trimStart();
    if (colonRe.test(trimmed)) colonHits++;
  }
  f.dlgColonRatio = colonHits / Math.max(1, sents.length);

  // 剧本场景块：【场景：…】/【人物：…】/【地点：…】/【时间：…】类头部关键字
  const sceneBlockRe = /【[^】]{0,40}(?:场景|人物|角色|地点|时间|背景)[^】]{0,40}】/g;
  const sceneBlocks = (text.match(sceneBlockRe) ?? []).length;
  f.dlgSceneBlockRatio = sceneBlocks / Math.max(1, pure);

  // 短句（≤5 字）占比
  let shortHits = 0;
  for (const s of sents) if (pureLen(s) <= 5 && pureLen(s) >= 1) shortHits++;
  f.dlgShortTurn = shortHits / Math.max(1, sents.length);

  // —— (C) Narrative 特征 ——
  // 过去时指示词：作为独立特征做中文词级计数，避免双计"已经了"之类
  const pastRe = /(了|曾|曾经|已经|方才|刚刚|刚才|此前|先前|后来|之后|以前|从前|去年|昨天|前天|前几日|上周|上个月|去年)(?!的话)/g;
  const pastHits = (text.match(pastRe) ?? []).length;
  f.narPastRatio = pastHits / Math.max(1, pure);

  // 场景指示：以「在 / 到 / 从 / 来到」+ 地点结尾词 为骨架
  const sceneRe = /(?:在|到|从|来到|去到|去了|回了)[\u4e00-\u9fa5A-Za-z0-9]{1,12}?(?:里|外|旁|中|上|下|家|学校|教室|公司|办公室|房间|客厅|卧室|厨房|路上|街|城市|小镇|村庄|国|省|市|区|机场|车站|码头|医院|商店|餐厅|公园|学校|山|河|海边|森林|草原|沙漠|楼|门|口|前|后)/g;
  const sceneHits = (text.match(sceneRe) ?? []).length;
  f.narSceneRatio = sceneHits / Math.max(1, pure);

  // —— 决策 ——
  // Rule 1：对话体：优先判（对话体自带强句法特征，误判率低）
  //   · 【剧本场景块】出现 → 对话概率极高（只有剧本/访谈才写【场景：X】【人物：Y】）
  //   · 冒号开头 ≥ 6% 或 引号 ≥ 5%（单特征足够）
  //   · 综合得分：四个对话特征累积加权 ≥ 0.28 也判对话（覆盖短对话碎片）
  const dlgComboScore = Math.min(1,
      (f.dlgSceneBlockRatio > 0      ? 0.35 : 0)
    + (f.dlgColonRatio      >= 0.06 ? 0.30 : (f.dlgColonRatio / 0.06) * 0.30)
    + (f.dlgQuoteRatio      >= 0.05 ? 0.25 : (f.dlgQuoteRatio / 0.05) * 0.25)
    + (f.dlgShortTurn       >= 0.25 ? 0.12 : (f.dlgShortTurn / 0.25) * 0.12)
  );
  if (f.dlgSceneBlockRatio > 0 || f.dlgQuoteRatio >= 0.05 || f.dlgColonRatio >= 0.06 || dlgComboScore >= 0.28) {
    const conf = Math.min(0.95, dlgComboScore > 0 ? 0.45 + dlgComboScore * 0.55 : 0.6);
    return { genre: "dialogue", confidence: conf, ruleHit: 1, features: f };
  }

  // Rule 2：论说文：用已有 classifyExpositionScore ≥ 0.55（P3 门控阈值，已验证）
  if (f.expoScore >= 0.55) {
    const conf = Math.min(0.92, 0.5 + (f.expoScore - 0.55) * 2 + (f.narPastRatio < 0.012 ? 0.08 : 0));
    return { genre: "main", confidence: conf, ruleHit: 2, features: f };
  }

  // Rule 3：叙事文：有"过去时 + 场景"联合证据，且论说分不高
  if (f.narPastRatio >= 0.025 && f.narSceneRatio >= 0.018 && f.expoScore < 0.50) {
    const conf = Math.min(0.9, 0.35
      + Math.min(0.25, (f.narPastRatio - 0.025) * 6)
      + Math.min(0.2,  (f.narSceneRatio - 0.018) * 8)
      + (f.dlgQuoteRatio < 0.02 ? 0.08 : 0)
    );
    return { genre: "narrative", confidence: conf, ruleHit: 3, features: f };
  }

  // Rule 4：回落——论说分偏低 (<0.35) 且 过去时略多 → 叙事，否则默认论说（最安全的选择）
  const fallNarrative = f.expoScore < 0.35 && f.narPastRatio >= 0.012;
  const genre: AutoGenre = fallNarrative ? "narrative" : "main";
  const confBase = genre === "main"
    ? Math.max(0.4, 0.35 + f.expoScore * 0.4)
    : Math.max(0.4, 0.35 + (f.narPastRatio * 8) + (f.narSceneRatio * 6));
  return { genre, confidence: Math.min(0.75, confBase), ruleHit: 4, features: f };
}

/** 给 UI 用的中文名字映射 */
export const GENRE_ZH: Record<AutoGenre, string> = {
  main: "论说文",
  narrative: "叙事文",
  dialogue: "对话体",
};
