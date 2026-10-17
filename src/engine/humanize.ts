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
  startsWithConnector,
  fragmentCanStand,
  FORMULAIC,
  guardBlocks,
  isCJK,
  splitSentences,
  pick,
  makeRng,
  HumanizeOptions,
  RewriteStyle,
} from "./humanize-data.ts";

// v0.9.53 拆分阶段 1a：替换规则 + 概率/阈值 + FORMAL_FORBIDDEN_SUBSTITUTES + wouldCascade
// （原为本文件内联定义，详见 docs/humanize-split-plan.md）
import {
  wouldCascade,
  DIR_MODIFIER_VERB_CLASH_RE,
  FORMAL_FORBIDDEN_SUBSTITUTES,
} from "./humanize-rules.ts";

import {
  dedupePadWords,
  limitPunctuation,
  crossChunkCleanup,
  mechanicalShuffle,
  resegmentParagraphsAggressive,
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
  fixBrokenCollocations,
  isSpecTableParagraph,
} from "./anti-fingerprint.ts";

// P7 引擎级体裁联动：自动体裁识别 + 每体裁参数旋钮
import { classifyGenre, AutoGenre, suppressSelfQA } from "./classify-genre.ts";
// v0.9.53 拆分阶段 1b：朱雀增强 + 本地引擎单遍主体搬到 humanize-zhuque-apply.ts
import { applyZhuqueFeatures, humanizeSingle, injectDialect } from "./humanize-zhuque-apply.ts";
export { wouldCascade, DIR_MODIFIER_VERB_CLASH_RE, FORMAL_FORBIDDEN_SUBSTITUTES };
// scripts/scan-bugs.ts 的未然从句补「了」探针与引擎守卫共用同一条正则（v0.9.53 起住在 humanize-replace.ts）
export { PURPOSE_LE_RE, NORMATIVE_LE_RE } from "./humanize-replace.ts";
// 公开 API 面不变：applyZhuqueFeatures / injectDialect 经此 re-export
export { applyZhuqueFeatures, injectDialect };

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
