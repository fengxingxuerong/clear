/**
 * 趣AI味 · 核心替换引擎
 *
 * 把 AI 文本里那些"机器味"特征——套话连接词、书面腔词汇、句式高度均匀（低 burstiness）、
 * 标点过度规整——替换成更口语、更跳脱的自然写法。
 *
 * 领域边界：
 *  - 替换规则（replaceVocab / replaceTemplates / dropLeadingConnectives 等） ← 本文件
 *  - 朱雀增强（injectDialect / injectParentheticals 等） ← 本文件
 *  - 机械扰动（mechanicalShuffle / crossChunkCleanup 等） ← humanize-shuffle.ts
 *  - 评分/指纹/忠实校验（aiScore / fingerprintCheck 等） ← humanize-metrics.ts
 *  - 共享原语（rng / 统计 / 切分工具） ← humanize-data.ts
 *
 * 本文件不依赖任何第三方库，浏览器 / Node 直接跑。
 * 注意：内置的 AI 味评分只是"朱雀类检测器"的本地启发式代理分，不是官方分。
 */

import {
  VOCAB,
  INTERJECTIONS,
  startsWithConnector,
  SOFT_ENDINGS,
  fragmentCanStand,
  FORMULAIC,
  guardBlocks,
  isSceneBlockLine,
  isScriptFormatLine,
  isCJK,
  splitSentences,
  pick,
  DIALECT_ENTRIES,
  PARENTHETICALS,
  SENTENCE_FRAGMENTS,
  OPINION_PHRASES,
  PARENTHETIC_NOTES,
  makeRng,
  findSplitPoint,
  HumanizeOptions,
  RewriteStyle,
} from "./humanize-data.ts";

// v0.9.53 拆分阶段 1a：替换规则 + 概率/阈值 + FORMAL_FORBIDDEN_SUBSTITUTES + wouldCascade
// （原为本文件内联定义，详见 docs/humanize-split-plan.md）
import {
  SOFT_ENDING_PROB,
  SOFT_TAIL_PROB,
  SPLIT_SENTENCE_THRESHOLD,
  SPLIT_SENTENCE_RATE,
  MERGE_SENTENCE_THRESHOLD,
  MERGE_SENTENCE_PREV_MAX,
  MERGE_SENTENCE_RATE,
  INTERJECTION_RATE,
  wouldCascade,
  DIR_MODIFIER_VERB_CLASH_RE,
  FORMAL_FORBIDDEN_SUBSTITUTES,
} from "./humanize-rules.ts";

import {
  SCENE_BLOCK_LINE_RE,
  countVocabTokens,
  dropLeadingConnectives,
  relaxIntensifierVerb,
  relaxLe,
  relaxRedundantVerb,
  replaceOpener,
  replaceTemplates,
  replaceVocab,
  replaceWithDevelopment,
  softenPassive,
} from "./humanize-replace.ts";

import {
  relaxEmDash,
  relaxDunhao,
  relaxColon,
  relaxQuotes,
  splitOnConnectors,
  dedupePadWords,
  limitPunctuation,
  injectHalfWidth,
  stripCJKEdgeSpaces,
  stripAICliches,
  stripLeadingConnectivesHard,
  boostBurstinessSingle,
  reframeConcessives,
  crossChunkCleanup,
  mechanicalShuffle,
  resegmentParagraphsAggressive,
  injectSelfQA,
  injectHumanTypos,
  structuralShuffleParagraph,
  // v3 P4+P5 最终清尾（humanize() return 前最后一步调用）
  ensureEmDashCountHardCap,
  capParticleSentenceDensity,
  boostBurstinessByCutting,
  replaceGuardedFormulaicDerivs,
  clampAvgSentenceLenUnder25,
} from "./humanize-shuffle.ts";

import {
  countPadHeads,
  emitStage,
  nowMs,
  PAD_INJECT_CAP,
  REPORTING_DAO_RE,
  type StageTrace,
} from "./humanize-primitives.ts";

import {
  aiScore,
  burstinessOf,
  ScoreBreakdown,
  fingerprintCheck,
  FingerprintReport,
  FingerprintIssue,
  checkFidelityLocal,
  FidelityReport,
  collapseIssues,
  pplIssues,
  PPL_MIN_MEAN_NLL,
  PPL_MAX_WIN_STD,
  AI_SCORE_HUMAN_MAX,
} from "./humanize-metrics.ts";

// v0.9 反「新指纹」层：模板复读封顶 / 语体门控 / 残句守卫 / 场景块保护
import {
  capLongTemplateRepetition,
  guardFormalRegister,
  collapseDoubleConnectives,
  fixOrphanConnectiveLeads,
  isSceneMetaSentence,
  fixBrokenCollocations,
  isSpecTableParagraph,
} from "./anti-fingerprint.ts";

// P7 引擎级体裁联动：自动体裁识别 + 每体裁参数旋钮
import { classifyGenre, AutoGenre, suppressSelfQA } from "./classify-genre.ts";
import { keepOnlyIfDetectDrops } from "./detector.ts";
export { wouldCascade, DIR_MODIFIER_VERB_CLASH_RE, FORMAL_FORBIDDEN_SUBSTITUTES };
// scripts/scan-bugs.ts 的未然从句补「了」探针与引擎守卫共用同一条正则（v0.9.53 起住在 humanize-replace.ts）
export { PURPOSE_LE_RE, NORMATIVE_LE_RE } from "./humanize-replace.ts";

// 公开 API 面：这些符号从本文件被 App.tsx / llm.ts / 测试文件导入
export {
  isCJK,
  splitSentences,
  pick,
  guardBlocks,
  fragmentCanStand,
  startsWithConnector,
  VOCAB,
  FORMULAIC,
  // 机械扰动
  crossChunkCleanup,
  mechanicalShuffle,
  // 评分/指纹/忠实校验
  aiScore,
  fingerprintCheck,
  checkFidelityLocal,
  collapseIssues,
  pplIssues,
  PPL_MIN_MEAN_NLL,
  PPL_MAX_WIN_STD,
};
export type {
  RewriteStyle,
  HumanizeOptions,
  ScoreBreakdown,
  FingerprintReport,
  FingerprintIssue,
  FidelityReport,
  StageTrace,
};

/* ---------------- v0.9.8 强度斜坡（RAMP）---------------- */
/**
 * 强度斜坡：把 [RAMP_START, RAMP_END] 区间的有效注入强度从 0 线性升到 intensity。
 *
 * 起因（scripts/archive/_stability.ts 全档位扫描）：
 *   0.35 档近乎干净（叙事均值 2.4），0.40 档突然爆分（叙事均值 23.4，最差 55）——
 *   用户把强度上调 0.05，输出质量断崖式下降，体验上像"开关"而不是"旋钮"。
 *
 * 真凶（scripts/_punct_probe.ts 标点剖面）：
 *   不是"注入器撒得太多"，而是**两条句子级开关的阈值错位**：
 *     · "过短句与前句合并" 概率跟着 intensity 线性爬，0.35→0.40 已能命中；
 *     · 唯一能对冲的切句力量 boostBurstinessSingle 挂在 `intensity > 0.4` 严格比较上。
 *   0.40 档因此处于"合并开着、切句没开"的状态，句长单向膨胀
 *   （原文 句号5/逗号6 → 0.40 档 句号2/逗号9，avgLen 20.4 → 52.5）。
 *
 * 修法：
 *   ① 把上述两条句子级开关的概率从 intensity 换成 eff（本函数返回值）；
 *   ② 注入器（injectParentheticals / injectOpinion / injectParentheticNotes /
 *      injectFragments）的概率同样换成 eff。
 *   0.60 以上 ramp=1，行为与原实现完全一致，高档位的完整注入能力不受影响。
 *
 * 区间取 [0.35, 0.60] 的理由：
 *   0.35 是原硬门槛（起点应接近零）；0.60 是既有 `>= 0.55` 结构层
 *   与 `>= 0.65` 模板封顶的激活带起点，把斜坡终点放在这里，
 *   让这些既有阈值继续在"已完全放开"的区间里工作，不改变它们的行为。
 */
const RAMP_START = 0.35;
const RAMP_END = 0.6;

function rampFactor(intensity: number): number {
  return Math.max(0, Math.min(1, (intensity - RAMP_START) / (RAMP_END - RAMP_START)));
}

/** 有效注入强度：低档位被斜坡压到 ≈0，0.60 档起等于 intensity 本身。 */
function effectiveIntensity(intensity: number): number {
  return intensity * rampFactor(intensity);
}

/* ---------------- P7 引擎级体裁联动：每体裁参数旋钮（Genre Knobs） ---------------- */
/**
 * 论说/叙事/对话/人写四体裁的反检测最优参数（由 v2/v3 OLS 12 点标定 + P3~P6 实战回放得出）。
 * 理由：
 *  · avgLenTarget：论说文是 AI 的重灾区，句子越长越"规整三部曲"→ 压到 23；
 *                 叙事文有大量场景/动作/对话，天然短句多，留到 28 即可；
 *                 对话体台词可能偏长表达，再放宽到 32；
 *                 humanHand 不做硬切段（怕破坏原稿节奏→官分反涨），target 设为无压力的 36。
 *  · burstTarget：论说文最怕"句式高度均匀"，需要极高 CV≥0.63 才能过朱雀；
 *                 叙事/对话天然节奏起伏大，依次放宽；
 *                 humanHand 只需最低可接受值 0.50，避免过度插入锚点破坏行文。
 *  · intensityCap：只有 humanHand 有强制上限 0.48（v2 标定其斜率为负，越去味官分越高）；
 *                  其他三体裁无上限，交给用户滑块自由控制。
 *  · disableZhuque：只有 humanHand 强制关闭朱雀增强（负斜率特征，叠加方言/自问自答会官分跳升）。
 *  · expoForceP3：只有论说 + 强度≥0.75 才强制 P3（覆盖 expoScore 略低于 0.55 的边缘论说文）。
 *     ⚠️ 叙事 / 人写两档里的 `() => false` 是**永不执行**的（2026-10-05 复核）：
 *     本字段唯一调用点在结构层入口（下方 `if (intensity >= 0.55 && structuralAllowedGenre)` 内），
 *     而 narrative / humanHand 恰好被 structuralAllowedGenre 挡在结构层之外，
 *     故这两行的行覆盖恒为 0 —— 属设计使然，不是漏测，别为凑覆盖率把调用硬塞进去。
 *     真要消除它：把这两档的字段与调用点一起收进结构层分支，而不是造一次假调用。
 *  · skipSceneInject：只有对话体需要（剧本【场景/人物/背景】块不塞自问自答，避免违和）。
 */
// v0.9.39：导出给 gen-skill-rules.ts 用（同 getGenreKnobs）
export type EffectiveGenre = AutoGenre | "humanHand";

export interface GenreKnobs {
  avgLenTarget: number;
  burstTarget: number;
  intensityCap: number; // 硬上限：> 这个值会被 clamp
  disableZhuque: boolean; // 强制关闭朱雀增强
  expoForceP3: (intensity: number) => boolean;
  skipSceneInject: boolean; // 剧本场景块跳过自问自答
  disableTyposAnchor: boolean; // 关闭错别字/第一人称锚点注入（humanHand专用）
  skipSelfQA: boolean; // v0.9.1：叙事文跳过自问自答/碎片注入（"例子呢？"不属于叙事）
}

// v0.9.39：导出给 scripts/gen-skill-rules.ts（skill 规则文档生成器）用——
// 四体裁旋钮是引擎的单一事实源，skill 文档从它生成而非手抄，防两边漂移。
export function getGenreKnobs(genre: EffectiveGenre): GenreKnobs {
  switch (genre) {
    case "main":
      return {
        avgLenTarget: 23,
        burstTarget: 0.63,
        intensityCap: 1.0,
        disableZhuque: false,
        expoForceP3: (i) => i >= 0.75,
        skipSceneInject: false,
        disableTyposAnchor: false,
        skipSelfQA: false, // v0.9.1：论说文保留自问自答（人味装置）
      };
    case "narrative":
      return {
        avgLenTarget: 28,
        burstTarget: 0.59,
        intensityCap: 1.0,
        disableZhuque: false,
        expoForceP3: () => false,
        skipSceneInject: false,
        disableTyposAnchor: false,
        skipSelfQA: true, // v0.9.1：叙事文不需要"例子呢？我随便举一个你就懂了"
      };
    case "dialogue":
      return {
        avgLenTarget: 32,
        burstTarget: 0.57,
        intensityCap: 1.0,
        disableZhuque: false,
        expoForceP3: () => false,
        skipSceneInject: true,
        disableTyposAnchor: false,
        skipSelfQA: true, // v0.9.1：对话体也不需要插话模板
      };
    case "humanHand":
    default:
      return {
        avgLenTarget: 36,
        burstTarget: 0.5,
        intensityCap: 0.48,
        disableZhuque: true,
        expoForceP3: () => false,
        skipSceneInject: false,
        disableTyposAnchor: true,
        skipSelfQA: true, // v0.9.1：人写原稿不注入插话
      };
  }
}

/* ----------------------------- 主流程 ----------------------------- */

/** 入口：按段落拆分逐段处理、保留原文分段 */
export function humanize(text: string, opts: HumanizeOptions = {}): string {
  const onStage = opts.onStage;
  if (!text || !text.trim()) {
    if (onStage)
      emitStage(
        onStage,
        {
          id: "guard",
          name: "入口守卫",
          why: "空文本没有可去味的内容，直接返回原样，避免下游 pass 在空串上造出垃圾。",
          charsBefore: text?.length ?? 0,
          skipped: true,
        },
        nowMs(),
        "",
      );
    return "";
  }
  // v0.9.4 P1 边界守卫：超短文本透传。实测「短。」（3 字符）经整条管线后被清成
  // 空串（替换/删除类 pass 在孤词上无东西可保，最终输出丢失原文）——数据丢失级
  // 边界 bug。10 字以内没有"去味"的空间与必要，原样返回最安全。
  if (text.replace(/\s+/g, "").length < 10) {
    if (onStage)
      emitStage(
        onStage,
        {
          id: "guard",
          name: "入口守卫 · 超短透传",
          why: "去掉空白不足 10 字：这么短的文本经整条管线后会被清成空串（实测「短。」3 字符触发），没有去味空间，原样返回最安全。",
          charsBefore: text.length,
          skipped: true,
        },
        nowMs(),
        text,
      );
    return text;
  }
  // v0.8.6：强度=0 必须严格返回原文。之前所有 pass 都按概率 0 跳过，
  // 但最后几道确定性兜底（stripAICliches / stripLeadingConnectivesHard /
  // clampAvgSentenceLenUnder25 / replaceGuardedFormulaicDerivs 等）不关心强度，
  // 会删掉"值得注意的是/然而/因此"这类连接词、切长句、替换"有效性→实际效果"，
  // 导致用户选 0 时原文仍被改写。在入口直接短路，语义最直观。
  const rawIntensity = opts.intensity ?? 0.6;
  if (rawIntensity <= 0) {
    if (onStage)
      emitStage(
        onStage,
        {
          id: "guard",
          name: "入口守卫 · 强度为 0",
          why: "强度=0 必须严格返回原文。下游有几道确定性兜底（stripAICliches 等）不关心强度，不在此短路的话用户选 0 仍会被改写。",
          charsBefore: text.length,
          skipped: true,
        },
        nowMs(),
        text,
      );
    return text;
  }
  // P7-A：体裁判定——显式 opts.genre 优先，否则自动识别（纯人写不自动判，必须用户显式传 humanHand）
  const tGenre = nowMs();
  const classified = opts.genre ? null : classifyGenre(text);
  let effectiveGenre: EffectiveGenre = opts.genre ?? classified!.genre;
  // v0.9.45 防御：自动识别把**非对话文本**判成 dialogue 时降级为 main。
  //
  // 证据（artifacts/human-corpus/_probe-classify2.ts，21 篇真人文本）：
  // 《疫苗》被判 dialogue，命中的是 Rule 1 的**单特征**路径 `dlgColonRatio >= 0.06`
  // （实测 0.082）—— 百科条目里的「症状：…」「病毒：…」这类**列举标签**触发的。
  // 而真正的对话特征**全部为 0**：
  //   dlgQuoteRatio 0.00062（无引语）、dlgShortTurn 0（无短对话轮）、
  //   dlgSceneBlockRatio 0（无场景块）。
  // ⇒ 单靠冒号比例就判 dialogue 的那部分，是百科列举的假信号。
  //
  // ⚠️ 为什么在 humanize() 降级而**不去改 classifyGenre**：
  //   classifyGenre 是独立模块、自带测试基线，改它的阈值会波及 exposition/narrative
  //   两条判据的基线；而且这里需要的判据是「**要不要注入碎片**」，
  //   属于使用侧策略而非识别侧定义。
  // ⚠️ 方向刻意保守：宁可少注入（对话体少了语气词），不可错注入（书面体被加语气词）。
  if (
    classified &&
    effectiveGenre === "dialogue" &&
    classified.features.dlgQuoteRatio < 0.002 &&
    classified.features.dlgShortTurn === 0 &&
    classified.features.dlgSceneBlockRatio === 0 &&
    classified.features.dlgColonRatio < 0.15
  ) {
    effectiveGenre = "main";
  }
  if (onStage) {
    const f = classified?.features;
    emitStage(
      onStage,
      {
        id: "genre",
        name: `体裁判定 → ${effectiveGenre}`,
        why: "体裁决定后面每一层的旋钮：注入什么、句长切多短、要不要动结构。判错体裁会在书面稿上塞口语，所以对自动识别的 dialogue 还有一道降级兜底。",
        charsBefore: text.length,
        metric: f
          ? `引语率 ${f.dlgQuoteRatio.toFixed(3)} · 短对话轮 ${f.dlgShortTurn} · 场景块 ${f.dlgSceneBlockRatio} · 冒号率 ${f.dlgColonRatio.toFixed(3)}`
          : "显式指定体裁，未跑自动识别",
      },
      tGenre,
      text,
    );
  }
  const knobs = getGenreKnobs(effectiveGenre);
  // v0.9.49：自问自答的体裁门控。C1 工作总结与 C6 学术摘要的自动体裁都是 main，
  // getGenreKnobs 的体裁旋钮分不开它们（实测 C1/C2/C4/C6/C9 全判 main），
  // 而 C2 观点文的自问自答是设计意图、C1/C6 的是语体崩 ⇒ 用文档签名补一层判据。
  // 判据取原始输入 text：签名词理论上可能被管线中途改写，且注入决策本就该看
  // "用户给的是什么稿"。实测分离见 classify-genre.ts 两个签名的注释。
  const officialDoc = suppressSelfQA(text);
  // P7-D：humanHand 强约束——强度硬钳制到 ≤0.48（该体裁斜率为负，越去味官分越高）
  const intensity = Math.min(Math.max(0, Math.min(1, opts.intensity ?? 0.6)), knobs.intensityCap);
  // P7-D：humanHand 强制关闭朱雀增强
  const zhuqueOn = (opts.zhuqueMode ?? false) && !knobs.disableZhuque;
  const paragraphs = text.split(/\n+/).filter((p) => p.trim());
  const tPara = nowMs();
  let result: string;
  if (paragraphs.length <= 1) {
    result = humanizeSingle(text, { ...opts, intensity, genre: effectiveGenre, officialDoc });
  } else {
    const baseSeed = opts.seed;
    result = paragraphs
      .map((p, i) =>
        humanizeSingle(p, {
          ...opts,
          intensity,
          genre: effectiveGenre,
          para: i,
          officialDoc,
          seed: baseSeed === undefined ? undefined : (baseSeed + i * 2654435761) >>> 0,
        }),
      )
      .join("\n\n");
  }
  if (onStage)
    emitStage(
      onStage,
      {
        id: "para",
        name: `段落级改写（${paragraphs.length} 段）`,
        why: "整篇按段落切开逐段跑：段与段之间不共享注入上下文，才不会把同一条垫词/自问自答模板连着塞两遍。多段时每段派生独立种子，保证结果可复现。",
        charsBefore: text.length,
        metric:
          paragraphs.length > 1
            ? `${paragraphs.length} 段各自派生种子（seed + i×2654435761）`
            : "单段文本，走直通分支",
      },
      tPara,
      result,
    );

  // 朱雀增强模式（全文本级）——P7-D humanHand 强制关闭；P7-E 对话体场景块跳过自问自答
  // v0.9.1：narrative/humanHand 跳过自问自答+碎片注入（"例子呢？"不属于叙事/人写原稿）
  // v0.9.4 P2：垫词饱和守卫——输入已被垫词塞满（多轮处理/高度口语）时不再注入
  const tZq = nowMs();
  let zqRan = false;
  if (zhuqueOn && intensity >= 0.35 && countPadHeads(text) < PAD_INJECT_CAP) {
    // v0.9.8 P0 收敛（七）：兜底风格 casual → plain（与 DEFAULT_API.style 对齐）。
    result = applyZhuqueFeatures(result, intensity, opts.seed, opts.style ?? "plain", {
      skipSceneInject: knobs.skipSceneInject,
      skipSelfQA: knobs.skipSelfQA || officialDoc,
    });
    zqRan = true;
  }
  if (onStage) {
    let metric = "注入插话 / 观点短语 / 括号自语 / 自问自答等反检测特征";
    let skipped = false;
    if (!zqRan) {
      skipped = true;
      metric = !zhuqueOn
        ? "未开启朱雀增强"
        : intensity < 0.35
          ? `强度 ${intensity.toFixed(2)} < 0.35，按设计不注入`
          : `原文垫词已饱和（≥ ${PAD_INJECT_CAP} 处），本轮不再注入`;
    }
    emitStage(
      onStage,
      {
        id: "zhuque",
        name: skipped ? "朱雀增强（跳过）" : "朱雀增强",
        why: "在改写稿上叠加检测器统计层面的反特征。它只加「人味特征」、不碰语义；跑不跑由开关、强度、垫词饱和三道门控共同决定。",
        charsBefore: text.length,
        metric,
        skipped,
      },
      tZq,
      result,
    );
  }

  // v0.8 结构级：本地引擎跑完后做二次扫荡（强度 >= 0.55），对段落骨架再动刀
  //
  // v0.9.8 P0 收敛（六·续三）：**叙事/人写体裁跳过整个结构层**。
  //
  // 证据链（逐步收紧，每步都有独立脚本）：
  //   ① _narr_multi.ts（0.9 档 seed 7）：段落重排把三段原创叙事压成两段，
  //      并在段间塞桥接词「懂吧。」（桥接池全是聊天腔）→ 只关 resegment 不够。
  //   ② _narr_seg.ts（0.9 档 seed 1）：**段 1 与段 3 被整段焊成单句**
  //      （65 字 1 句 / 68 字 1 句，所有句号变逗号），源头在段内的
  //      structuralShuffleParagraph → deParallelizeStructure / breakEnumerationStructure。
  //   ③ 这些函数的设计目标是拆解**论说文的三段式结构**（"首先/其次/最后"、排比、
  //      总-分-总），对叙事文没有对应结构可拆，动刀只会破坏作者原本的断句与节奏。
  //   ④ 叙事/人写的定位是"保留作者本人的结构与语气"，结构重排与之直接冲突。
  //
  // 代价评估：跳过结构层会少一个"骨架打散"手段，但叙事/人写本来就不靠这个——
  //   实测叙事全档位 aiScore 已是 0~17（低于判定线 29），去掉后不产生新缺口。
  const structuralAllowedGenre = effectiveGenre !== "narrative" && effectiveGenre !== "humanHand";
  const tStruct = nowMs();
  if (intensity >= 0.55 && structuralAllowedGenre) {
    const structRng = makeRng(opts.seed, 5555);
    // P7-B：论说文 + 强度≥0.75 → 强制开启 P3 结构增强（覆盖 expoScore 略低于 0.55 的边缘论说文）
    // P7-E：对话体 → 剧本【场景/人物/背景】块跳过自问自答注入
    const structOpts = {
      zhuqueMode: zhuqueOn,
      expoForceP3: knobs.expoForceP3(intensity),
      skipSceneInject: knobs.skipSceneInject,
      skipSelfQA: knobs.skipSelfQA || officialDoc, // v0.9.1：narrative/humanHand 跳过结构层自问自答；v0.9.49：公文/学术签名同样跳过
      // v0.9 专家修复 P5：文风透传到结构层（academic 禁口语承接头/自问自答）
      // v0.9.8 P0 收敛（七）：兜底风格对齐 DEFAULT_API（casual → plain）
      style: opts.style ?? "plain",
    };
    result = result
      .split(/\n\n+/)
      .map((p) => structuralShuffleParagraph(p, structRng, intensity, structOpts))
      .join("\n\n");
    // v0.9.8 P0 收敛（六·续）：段落重排只对论说/公文生效。
    //
    // 证据（scripts/_narr_multi.ts，NARR_MULTI + seed 7 + 0.9 档）：
    //   重排把用户的三段原创叙事压成两段，并在段间塞入桥接词「懂吧。」——
    //   「…停不了，懂吧。⏎ 我点点头…」。
    //   桥接池（humanize-shuffle.ts 489）为「是这个理。/嗯，对。/你别说。/哈哈。/懂吧。」，
    //   全部是聊天腔，落在叙事文上是语体错位；且原文分段是**作者的表达**，
    //   合并/拆分属于破坏性改写，不是"去 AI 味"。
    //   narrative 与 humanHand 的定位都是"保留作者本人的结构与语气"。
    //   —— 现已被外层 structuralAllowedGenre 统一拦截，此处不再重复判定
    //   （否则 TS 会报「两个类型无交集」的恒假比较）。
    result = resegmentParagraphsAggressive(result, structRng, intensity);
    // P7-D：humanHand 跳过错别字注入
    if (!knobs.disableTyposAnchor) {
      result = injectHumanTypos(result, structRng, intensity);
    }
  }
  if (onStage)
    emitStage(
      onStage,
      {
        id: "structure",
        name: intensity >= 0.55 && structuralAllowedGenre ? "结构层扫荡" : "结构层扫荡（跳过）",
        why: "对段落骨架再动刀：拆三段式、破排比、打散总-分-总。叙事/人写体裁整体跳过——原文的断句与分段是作者的表达，动它属于破坏性改写，不是去 AI 味。",
        charsBefore: text.length,
        metric:
          intensity >= 0.55 && structuralAllowedGenre
            ? "拆解论说文骨架 + 段落重排 + 错别字锚点"
            : intensity < 0.55
              ? `强度 ${intensity.toFixed(2)} < 0.55，不动结构`
              : `体裁 ${effectiveGenre} 按设计跳过结构层`,
        skipped: !(intensity >= 0.55 && structuralAllowedGenre),
      },
      tStruct,
      result,
    );

  // 全文级垫词去重
  const tDedupe = nowMs();
  result = dedupePadWords(result);
  if (onStage)
    emitStage(
      onStage,
      {
        id: "dedupe",
        name: "垫词去重",
        why: "多个注入器各撒各的，全文级再收一次口：垫词密集处去重，避免「说真的，…坦白讲，」连发。",
        charsBefore: text.length,
      },
      tDedupe,
      result,
    );

  // v0.9.51：参数表段落不参与节奏兜底切句。C18 招标参数表实测：条目句的参数
  // 并列（「配置不少于 2 颗 32 核处理器，内存容量不低于 512GB，硬盘容量不低于
  // 4TB NVMe SSD，支持 RAID 0/1/5/6」）被 boostBurstinessByCutting 在每个
  // 逗号处劈开，规格表述碎成散文——单点跑测（seed 20261015）与 12 seed 复扫
  // 均稳定复现。逐段判定（判据是段级形态：条目头 + 参数谓词），
  // 详见 anti-fingerprint.ts 的 isSpecTableParagraph 注释。
  const burstCut = (p: string, target: number, cuts: number): string =>
    isSpecTableParagraph(p) ? p : boostBurstinessByCutting(p, target, cuts);

  // 全文级句长节奏兜底
  const tRhythm = nowMs();
  if (intensity > 0.4) {
    const rng3 = makeRng(opts.seed, 4444);
    // v0.9.8 P0 修复：废除 boostBurstiness 的「短碎片句」注入（boostBurstinessFragments）。
    //
    // 原因（第七阶段剥夺实验，scripts/_c_diag.ts）：
    //   人写样本 0 → 82、叙事 0 → 70，元凶是每段被塞「就这样。/你懂的。/说白了。」
    //   实测剥掉这些碎片句，人写 82 → 31、叙事 70 → 29（回收 41~51 分）。
    //   断崖证据：intensity 0.40 全净 / 0.41 全爆——与 boostBurstinessFragments 的
    //   `stats.cv >= MIN_BURSTINESS_CV` 触发条件精确对齐。
    //
    // 同 boostBurstinessIfLow 的根因：为已被标尺废除的 CV 指标服务。
    //   标尺 v0.9.6 删除了 burstiness 反向项（CV 判别力接近零），
    //   但短碎片句注入仍在为 MIN_BURSTINESS_CV=0.45 卖命，且注入的 7 条碎片
    //   （就这样/你懂的/说白了/差不多得了/嗯/哦对/行吧）**全部命中 3e 污染表**。
    //
    // 替代：统一走 boostBurstinessByCutting（纯切长句、零注入）。
    //   它靠长短句交错补方差，不引任何新痕迹；PAD_INJECT_CAP 分支本来就走这条，
    //   现在只是把「补方差」的两条路径合并成一条，语义更一致。
    //
    // P7-F 段落感知（必须）：boostBurstinessByCutting 内部 splitSentences 会剥掉
    //   段尾 \n\n，整篇直调会把多段焊成单段（humanize.test.ts「多段文本保留段落换行」
    //   实测 16 个用例回归）。必须逐段分发——这是原 PAD_INJECT_CAP 分支早已埋下的隐患，
    //   只因该分支罕有命中而未暴露，现在成为主路径必须修掉。
    void rng3; // 保留句柄：切句路径未来若需抖动可用
    result = result.includes("\n\n")
      ? result
          .split(/\n\n+/)
          .map((p) => burstCut(p, 0.55, 8))
          .join("\n\n")
      : burstCut(result, 0.55, 8);
  }
  if (onStage)
    emitStage(
      onStage,
      {
        id: "rhythm",
        name: intensity > 0.4 ? "句长节奏兜底" : "句长节奏兜底（跳过）",
        why: "AI 文本最稳的 statistical 痕迹之一是句长过于均匀。这里只切长句、零注入——靠长短句交错补方差，不引任何新的人造痕迹。",
        charsBefore: text.length,
        metric:
          intensity > 0.4
            ? `逐段切长句（目标 CV 0.55）· 原句数 ${splitSentences(result).length}`
            : `强度 ${intensity.toFixed(2)} ≤ 0.4，不动节奏`,
        skipped: !(intensity > 0.4),
      },
      tRhythm,
      result,
    );

  // v3 P4+P5 最终清尾（必须放在所有结构/自问自答生成之后）——
  // P4-C：VOCAB GUARD 保护的"针对→性/系统→性/有效→性"等合法套话衍生，保语义整体替换为口语
  const tDerivs = nowMs();
  result = replaceGuardedFormulaicDerivs(result);
  if (onStage)
    emitStage(
      onStage,
      {
        id: "derivs",
        name: "套话衍生词替换",
        why: "「有效性/系统性/针对性」这类派生词被上游保护逻辑放过了（整词合法），但它们在书面稿里同样成套话。这里保语义整体替换成口语。",
        charsBefore: text.length,
      },
      tDerivs,
      result,
    );
  // v0.9 反「新指纹」层：引擎注入特征不得变成新指纹
  //  A) 长模板跨段复读封顶（自问自答/插话模板全文每种限 1 次，仅在注入强度 ≥0.65 时启用）
  if (intensity >= 0.65) {
    result = capLongTemplateRepetition(result);
  }
  //  B) 语体门控：论说/学术（formal）下还原过度口语替换；双连接词叠放不限语体
  const formalRegister = effectiveGenre === "main" || (opts.style ?? "plain") === "academic";
  result = guardFormalRegister(result, formalRegister);
  //  B') v0.9.46：与体裁无关的坏替身修复（「借在…上」「拔高表现」）。
  //      必须放在 guardFormalRegister 之后：那张表会先把「拔高」整词还原成「提升」，
  //      顺序颠倒会让这里的搭配判定失去对象。
  result = fixBrokenCollocations(result);
  result = collapseDoubleConnectives(result);
  if (onStage)
    emitStage(
      onStage,
      {
        id: "antifp",
        name: "反「新指纹」层",
        why: "引擎自己注入的特征不能变成新指纹。这一层做四件事：长模板跨段复读封顶、正式语体还原过度口语的替换、修复坏搭配（「借在…上」）、折叠叠放的连接词与语气词。",
        charsBefore: text.length,
        metric: `语体门控 ${formalRegister ? "开（正式语体，还原口语替身）" : "关（非书面体裁）"} · 模板封顶 ${intensity >= 0.65 ? "启用" : `未启用（强度 ${intensity.toFixed(2)} < 0.65）`}`,
      },
      tDerivs,
      result,
    );
  //  C) v0.9.5 P4 双语气词折叠：多个注入 pass 叠加时句尾出现"呀呀""嘛嗯""呢呵"
  //  式堆叠（Phase1 迭代实测），真人不会连发两个语气词。相邻重复折叠为一个，
  //  相邻异形双语气词保留第一个；"好吧/行吧/哦对"等合法组合不受影响
  //  （第二个字符非语气词时不匹配）。
  result = result
    .replace(/([哦呵啧呣诶呀嘛呢吧啊嗯])\1+/g, "$1")
    .replace(/([哦呵啧呣诶呀嘛呢吧啊嗯])[哦呵啧呣诶呀嘛呢吧啊嗯]+(?=[。，！？；、\n]|$)/g, "$1");
  //  C) 残句开头守卫：句首独词连接词（并/而/且/但/亦/另）修复
  if (intensity >= 0.55) {
    result = fixOrphanConnectiveLeads(result);
  }
  // P7-C + P5-A：按体裁压 avgLen（论说23 / 叙事28 / 对话32 / 人写36 不触发硬切）
  // v0.9 专家修复 P2 连带：切点守卫收紧后长句切分机会变少，maxCuts 5→8 补偿——
  // 只放宽「尝试次数」，每刀仍逐点过守卫，不会切出残句
  // v0.9.51：参数表跳过钳制——C18 招标参数表实测条目句「配置不少于 2 颗 32 核
  // 处理器，内存容量不低于 512GB……」被「最长句中央逗号处切段」打散成五句，
  // 且这是**最后一道**切句路径（前面 rhythm/burst/结构层都跳过之后仍复现）。
  // avgLen 对参数表是错指标：条目句长是规格表述的天然长度，压它等于压内容。
  // 整篇级判定（不逐段）——宁可整体跳过钳制，不可把参数表段落和普通段落
  // 混在同一决策里（混合稿件极少，保守方向是少切）。
  const tClamp0 = nowMs();
  if (!isSpecTableParagraph(result)) {
    result = clampAvgSentenceLenUnder25(result, knobs.avgLenTarget, 8);
  }
  // P7-C + P4-B（P5 增强版）：按体裁拉 burstiness CV（论说0.63 / 叙事0.59 / 对话0.57 / 人写0.50）
  //       （原全局固定 0.61 → 现按体裁分档，论说最严、人写最松，避免负斜率体裁被过度注入锚点）
  // P4-A：最终保险整篇破折号/省略号硬上限，解决指纹自检"破折号超标×2/×3"红项
  result = ensureEmDashCountHardCap(result, 1);
  result = limitPunctuation(result, "……", 1, "。");
  result = limitPunctuation(result, "——", 1, "，");
  if (onStage)
    emitStage(
      onStage,
      {
        id: "clamp",
        name: "句长钳制 + 标点硬上限",
        why: "按体裁目标压平均句长（论说 23 / 叙事 28 / 对话 32 / 人写 36），并给破折号、省略号设整篇硬上限——这两样一旦超标就是一眼可见的机器痕迹。",
        charsBefore: text.length,
        metric: `avgLen 目标 ${knobs.avgLenTarget} 字 · 破折号/省略号各限 1 处`,
      },
      tClamp0,
      result,
    );
  // v0.8.8：独立极短语气句密度收口（每段 ≤1）——v0.9 专家修复 P3：门槛 0.75→0.5。
  // 实测 0.5/0.6 档输出同样出现段尾「嗯。啧。」成串（多注入器叠加不分档位），
  // 收口只删超额语气句、不动正常短句，低强度下也安全。
  if (intensity >= 0.5) {
    result = capParticleSentenceDensity(result);
  }
  // v0.9-CV：capParticle 丢弃超额极短语气句会拉低 CV（对话 0.9 实测指纹"句长节奏过平"），
  // boost 兜底必须放最后，删完极短句后再按体裁目标拉 CV
  if (intensity >= 0.4) {
    // v0.9.8 P0 修复：废除 boostBurstinessIfLow 的「极短语气锚」机制。
    //
    // 原因（第七阶段剥夺实验，scripts/_converge_probe.ts）：
    //   剥夺实验逐项抹除输出里的注入痕迹，测量 aiScore 回收量：
    //     − 句尾语气词 → 回收 33~84 分（均值 63）
    //     − 垫词       → 回收 0~10 分（均值 4）
    //   语气词是第一损伤源，单剥即可把叙事 plain 从 84 打到 0。
    //
    // 根因是「追错指标」而非「撒得太多」：
    //   标尺 v0.9.6 已删除 burstiness 反向项（实测 CV 判别力接近零且方向反：
    //   人写口语随笔 CV=0.27 为全场最低，AI 排比 CV=0.34），CV 只剩 ≤8 分弱信号；
    //   但 boostBurstinessIfLow 仍在为 MIN_BURSTINESS_CV=0.45 拼命撒语气词，
    //   而这个动作恰好被新标尺 3a（句尾语气词，12 分/处）与 3e（污染率）判为污染。
    //   —— 引擎在为一个已被废除的指标卖命，且代价是新标尺要抓的污染。
    //
    // 替代方案：CV 兜底全部交给 boostBurstinessByCutting（纯切长句、零注入）。
    //   它只切句不引新痕迹，且原代码在 cap2 之后本来就走这条路（下方 649 行），
    //   现在只是把「先灌锚再删锚」的冗余往来彻底去掉，两个目标不再互相拉锯。
    const p4Rng = makeRng(opts.seed, 9401);
    void p4Rng; // 保留 rng 句柄：boost 系列接口签名统一，且切句路径未来可能需要
    result = result.includes("\n\n")
      ? result
          .split(/\n\n+/)
          .map((p) => burstCut(p, knobs.burstTarget, 8))
          .join("\n\n")
      : burstCut(result, knobs.burstTarget, 8);
  }
  // v0.9 专家修复 P3（补刀）：capParticle 必须在最终 boost 之后再次收口——
  // boost 的 P5-B 尾挂会回填新的极短语气句，先 cap 后 boost 会漏掉这批。
  // v0.9.2 修复：cap2 删除超额语气锚后 CV 会跌回原点（实测锚灌注 0.66 → 删锚 0.24），
  // 死结在于「boost 灌锚拉 CV ↔ cap 删锚防指纹」互相拉锯。解法：cap2 之后改用
  // 「纯切句」兜底（boostBurstinessByCutting：只切长句、零注入），锚该删删、
  // 方差由长短句交错补足，两个目标不再冲突。
  if (intensity >= 0.5) {
    result = capParticleSentenceDensity(result, 1, false);
    // v0.9.2：兜底触发线用「指纹红线 + 余量」而非体裁目标——cv 0.44~0.46 的
    // 边缘卡线（差 0.01）在探针阈值下仍红，但把切句目标拉到体裁目标会过度切分。
    // 触发条件 0.45+余量，切句目标 0.5：稳过红线、不追满体裁档。
    // P7-F 段落感知：必须按段分发——boostBurstinessByCutting 内部 splitSentences
    // 会剥掉段尾 \n\n，整篇直调会把多段焊成单段（v4.3 段落保留探针实测 37 次违规）。
    const FP_LINE = 0.48; // 指纹体检红线 0.45 + 余量
    // v0.9.21 性能：此处原为 `aiScore(result).burstiness`——只为读一个字段却跑完整个
    // aiScore（含 4 组词表全表扫描）。改用 burstinessOf（同口径、结果逐位相同，实测快约 10×）。
    if (burstinessOf(result) < FP_LINE) {
      result = result.includes("\n\n")
        ? result
            .split(/\n\n+/)
            .map((p) => burstCut(p, 0.55, 8))
            .join("\n\n")
        : burstCut(result, 0.55, 8);
    }
  }
  if (onStage)
    emitStage(
      onStage,
      {
        id: "burst",
        name: "节奏收口 + 语气句密度",
        why: "先删超额极短语气句（防止段尾「嗯。啧。」成串），再用纯切句把 CV 拉回指纹红线之上。删完再补、补完再删，两个目标靠「只切句、零注入」才不再互相拉锯。",
        charsBefore: text.length,
        metric: `当前 CV ${burstinessOf(result).toFixed(3)}（指纹红线 0.45）· 目标 ${knobs.burstTarget}`,
      },
      tClamp0,
      result,
    );
  // 行首残留标点清理（结构重排/模板删除可留下「，一句话概括」式残逗号）
  const tFinal = nowMs();
  result = result
    .replace(/(^|\n)\s*[，、；：]+/g, "$1")
    .replace(/([。！？])\s*([，、；：]+)/g, "$1");

  // v0.9.22 裸骨架独句修复：提纲骨架词被替换后**独立成句**是机器痕迹。
  //
  // 实测（政务论说样本，0.4/0.6/0.9 三档全部命中）：
  //   「其次，在产业落地层面，…」 → 「再说。在产业…方面，…」
  //   「再次，从治理与合规的角度…」 → 「再次。从治理与合规看，…」
  // 骨架词（首先/其次/综上所述）的语义是**引导后文**，它后面必须跟着内容；
  // 独立成句等于把一个连接词当成一个完整句子，人不会这么写。
  // 溯源：OPENERS 把「其次」换成「再说」后，切句层按句号把它切出去了。
  //
  // 修法：这类独句把句号还原成逗号，让它回到"引导后文"的位置。
  // 只动句号/叹号/问号，不动已经是逗号的（那种本来就对）。
  result = result.replace(
    /(^|\n)(首先|其次|再次|再说|另外|此外|总的来看|总而言之|总的说来|最后|其一|其二)[。！？]/g,
    (_m: string, lead: string, word: string) => lead + word + "，",
  );
  if (onStage)
    emitStage(
      onStage,
      {
        id: "final",
        name: "清尾",
        why: "清掉前面所有 pass 留下的行首残标点，并把「其次。」这类被切出去的骨架独句还原成逗号——骨架词的作用是引导后文，独立成句是机器痕迹。",
        charsBefore: text.length,
        metric: `输出 ${result.length} 字 · ${splitSentences(result).length} 句`,
      },
      tFinal,
      result,
    );

  return result;
}

/** 朱雀增强：仅叠加反检测特征，不跑本地引擎 */
export function applyZhuqueFeatures(
  text: string,
  intensity: number,
  seed?: number,
  style: RewriteStyle = "casual",
  // P7-E：对话体剧本场景块跳过自问自答注入
  // v0.9.1：narrative/humanHand 跳过全部自问自答+碎片注入
  opts: { skipSceneInject?: boolean; skipSelfQA?: boolean } = {},
): string {
  if (!text || intensity < 0.35) return text;
  const zrng = makeRng(seed, 7777);
  let result = text;

  // v0.9.8 P0 收敛（六）：0.35 硬门槛 → 强度斜坡。
  //
  // 缺陷（scripts/archive/_stability.ts 全档位扫描）：
  //   0.35 档近乎干净（叙事均值 2.4），0.40 档突然爆分（叙事均值 23.4，最差 seed 46）——
  //   跨过 0.35 后多个注入器同时以完整概率启动，中间没有过渡。
  //
  // 详见文件上方 rampFactor / effectiveIntensity 的注释（含 _punct_probe.ts 定位的真凶）。
  const eff = effectiveIntensity(intensity); // 有效注入强度：0.35 档 ≈ 0，0.60 档起 = intensity

  const isCasual = style === "casual";
  const skipSelfQA = opts.skipSelfQA ?? false;
  // v0.9.8 P0 收敛（三）：删除 injectDialect 注入。
  //
  // 证据一（净负收益，左右手互搏）：
  //   injectDialect 撒下「唠/瞅/贼/整/寻思」后，anti-fingerprint.ts 172~190 行
  //   又把它们还原成书面词（唠→谈、瞅→看、贼→非常）。实测 0.9 档：
  //     注入 10 处 → 还原 8 处 → 净留 2 处
  //   且漏网的恰好是还原表**未覆盖**的 寻思/寻/整 —— 也就是说：
  //   白付一遍注入成本，最后只留下「两侧词表都对不齐的残渣」。
  //
  // 证据二（残渣是双重扣分项）：
  //   这些残渣既命中 BROKEN_SUBSTITUTES（病词，12 分/处），
  //   又命中 3e 垫词表（句式污染）。一个装置喂两个扣分项。
  //
  // 证据三（归因实测）：injectDialect 概率最高（0.20×intensity），
  //   且 4/4 体裁全部命中（叙事/论说/观点 × casual/plain），是第一位注入污染源。
  //
  // 结论：净负收益设计，**删除优于调低概率**——只要还注入，就会留残渣。
  //
  // 原调用（保留注释备查）：
  //   if (isCasual) result = injectDialect(result, zrng, 0.2 * intensity);

  // v0.9.8 P0 收敛（四）：injectParentheticals / injectOpinion 收紧为 casual 专属。
  //
  // 收敛前条件是 `style !== "academic"` → plain 风格也在跑。
  // 实测（scripts/_layer_attrib2.ts）：plain 已关闭方言/碎片/括号自语/自问自答，
  // 污染率却仍有 0.60、句式分 60 —— 残存污染词「我寻思着/说真的/坦白讲」
  // 全部来自这两个注入器。plain 的定位就是「少口语」，塞插话/观点短语是定位冲突。
  //
  // v0.9.8 P0 收敛（六）：概率改用 eff（斜坡有效强度）而非 intensity。
  //   理由见上方 RAMP 段：0.35 档位以前是"完整概率注入"，与 0.40 档无区别，
  //   造成"旋钮"变"开关"。改用 eff 后 0.35 档 ≈ 零注入，0.60 档起恢复原行为。
  //
  // v0.9.8 P0 收敛（六·续）：叙事/人写体裁**整体**禁用插话/观点注入（含句内分支）。
  //
  // 补丁起因（scripts/archive/_n60.ts / _narr_ab.ts，叙事 seed=2 恒定 31 分）：
  //   句首垫词的三重门控只挡了句首入口，injectParentheticals 的**句内**分支漏网——
  //   seed=1 插出「坦白讲，…，在我看来，」、seed=2 恒定在开头插出「我个人的看法，」
  //   句尾插出「往好听了说，」，句式分 28，且**不随强度变化**（确定性路径，非概率抖动）。
  //   实测 avg 只有 2.6~4.1，但 max 卡在 31 —— 一个坏 seed 就毁掉整档体验。
  //   叙事体裁的定位是「把事讲清楚」，句内塞口语插话与句首塞「说真的，」同类错位，
  //   门控必须覆盖整条注入路径，不能只挡句首那一个入口。
  //
  // ⚠️ 注意：**不要**用 skipSelfQA 关掉注入器本体 + injectOpinion 的**组合**。
  //   实测叙事体裁同时关掉这两个注入器后，aiScore 反而从 12 涨到 32 ——
  //   文本变短触发了 boost 切句路径，按下葫芦浮起瓢。叙事的问题不在插话注入器。
  //
  // 风险与验证：历史上曾有"关掉注入器 → 文本变短 → boost 切句反扑"的陷阱。
  //   本次改动前先记录了基线 avg/max，改动后必须复跑脚本确认 avg 未上升、
  //   max 显著下降。**若 avg 上升则回滚本门控**（data > 直觉）。
  // 四个注入器合并到同一门控（原本写成两个条件完全相同的 if，无实际区分）
  if (isCasual && !skipSelfQA) {
    result = injectParentheticals(result, zrng, 0.15 * eff);
    result = injectOpinion(result, zrng, 0.12 * eff);
    result = injectParentheticNotes(result, zrng, 0.08 * eff);
    // 注：injectFragments 无 style 参数（签名仅 text/rng/p），其碎片词池是
    // 体裁无关的固定池，风格差异由外层 isCasual 门控负责。这里不存在漏传问题。
    result = injectFragments(result, zrng, 0.06 * eff);
  }
  result = dedupePadWords(result);
  result = limitPunctuation(result, "——", 1, "，");
  // v0.8：自问自答（增强句式跳脱，AI 极少写自问自答，人类日常到处是）
  // P7-E：对话体剧本【场景/人物/背景】块跳过注入，避免台词区被塞"问：…答：…"违和
  // v0.9.1：narrative/humanHand 跳过全部自问自答（"例子呢？"不属于叙事/人写原稿）
  // v0.9.8 P0 收敛（七）：外层条件 isCasual → style !== "academic"。
  //
  // 原文注释写着「plain 走克制型池」，但外层判的是 `isCasual`，
  // plain 根本进不来 —— 注释与代码脱节。injectSelfQA 的 POOLS 里
  // plain 那 6 条克制模板（「为什么呢？原因其实不复杂。」…）从未被使用。
  //
  // 修正后：
  //   casual → 表演型池（10 条，含「不信？那你自己试试」这类）
  //   plain  → 克制型池（6 条，无表演性碎句）
  //   academic → POOLS.academic = []，函数内直接 return，天然禁用
  //
  // 注意：casual 池里的「不信？「有人要抬杠了——」是标尺 3e 的命中词，
  //   但 casual 已不再是默认档，保留其历史行为不作二次改动。
  if (style !== "academic" && intensity >= 0.7 && !skipSelfQA) {
    const qrng = makeRng(seed, 8888);
    // P7-E：体裁级开关（对话体）→ 全文跳过；未开开关时逐段保护——
    // 含剧本【场景/人物/背景】行的段落原样保留，其余段落照常注入
    const skipFlag = opts.skipSceneInject ?? false;
    // v0.9 专家修复 P5：academic 文风禁自问自答（已由外层条件拦截）。
    // plain 走克制型池，casual 走表演型池 —— 词池由 injectSelfQA 按 style 自选。
    //
    // 2026-10-01 修：这里此前逐段各调一次 injectSelfQA，**段与段之间没有记忆**，
    // plain 池只有 6 条 → 两段撞同一条是 1/6 概率的必然偶发（实测 1/5 种子复现
    // 「是不是只有这一种解释？未必，但这一种最直接。」连出两遍）。
    // 现在整个 split 共享一个 usedQA 集合，逐段去重。
    const usedQA = new Set<string>();
    const beforeQA = result;
    result = result
      .split(/\n\n+/)
      .map((p) => {
        if (skipFlag || p.split(/\n/).some((ln) => SCENE_BLOCK_LINE_RE.test(ln))) return p;
        const sents = splitSentences(p);
        if (sents.length < 5) return p;
        return injectSelfQA(sents, qrng, intensity, style, usedQA).join("");
      })
      .join("\n\n");
    // v0.9.28 P0：效果回滚——加噪必须换来 detectAI 下降，否则把这一轮整个撤掉。
    // 详见 detector.ts 的 keepOnlyIfDetectDrops 注释（含实测与"判据是本地检测器"的边界）。
    result = keepOnlyIfDetectDrops(beforeQA, result);
  }
  return result;
}

function humanizeSingle(text: string, opts: HumanizeOptions = {}): string {
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 0.6));
  // v0.9.8 P0 收敛（六·续）：句子级节奏开关（合并 / 句尾软化）走斜坡有效强度。
  // 注意**只**给节奏类开关用，词汇替换（relaxIntensifierVerb 等）继续吃 intensity——
  // 那些是核心去味功能，被斜坡压掉会让低档位彻底失效。
  // 详见文件上方 effectiveIntensity 的注释（含 _punct_probe.ts 的断崖定位）。
  const eff = effectiveIntensity(intensity);
  const rng = makeRng(opts.seed);
  const style = opts.style ?? "plain";
  const isAcademic = style === "academic";
  const isCasual = style === "casual";
  // v0.9.51：参数表/技术规格表段落判定（一次算好，劈句/合并/节奏兜底共用）。
  // C18 招标参数表实测：条目句被劈成五句、条款被搬位移、参数后挂「为什么呢？」
  // ——三条路分别在逐句劈句（下方）、结构层与节奏兜底，同判据一起堵。
  // 判据与注释见 anti-fingerprint.ts 的 isSpecTableParagraph。
  const specTablePara = isSpecTableParagraph(text);

  if (!text || !text.trim()) return "";

  // trace：段落级步骤发射器。
  // 把上一步的输出长度当成本步的输入长度串起来，逐段逐步骤产出真实快照。
  // ⚠️ 未传 onStage 时 `t0` 连算都不算（三元短路），只多一层函数调用，输出逐字不变。
  const on = opts.onStage;
  const para = opts.para;
  let prev = text;
  // fn 刻意做成**无参**thunk：调用处直接读外层 working，
  // 这样每一步的赋值都是"下一步真会读"的活值（而不是被 eslint 判成死存储的中间量）。
  const step = (
    id: string,
    name: string,
    why: string,
    fn: () => string,
    metric?: string,
  ): string => {
    const b = prev;
    const t0 = on ? nowMs() : 0;
    const after = fn();
    prev = after;
    if (!on) return after;
    emitStage(
      on,
      {
        id,
        name,
        why,
        charsBefore: b.length,
        ...(metric === undefined ? {} : { metric }),
        ...(para === undefined ? {} : { para }),
      },
      t0,
      after,
    );
    return after;
  };

  // P8 场景块全格式保真：整段为剧本【场景/人物/背景…】块头行 → 原样返回。
  // 块头是元数据不是行文：relaxColon 会改成【场景，…】、replaceVocab/templates 也会污染。
  if (isSceneBlockLine(text)) {
    if (on)
      emitStage(
        on,
        {
          id: "scene-block",
          name: "场景块全格式保真",
          why: "整段是剧本【场景/人物/背景】块头行。块头是元数据不是行文，任何替换都会破坏剧本格式，原样返回。",
          charsBefore: text.length,
          ...(para === undefined ? {} : { para }),
        },
        nowMs(),
        text,
      );
    return text;
  }

  // 1) 全局词汇替换 + 套话
  let working = step(
    "conn",
    "删句首连接词",
    "「然而 / 因此 / 与此同时」这类句首连接词是 AI 论说文最稳定的痕迹——真人起句多半直入正题，不垫过渡。",
    () => dropLeadingConnectives(text, rng, intensity),
  );
  working = step(
    "redundant",
    "去冗余动词",
    "「进行 / 予以 / 加以 + 动词」是公文式冗余，去掉后动词直接落地，句子立刻短一截。",
    () => relaxRedundantVerb(working, rng, 0.85 * intensity),
  );
  working = step(
    "intensifier",
    "拆强化副词",
    "「大幅提升 / 不断优化」这类「副词+动词」固定搭配过于规整，按概率拆掉副词，节奏才会参差不齐。",
    () => relaxIntensifierVerb(working, rng, 0.85 * intensity),
  );
  working = step(
    "le",
    "补完成态「了」",
    "AI 文本极少使用完成态。按概率补「了」，让叙述有时态落点。",
    // v0.9.50：正式语体下不补。
    () => relaxLe(working, rng, 0.6 * intensity), // 补"了"概率从 0.4 提到 0.6，人味更强
  );
  // 必须排在 replaceVocab 之前：否则"受到广泛关注"的"关注"先被换成"留意"，
  // 这里再也匹配不到，实测会留下"受到广泛留意"这种搭配病句。
  working = step(
    "passive",
    "被动改主动",
    "「受到广泛关注」这类被动句是书面腔的显著特征，改回主动。必须排在词汇替换之前——顺序颠倒会留下「受到广泛留意」这类搭配病句。",
    () => softenPassive(working, rng, Math.min(1, 0.85 * intensity)),
  );
  working = step(
    "template",
    "模板套话改写",
    "整句级模板替换：「值得注意的是…」「综上所述…」这类开场套式按表改写，比逐词替换更贴近真人起笔方式。",
    () => replaceTemplates(working, rng, intensity),
  );
  // v0.9.46：正式语体 = main / academic（与 guardFormalRegister 完全同口径）。
  // 传给 replaceVocab 后，口语替身就地否掉，不再走"先改成病句、再靠下游还原"的老路。
  const formalRegister = opts.genre === "main" || style === "academic";
  // 词汇替换要给出真实命中数：本步单独手写 emit（step 的 metric 是静态串，这里需要前后计数差）
  {
    const b = working;
    const t0 = on ? nowMs() : 0;
    const before = on ? countVocabTokens(b) : 0;
    working = replaceVocab(b, rng, intensity, style, formalRegister);
    prev = working;
    if (on) {
      const hits = Math.max(0, before - countVocabTokens(working));
      emitStage(
        on,
        {
          id: "vocab",
          name: "词汇替换",
          why: "词表级替换。正式语体（main / academic）下口语替身会被就地否掉——不从「先改成病句再靠下游还原」的老路走，而是源头就否掉。",
          charsBefore: b.length,
          metric: `词表词减少 ${hits} 处${formalRegister ? " · 正式语体门控已开" : ""}`,
          ...(para === undefined ? {} : { para }),
        },
        t0,
        working,
      );
    }
  }
  working = step(
    "dev",
    "「随着…的发展」改写",
    "「随着人工智能技术的发展」这类开场套式单独处理——它是整段级结构，逐词替换拆不动。",
    () => replaceWithDevelopment(working, rng, intensity),
  );
  working = step(
    "concessive",
    "让步结构重构",
    "「虽然…但是」的让步结构换写法，避免通篇一种句式。",
    () => reframeConcessives(working, rng, Math.min(1, 0.5 + 0.5 * intensity)),
  );
  working = step(
    "punct",
    "标点松弛",
    "破折号、顿号、冒号、引号按概率换成更口语的形态。AI 的标点过于规整本身就是可检测特征。",
    () => {
      let r = relaxEmDash(working, rng, 0.6 * intensity);
      r = relaxDunhao(r, rng, 0.5 * intensity);
      // v0.9.51：参数表段不松冒号——「三、软件平台：支持不少于……」的条目冒号
      // 被 relaxColon 换成逗号后，字段分隔符消失（C18 实测）。其余三项对
      // 参数表无害（顿号已有编号守卫，破折号/引号参数表基本不出现）。
      // ⚠️ 跳过会少消耗一次 rng——只影响参数表段的随机序列，其余篇目逐字不变
      //    （多种子验收基线不受影响，因为参数表语料是本轮新增的）。
      if (!specTablePara) r = relaxColon(r, rng, 0.4 * intensity);
      return relaxQuotes(r, rng, 0.3 * intensity);
    },
  );
  working = step(
    "splitconn",
    "连接词处切句",
    "长句里的连接词处按概率断开成两句，制造长短交错——这是句长方差的主要来源之一。",
    () => splitOnConnectors(working, rng, 0.3 * intensity),
  );

  // 2) 切句，逐句处理
  const tSent = on ? nowMs() : 0;
  const sentences = splitSentences(working);
  const out: string[] = [];
  const usedInterjections = new Set<string>();
  let lastWasInterjection = false;
  // v0.9.8 P0 收敛：humanHand / narrative 体裁禁句首垫词（语体错位）。
  // narrative 的文风是「把事讲清楚」，humanHand 的原稿本来就是人写的——
  // 两者塞「说真的，」都是机器味而非人味。显式 genre 与自动识别都覆盖。
  const padForbiddenGenre = opts.genre === "humanHand" || opts.genre === "narrative";

  for (let i = 0; i < sentences.length; i++) {
    let s = sentences[i];

    // v0.9-D 场景块行保护：剧本【场景/人物/背景…】块头行原样保留，
    // 跳过语气词/句尾软化/拆句/合并等全部注入（此前"啧。嗯。呣。"会污染块头）
    //
    // v0.9.8 P0 扩展：台词行（「张总（项目经理）：…」）同样原样保留。
    // 块头保护只认【…】行，台词行漏网时 injectOpinion / Interjections 会把垫词
    // 插到说话人**前面**（「讲真，张总（项目经理）：…」）——说话人标签前不得有修饰，
    // 这会直接破坏剧本格式。humanizeSingle 是逐段调用，段落内的行在此逐句处理，
    // 故用 isScriptFormatLine 同时覆盖块头与台词。
    if (isSceneMetaSentence(s) || isScriptFormatLine(s)) {
      out.push(s);
      continue;
    }

    // v0.9.51：正式稿件的句首结构标记不做口语化。「首先/其次/最后/第一/第二」
    // 在致辞、判项、条款、论文里是**结构标记**（C20 大会致辞实测
    // 「首先，我谨代表主办方……」→「先说一个，我谨代表……」，同篇
    // 「最后，预祝……」→「最后说一句，预祝……」——都是语体崩）。
    //
    // ⚠️ 这是 replaceVocab 之外的**平行路径**（OPENERS 表），
    //    FORMAL_FORBIDDEN_SUBSTITUTES 盖不到这里，必须单独门控——
    //    v0.9.51 首轮把六个替身加进黑名单后 C20 照旧泄漏，根因就在这。
    //
    // ⚠️ 门控判据是**文档签名**（suppressSelfQA：公文/学术/致辞/诉讼/参数表），
    //    不是体裁。首版写成 `if (!formalRegister)`（genre==="main" 一律冻），
    //    全量门禁当场抓出附带损害：无签名的普通论说样本（injection-overlap.test.ts
    //    固定 seed 20260905）detectAI 基线 26→40——「首先/其次/最后」被冻在稿里，
    //    而论说稿的去味收益恰恰包括换掉它们。而五个正式语料案例（C1 工作总结/
    //    C6 学术摘要/C17 判决书/C18 参数表/C20 致辞）全部命中签名，缺陷覆盖不减。
    //    ⇒ 「判形态，不判体裁」：签了名的正式稿件冻，观点文/营销文的口语替身
    //    仍是设计意图（casual 营销文「先说一个」有效）。
    //    另：academic 文风是用户显式声明的正式体，与签名并列冻结。
    const openerFrozen = (opts.officialDoc ?? suppressSelfQA(text)) || style === "academic";
    if (!openerFrozen) s = replaceOpener(s, rng, intensity);

    // v0.9.8 P0 收敛：句首垫词注入的三重门控。
    //
    // 收敛前：条件只有 `!isAcademic` → plain 风格、humanHand 体裁全都在跑。
    // 实测（scripts/_c_diag.ts）这是残存的唯一共因污染源——4/4 样本首句都被插
    // 「说真的，」「讲真，」「坦白讲，」「我寻思着，」；剥夺该项可回收
    // 论说 55→39、叙事 36→20 分。
    //
    // 三重门控（缺一不可）：
    //   a) 风格必须是 casual —— plain 的定位就是「少口语」，academic 早已排除；
    //   b) 体裁不得是 humanHand/narrative —— 人写原稿与叙事文塞「说真的」是语体错位
    //      （humanHand 的 intensityCap=0.48 也说明该体裁本就该轻改）；
    //   c) 全篇垫词未超预算 —— 各注入点独立掷骰会叠加，必须有全局约束。
    //      v0.9.4 P2 已引入 countPadHeads/PAD_INJECT_CAP 跨轮守卫，此处复用同一口径。
    // v0.9.21 性能：原实现是先无条件算 `countPadHeads(out.join(""))`，再拿结果去和
    // 三个更便宜的布尔做 `&&`——而 countPadHeads 要扫描「已累积全文」，逐句调用即
    // O(句数 × 全文长)。单段长文实测超线性（38400 字 / 800 句：99.8ms，倍率 ×1.58）。
    // 挪到 `&&` 链**末端**后：默认风格是 plain（isCasual=false），这三条先短路，
    // 昂贵调用根本不会执行。countPadHeads 是纯函数、无副作用，短路掉它行为完全等价。
    const padInjectAllowed =
      !isAcademic && isCasual && !padForbiddenGenre && countPadHeads(out.join("")) < PAD_INJECT_CAP;
    if (
      padInjectAllowed &&
      rng() < INTERJECTION_RATE * intensity &&
      !lastWasInterjection &&
      !/^[，。！？!?；;]/.test(s) &&
      isCJK(s.charAt(0)) &&
      !startsWithConnector(s)
    ) {
      let cand = pick(rng, INTERJECTIONS);
      let guard = 0;
      while (usedInterjections.has(cand) && guard++ < 3) cand = pick(rng, INTERJECTIONS);
      usedInterjections.add(cand);
      s = cand + "，" + s;
      lastWasInterjection = true;
    } else {
      lastWasInterjection = false;
    }

    // 长句偶尔劈成两句
    // v0.9.51：参数表段不劈——C18 招标参数表实测条目句「配置不少于 2 颗 32 核
    // 处理器，内存容量不低于 512GB，硬盘容量不低于 4TB NVMe SSD，支持 RAID
    // 0/1/5/6」被这条路径劈成五句，规格表述碎成散文。与结构层
    // （structuralShuffleParagraph）/ 节奏兜底（boostBurstinessSingle）的
    // 参数表跳过同判据，三条路一起堵。
    if (
      !specTablePara &&
      s.length > SPLIT_SENTENCE_THRESHOLD &&
      rng() < SPLIT_SENTENCE_RATE * intensity
    ) {
      const mid = findSplitPoint(s, SPLIT_SENTENCE_THRESHOLD + 1);
      if (mid !== -1) {
        const tail = s.slice(mid + 1).trim();
        // v0.8.5：劈出的后半句必须能独立成句（使役"让/使/帮/叫"承接前句宾语时不能切）
        if (fragmentCanStand(tail)) {
          out.push(s.slice(0, mid).trim() + "。");
          out.push(tail);
          continue;
        }
      }
    }

    // 过短句偶尔与前句合并 —— 仅论说/公文/普通文风。
    //
    // v0.9.8 P0 收敛（六·续）：概率改用 eff（斜坡）。
    //   断崖真凶之一（scripts/_punct_probe.ts）：
    //     0.35 档「…路上。路过巷口…」保持独立（avgLen 20.4）
    //     0.40 档被合并成「…路上，路过巷口…」→ 三条一焊 avgLen 52.5 → 长句项独得 17 分
    //   为何 0.35 干净而 0.40 爆炸：合并开关跟着 intensity 线性爬（0.35→0.40 已能命中），
    //   而唯一的切句力量 boostBurstinessSingle 挂在 `intensity > 0.4` 严格比较上——
    //   0.40 档「合并开着、切句没开」，句长单向膨胀。这是**阈值错位**，不是撒得太多。
    //   改用 eff 后 0.35 档合并概率≈0，与切句阈值同向放开。
    //
    // v0.9.8 P0 收敛（六·续二）：叙事/人写体裁**不合并**。
    //   证据（scripts/_narr_len.ts，NARR_MULTI 0.9 档）：seed 间 avgLen 在 19.4 / 33 之间跳，
    //   段数虽保持 3，但段内短句被焊成长句（65 字段里出现 33 字长句）。
    //   叙事文本的断句本身就是作者的节奏表达——把「…汤。我…」焊成
    //   「…汤，我…」改变了语气，且丢失断句信息。humanize 的职责是去 AI 味，
    //   不是重写作者的句子边界。
    //   注意用 opts.genre 而非 effectiveGenre：humanizeSingle 作用域内只有 opts，
    //   调用方 humanize 已把 effectiveGenre 注入 opts.genre（见 humanize 内两处调用）。
    const mergeForbiddenGenre = opts.genre === "narrative" || opts.genre === "humanHand";
    // v0.9.36：纯标点段（切句残余的闭引号/闭括号）**不参与"短句合并"**，原样附回前句尾。
    //
    // 实证（2026-10-13 对话体语料人眼审查）：`"好，我这就去准备。"` 被切句后残余一个
    // 独立引号段，走进下面的合并模板「剥句尾标点 + ，+ s」⇒ 产出 `"好，我这就去准备，"`——
    // **句末句号被换成逗号、引号还在外面**，标点损坏（全种子复现）。
    // 引号不是"短句"，附回时不该动任何标点。
    const sHasWordChar = /[\u4e00-\u9fa5a-zA-Z0-9]/.test(s);
    if (!sHasWordChar) {
      if (out.length > 0) out[out.length - 1] += s;
      else out.push(s);
      continue;
    }
    if (
      !specTablePara &&
      !mergeForbiddenGenre &&
      out.length > 0 &&
      s.length < MERGE_SENTENCE_THRESHOLD &&
      out[out.length - 1].length < MERGE_SENTENCE_PREV_MAX &&
      rng() < MERGE_SENTENCE_RATE * eff
    ) {
      const prev = out.pop()!;
      out.push(prev.replace(/[。！？!?]+$/, "") + "，" + s);
      continue;
    }

    // 句尾偶尔软化
    if (
      !isAcademic &&
      /[。！]+$/.test(s) &&
      !lastWasInterjection &&
      !/[吗呢吧么啊]$/.test(s.slice(0, -1)) &&
      !/(性|化|所以|以及|亦|之所|不光|不仅|不但|与|互为|予以)/.test(s) &&
      isCJK(s.charAt(s.length - 2))
    ) {
      // v0.8.5 语体守卫：句尾落在书面抽象名词上时不加尾助词——
      // 「教育的本质呀。」「技术发展趋势嘛。」是书面语体 + 口语气词的错位组合，
      // 既是 scan-bugs 探针签名，也是真人一眼能读出的机器感。
      const stripped = s.replace(/[。！？!?]+$/, "");
      const formalityGuard =
        /[\u4e00-\u9fa5]{0,4}(行业|趋势|教育|技术|发展|本质|方案|融合|转型|体系|机制|模式|能力|水平|质量|效率|价值|意义|作用|目标|战略|格局|态势)$/.test(
          stripped,
        );
      const r = rng();
      // v0.9.8 P0 收敛（六·续）：叙事/人写体裁禁句尾语气词。
      //
      // 证据（scripts/archive/_narr9.ts，叙事种子 9）：即使句尾软化走了斜坡，
      //   0.80/1.00 档仍恒定产出 29 分（句式 28），污染源就是句尾「哈。」「呢。」——
      //   「…停不了哈。」「…叶子贴了一地呢。」这类聊天腔落在叙事文上是语体错位。
      //   avg 只有 2.1 却 max 29，一个坏种子的体验远重于均值。
      //
      // 为什么此前保留单字尾：注释（见下）说「A/B 显示不贡献污染分」，
      //   但那是在 humanizeSingle 单层测的；全文级（含朱雀层）复测推翻了该结论。
      //   对 casual 的论说/对话体裁仍保留——那里「嘛」「吧」是有效的人味信号。
      // v0.9.44：收敛到**只 dialogue 允许**句尾语气词（此前是 humanHand/narrative 禁、
      // main 照给）。
      //
      // 为什么连 main 一起禁（2026-10-14 引擎行为审计，21 篇真人文本/17.2 万字）：
      //   main 是**默认/通用**语体，同时承载口语化自媒体文案**与**书面说明文/公文。
      //   实测在 main 下向 19 篇**书面**文本注入了 354 处句尾语气词
      //   （4.5 处每百句，密度最高的《老舍》10.6 处每百句）：
      //     「1928年國民政府将北京改为北平**吧**。」「…视为北京城的源头**呢**。」
      //   ⇒ 书面/公文语体里的**明确病句**，而且方向是反的——AI 文本最爱加语气词，
      //     给书面稿加语气词等于**替 AI 加特征**。
      //
      // 与本函数下方评分器自相矛盾的事实：`humanize-metrics.ts` 把句尾语气词列为
      // 「3a 硬插，一次即定性」，**W_TAIL_PARTICLE = 12 分/处**（真污染扣分）。
      // 引擎此前是在**注入自己判定为污染的东西**。
      //
      // 需要口语人味的用户有 dialogue 这个显式选项，不必由 main 兜底。
      const tailForbiddenGenre = opts.genre !== "dialogue";
      // v0.9.36：引述标记「X道」（说道/问道/答道…）收尾不加语气词——「说道吧。」「问道呢。」
      // 是引述标记与口语气词的错位组合（对话体语料实测全种子复现，min repro: artifacts/_repro-v8.ts）。
      // 与 scan-bugs v8.0 探针「引述动词+语气词」共用 REPORTING_DAO_RE，判据天然对齐。
      const reportingTail = REPORTING_DAO_RE.test(stripped);
      if (!formalityGuard && !tailForbiddenGenre && !reportingTail) {
        // v0.9.8 P0 收敛（五）：废除 SOFT_TAIL_VARIANTS 句尾收束分支。
        //
        // 证据（A/B 实验，scripts/_ab_driver.ts）：单独关掉本分支，
        //   叙事 12 → 2（句式 12 → 0），论说与对话零变化 —— **只降不升**，
        //   是四个注入器里唯一净收益的收敛点。
        //
        // 为什么它是污染源：SOFT_TAIL_VARIANTS 全部 7 条都是口语插话
        //   （「，说白了。」「，你细品。」「，实话实说。」「，就这么回事。」
        //    「，搁谁都一样。」「，没毛病。」「，对吧。」），
        //   其中 5 条直接命中标尺 3e 的垫词/碎片表。
        //
        // 为什么可以删：它的设计目的是「制造收束节奏」，而这个职能已被
        //   boostBurstinessByCutting（纯切句、零注入）接管 —— 功能重复，
        //   且旧实现引入了新标尺要抓的污染。删掉不留功能缺口。
        //
        // 保留 SOFT_ENDINGS 单字尾（吧/呢/呀，概率 0.06×intensity 很低）：
        //   它们更轻，且 A/B 显示不贡献污染分（关掉后叙事仍是 12）。
        // 废除 SOFT_TAIL_VARIANTS 句尾收束分支（原第 1 分支）：
        //   `if (r < SOFT_ENDING_PROB * intensity && isCasual) { s += pick(rng, SOFT_TAIL_VARIANTS); }`
        // 只保留单字尾软化分支。
        // v0.9.8 P0 收敛（六·续）：概率改用 eff（斜坡）。
        //   句尾软化是全档位唯一「跟着 intensity 全程线性走」的注入线，
        //   0.35 档仍会撒「嘛/哈」（scripts/_punct_probe.ts 实测 seed=1/3 命中「嘛」），
        //   与「低档位应近乎零注入」的定位冲突。改用 eff 后 0.35 档自然归零。
        //
        // 保留 SOFT_ENDINGS 单字尾（吧/呢/嘛/呀/哈）：它们本身很轻，
        //   问题只在「不该在低档位出现」，不在「不该存在」。
        if (r < SOFT_ENDING_PROB * eff + SOFT_TAIL_PROB * eff) {
          s = s.replace(/[。！？!?]+$/, "") + pick(rng, SOFT_ENDINGS) + "。";
        }
      }
    }

    out.push(s);
  }

  if (on)
    emitStage(
      on,
      {
        id: "sentence",
        name: "逐句处理（节奏层）",
        why: "逐句跑四件事：句首垫词、劈长句、合并过短句、句尾软化。所有注入都受垫词总预算约束；剧本台词行与场景块行整句跳过，避免把垫词插到说话人前面。",
        charsBefore: working.length,
        metric: `句数 ${sentences.length} → ${out.length}`,
        ...(para === undefined ? {} : { para }),
      },
      tSent,
      out.join(""),
    );

  // 3) 重新拼接 + 清理
  const tJoin = on ? nowMs() : 0;
  let result = out
    .join("")
    .replace(/\n{2,}/g, "\n")
    .trim();
  result = result.replace(/—{3,}/g, "——");
  result = result
    .replace(/但，/g, "但")
    .replace(/([，、])\1+/g, "$1")
    .replace(/。，/g, "。")
    .replace(/，。/g, "。");
  result = stripCJKEdgeSpaces(result);
  if (on) {
    emitStage(
      on,
      {
        id: "cleanup",
        name: "拼接清理",
        why: "劈句与合并会留下重复标点、悬空连接词和「但，」这类粘连，这里统一收口。",
        charsBefore: prev.length,
        ...(para === undefined ? {} : { para }),
      },
      tJoin,
      result,
    );
    prev = result;
  }

  // 4) 确定性套话兜底
  const tCliche = on ? nowMs() : 0;
  result = stripAICliches(result);
  result = stripLeadingConnectivesHard(result);
  result = dedupePadWords(result);
  if (on) {
    emitStage(
      on,
      {
        id: "cliche",
        name: "套话兜底（与强度无关）",
        why: "确定性兜底，不吃强度参数：删残留 AI 套话、删句首连接词、全文去重垫词。前面所有概率性 pass 都可能漏，这一层保证下限。",
        charsBefore: prev.length,
        ...(para === undefined ? {} : { para }),
      },
      tCliche,
      result,
    );
    prev = result;
  }

  // 半角逗号微混入
  result = step(
    "halfwidth",
    "半角逗号微混入",
    "按 4%×强度 把全角逗号换成半角。真人手写中英混排时标点并不统一，这一点点不一致反而是人味。",
    () => injectHalfWidth(result, rng, 0.04 * intensity),
  );

  // 5) 句长节奏兜底
  const tBurst = on ? nowMs() : 0;
  // v0.9.51：参数表段落跳过节奏兜底。C18 招标参数表实测：条目句的参数并列
  // （「配置不少于 2 颗 32 核处理器，内存容量不低于 512GB，硬盘容量不低于
  //   4TB NVMe SSD，支持 RAID 0/1/5/6」）被 findGuardedCutNear 在每个逗号处
  // 劈开，规格表述碎成散文。参数表的节奏就是枚举节奏，不需要句长方差。
  if (intensity > 0.4 && !specTablePara) {
    const rng2 = makeRng(opts.seed, 3333);
    result = boostBurstinessSingle(result, rng2, 0.5 * intensity);
  }
  if (on) {
    emitStage(
      on,
      {
        id: "burst-single",
        name: intensity > 0.4 ? "段内节奏兜底" : "段内节奏兜底（跳过）",
        why: "段一级再补一次句长方差：只劈长句、不注入任何新词。全文级那道兜底在 humanize() 末尾，这里管段内。",
        charsBefore: prev.length,
        metric:
          intensity > 0.4
            ? `劈句概率 ${(0.5 * intensity).toFixed(2)}`
            : `强度 ${intensity.toFixed(2)} ≤ 0.4，段内不切`,
        skipped: !(intensity > 0.4),
        ...(para === undefined ? {} : { para }),
      },
      tBurst,
      result,
    );
    prev = result;
  }

  // 6) 标点相撞兜底 —— 必须放在**最后**。
  //    上面第 3 步已经做过一次同样的归一，但第 4/5 步会重新造出坏标点：
  //    stripAICliches 删掉句尾套话（「具有十分重要的意义」）后留下悬空的「，」，
  //    接上原句的「。」就是「，。」——示例文本实测 80 次里 40 次命中，
  //    而 aiScore 对这种标点残缺给中位 6 分（它只看词与结构，看不见坏标点）。
  //    injectHalfWidth 掺的是半角「,」，这里只收全角相撞形态，不会互相抵消。
  result = result
    .replace(/([，、])\1+/g, "$1")
    .replace(/，。|。，/g, "。")
    .replace(/。{2,}/g, "。")
    .replace(/(^|\n)[，、。；：]+/g, "$1");

  return result;
}

/* ======================== 朱雀增强：深度反检测特征 ======================== */

/** 启动时预计算剔除自替身后的候选列表（与 replaceVocab 一致） */
const DIALECT_CANDIDATES: [string, string[]][] = DIALECT_ENTRIES.map(([from, tos]) => {
  const realTos = tos.filter((t) => t !== from);
  return [from, realTos.length ? realTos : tos];
});

/**
 * 方言/地域化口语替换。
 *
 * @deprecated v0.9.8 P0 —— **已停用，不再被 applyZhuqueFeatures 调用**。
 * 停用原因见 applyZhuqueFeatures 内注释：与 anti-fingerprint 的还原表左右手互搏，
 * 注入的 10 处里 8 处被还原，净留的 2 处残渣（寻思/寻/整）同时喂病词与 3e 两个扣分项，
 * 属净负收益。函数本体保留以备回滚，**不要重新接回主路径**。
 * 导出仅为消除 unused 告警并保留回滚入口。
 */
export function injectDialect(text: string, rng: () => number, p: number): string {
  if (p <= 0) return text;
  // P8 场景块保真：按行护盾——方言表单字词（做/说/从/看）会污染【场景：从早上八点】类块头
  return text
    .split("\n")
    .map((ln) => (isSceneBlockLine(ln) ? ln : injectDialectLine(ln, rng, p)))
    .join("\n");
}
function injectDialectLine(base: string, rng: () => number, p: number): string {
  for (const [from, candidates] of DIALECT_CANDIDATES) {
    const total = base.split(from).length - 1;
    if (total === 0) continue;
    // 每词上限：最多 3 处，且不超过全文出现次数 × 0.25（+p 保证 p 足够大时至少改 1 处）
    const cap = Math.max(1, Math.min(3, Math.ceil(total * 0.25 + p)));
    let replaced = 0;
    let idx = 0;
    while ((idx = base.indexOf(from, idx)) !== -1 && replaced < cap) {
      // 每个命中位置无条件消耗一次 rng（与原实现 rng 序列消费节奏一致）
      if (rng() < p) {
        const rep = pick(rng, candidates);
        base = base.slice(0, idx) + rep + base.slice(idx + from.length);
        idx += rep.length;
        replaced++;
      } else {
        idx += from.length;
      }
    }
  }
  return base;
}

// P7-F 段落感知：splitSentences().trim() 会剥掉句尾 \n\n，splitSentences→join("") 会把
// 多段焊成一段（postmortem 缺陷二的同款模式）。朱雀增强路径的三处全文级注入必须复用
// boostBurstiness / clampAvgSentenceLenUnder25 已验证的分段分发模式。
function injectParentheticals(text: string, rng: () => number, p: number): string {
  if (!text.includes("\n\n")) return injectParentheticalsBlock(text, rng, p);
  return text
    .split(/\n\n+/)
    .map((para) => injectParentheticalsBlock(para, rng, p))
    .join("\n\n");
}
function injectParentheticalsBlock(text: string, rng: () => number, p: number): string {
  // v0.9.8：按行分发——剧本块头行与台词行原样保留。
  // splitSentences 会跨行切句，直接用 isSceneBlockLine 逐句判定会漏掉台词行
  // （「张总（项目经理）：…」不含【】，块头判定不命中）。
  return text
    .split("\n")
    .map((line) => {
      if (isScriptFormatLine(line)) return line;
      const sentences = splitSentences(line);
      const out: string[] = [];
      for (let i = 0; i < sentences.length; i++) {
        let s = sentences[i];
        if (s.length < 15 || rng() >= p) {
          out.push(s);
          continue;
        }
        const comma = s.indexOf("，");
        if (comma > 3 && comma < s.length - 5) {
          const paren = pick(rng, PARENTHETICALS);
          const form = rng() < 0.5 ? "，" + paren + "，" : "——" + paren + "——";
          s = s.slice(0, comma) + form + s.slice(comma + 1);
        }
        out.push(s);
      }
      return out.join("");
    })
    .join("\n");
}

function injectFragments(text: string, rng: () => number, p: number): string {
  const paras = text.split(/\n\n+/);
  if (paras.length < 2) return text;
  const out: string[] = [];
  // v0.8.4：碎片全文去重 + 总量封顶（约每 3 段最多 1 条）——原实现可同碎片复读、
  // 多段连塞，碎片复读与语气词复读一样是可被统计抓到的机器指纹
  const used = new Set<string>();
  let injected = 0;
  const cap = Math.max(1, Math.ceil(paras.length / 3));
  for (const para of paras) {
    let ptext = para.trim();
    if (!ptext) continue;
    if (injected < cap && rng() < p) {
      const fresh = SENTENCE_FRAGMENTS.filter((f) => !used.has(f));
      if (fresh.length) {
        const frag = pick(rng, fresh);
        used.add(frag);
        ptext += "\n\n" + frag;
        injected++;
      }
    }
    out.push(ptext);
  }
  return out.join("\n\n");
}

// P7-F 段落感知：同 injectParentheticals，避免多段被焊成一段
function injectOpinion(text: string, rng: () => number, p: number): string {
  if (!text.includes("\n\n")) return injectOpinionBlock(text, rng, p);
  return text
    .split(/\n\n+/)
    .map((para) => injectOpinionBlock(para, rng, p))
    .join("\n\n");
}
function injectOpinionBlock(text: string, rng: () => number, p: number): string {
  // v0.9.8：按行分发——剧本块头行与台词行原样保留。
  // 台词行漏网时 injectOpinion 会把垫词插到说话人**前面**：
  //   「讲真，张总（项目经理）：这个季度的指标完成得怎么样了？」
  // 说话人标签前不得有任何修饰，这会直接破坏剧本格式。
  const used = new Set<string>();
  return text
    .split("\n")
    .map((line) => {
      if (isScriptFormatLine(line)) return line;
      const sentences = splitSentences(line);
      const out: string[] = [];
      let lastOpinion = false;
      for (let i = 0; i < sentences.length; i++) {
        let s = sentences[i];
        const hasOpinion = /^(我觉得|我认为|在我看来|以我的经验|我个人的看法|我寻思着|要我说)/.test(
          s,
        );
        const hasInterjection = /^(说真的|说实话|老实讲|讲真|说白了|你别说|不瞒你说)/.test(s);
        if (s.length > 10 && rng() < p && !lastOpinion && !hasOpinion && !hasInterjection) {
          let op = pick(rng, OPINION_PHRASES);
          let guard = 0;
          while (used.has(op) && guard++ < 3) op = pick(rng, OPINION_PHRASES);
          used.add(op);
          s = op + "，" + s;
          lastOpinion = true;
        } else {
          lastOpinion = false;
        }
        out.push(s);
      }
      return out.join("");
    })
    .join("\n");
}

// P7-F 段落感知：同 injectParentheticals，避免多段被焊成一段
function injectParentheticNotes(text: string, rng: () => number, p: number): string {
  if (!text.includes("\n\n")) return injectParentheticNotesBlock(text, rng, p);
  return text
    .split(/\n\n+/)
    .map((para) => injectParentheticNotesBlock(para, rng, p))
    .join("\n\n");
}
function injectParentheticNotesBlock(text: string, rng: () => number, p: number): string {
  const sentences = splitSentences(text);
  const out: string[] = [];
  for (const s of sentences) {
    if (isSceneBlockLine(s)) {
      out.push(s);
      continue;
    }
    if (s.length > 15 && rng() < p) {
      const note = "（" + pick(rng, PARENTHETIC_NOTES) + "）";
      out.push(s + note);
    } else {
      out.push(s);
    }
  }
  return out.join("");
}

/* ----------------------------- 一键去味+评分 ----------------------------- */

/** 去味建议码（v0.9.22）：告诉调用方"这篇该不该送去味" */
export type AdviceCode = "ok" | "skip-low-risk";

export interface HumanizeAdvice {
  code: AdviceCode;
  /** 直接可展示给用户的一句话；code==="ok" 时为空串 */
  message: string;
}

/**
 * v0.9.22：低风险输入的"其实不用去味"提示。
 *
 * 实测（2026-10-04，5 段自写文本 × 3 档）：aiScore 8 的人写叙事、aiScore 0 的口语随笔
 * 照改不误，且**动了作者原本的断句**（「后来我才知道，那是…」→「后来我才知道。那是…」）。
 * 而本项目自己的标定结论是反的：README §aiScore→朱雀分标定里"纯人写稿对照"线斜率
 * 为**负**（−0.3x+18.0）——**真人原稿越去味，官方朱雀分反而越高**（H0=15% → H1/H2=17~19%）。
 *
 * ⇒ 因此这里只**给提示，不改行为**。为什么不顺手把这类输入跳过：
 *   regression-12samples 的 H1/H2 两条就是纯人写样本，基线要求去味后 aiScore 从 48 降到 0；
 *   真跳过处理会让 E 组基线瞬间爆红。那不是"顺手"，那是要连同四条体裁线重新拟合的改动，
 *   得单独评估，不能塞在一次语言质量修复里。
 */
export function adviceFor(text: string, beforeScore?: number): HumanizeAdvice {
  const score = beforeScore ?? aiScore(text).score;
  if (score <= AI_SCORE_HUMAN_MAX) {
    return {
      code: "skip-low-risk",
      message:
        `原文 AI 味代理分 ${score}，已落在人写带（≤${AI_SCORE_HUMAN_MAX}）。` +
        `再跑一遍只会动你的断句和用词、几乎不会再降分——按本项目标定，纯人写稿越去味官方分反而略升。` +
        `建议：直接用原文提交；确实要动，挑 0.4 以下的轻度档。`,
    };
  }
  return { code: "ok", message: "" };
}

/** 一键：去味 + 前后评分，方便 UI 直接调用 */
export function humanizeWithScore(
  text: string,
  opts: HumanizeOptions = {},
): { text: string; before: ScoreBreakdown; after: ScoreBreakdown; advice: HumanizeAdvice } {
  const before = aiScore(text);
  const result = humanize(text, opts);
  const after = aiScore(result);
  return { text: result, before, after, advice: adviceFor(text, before.score) };
}
