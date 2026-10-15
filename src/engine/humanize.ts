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
  VOCAB_ENTRIES,
  INFORMAL_ONLY_KEYS,
  OPENERS,
  INTERJECTIONS,
  startsWithConnector,
  SOFT_ENDINGS,
  fragmentCanStand,
  FORMULAIC,
  guardBlocks,
  MEDIUM_NOUN_AFTER,
  isSceneBlockLine,
  isScriptFormatLine,
  isCJK,
  splitSentences,
  pick,
  LE_VERBS,
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
} from "./anti-fingerprint.ts";

// P7 引擎级体裁联动：自动体裁识别 + 每体裁参数旋钮
import { classifyGenre, AutoGenre, suppressSelfQA } from "./classify-genre.ts";
import { keepOnlyIfDetectDrops } from "./detector.ts";
// v0.8.6 术语保护：受保护术语位置禁止替换/拆句
import { isProtectedTerm } from "./term-protect.ts";

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

/* ----------------------------- 常量：概率 / 阈值 ----------------------------- */

/** 替换概率公式基数：强度0 时完全不动词；从 0.65 起步保证常用强度下替换更彻底 */
const REPLACE_VOCAB_BASE = 0.65;
const REPLACE_VOCAB_SLOPE = 0.45;
const SOFT_ENDING_PROB = 0.06;
const SOFT_TAIL_PROB = 0.12;
const SPLIT_SENTENCE_THRESHOLD = 34;
const SPLIT_SENTENCE_RATE = 0.45;
const MERGE_SENTENCE_THRESHOLD = 9;
const MERGE_SENTENCE_PREV_MAX = 16;
const MERGE_SENTENCE_RATE = 0.35;
const INTERJECTION_RATE = 0.22;
const DROP_CONNECTIVE_INTENSITY_THRESHOLD = 0.45;

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

/** 剧本格式的场景/人物/背景/时间/角色/旁白/简介 段首块正则（P7-E 共用） */
// P7-E：剧本场景块行头。无锚 + 按行扫描——前置方言/观点注入会在段首加垫词，
// ^ 锚定的整段匹配会被击穿（台词区被塞自问自答的真实缺陷）
const SCENE_BLOCK_LINE_RE = /【[^】]{0,80}(?:场景|人物|角色|地点|时间|背景|旁白|简介)[^】]{0,80}】/;

/* ----------------------------- 替换规则 ----------------------------- */

/** 启动时预计算剔除自替身后的候选列表，避免每次调用重复 filter 全表 */
const REPLACE_VOCAB_CANDIDATES: [string, string[]][] = VOCAB_ENTRIES.map(([from, tos]) => {
  const realTos = tos.filter((t) => t !== from);
  return [from, realTos.length ? realTos : tos];
});

/**
 * v0.9.22 级联守卫：全部源词集合。
 *
 * `replaceVocab` 是**逐词条**循环的，且每轮都写回同一个 `base`——所以上一轮替换
 * **产出的替身**会成为下一轮 `indexOf(from)` 的命中目标。实测：
 *   「真正实现可持续的发展」→ 词条「实现→落地」产出"真正落地…"
 *   → 词条「落地→真正做出来」再替一次 → **"真正真正做出来可持续的发展"**。
 *
 * 单个词条看都没错，叠加就炸。全表扫一遍只有 4 条替身落回词表
 * （至关重要→举足轻重 / 实现→落地 / 推动→带动 / 持续→不断），
 * 且**没有任何一条的链式是设计意图**——链式只会让替身被二次口语化，越替越破。
 * 因此凡替身本身是源词的一律作废该次替换（保留原词），而不是等下游打补丁。
 */
const VOCAB_KEY_SET: Set<string> = new Set(REPLACE_VOCAB_CANDIDATES.map(([k]) => k));

/**
 * v0.9.24 **助词结尾词条的前缀闭包**：`前缀 → 至少一个以它开头的助词结尾源词`。
 *
 * 词表实测 14 对前缀重叠（取得 ⊂ 取得了、展现 ⊂ 展现出 ⊂ 展现出了、
 * 发挥 ⊂ 发挥着 ⊂ 发挥了、日益 ⊂ 日益增多/增加/增长…）。
 * `replaceVocab` 逐词条循环改写共享的 `base`，同一位置会被**整条前缀链**依次命中。
 *
 * 探针日志实录（本轮最贵的一次定位）：
 *
 *     [SCAN] from=取得了 idx=2   ← 类别守卫命中，跳过（base 未被改写）
 *     [SCAN] from=取得   idx=2   ← 「取得了」原样还在，前缀立刻顶上来
 *     OUT:  我们拿到了地这件事      ← 词干被换、助词残留 ⇒ 病句
 *
 * 所以**只拦长词条是无效的**——拦住的瞬间前缀就补位。必须让**前缀也知道**
 * 「我这条链上有以助词结尾的词条」，一起让位，源词才能完整保留。
 *
 * 这里取「前缀 → 该前缀下最长的助词结尾词条」，一个前缀只需登记一次。
 */
const PARTICLE_PREFIX_BLOCK: Set<string> = (() => {
  const keys = REPLACE_VOCAB_CANDIDATES.map(([k]) => k);
  const s = new Set<string>();
  for (const k of keys) {
    // ⚠️ 只看「了/着」，与 guardBlocks 的类别规则保持一致。
    //   收「地/得」会把「取得」「获得」「落地」的前缀也拦掉——它们是正常词条。
    if (!"了着".includes(k[k.length - 1])) continue;
    for (let i = 1; i < k.length; i++) s.add(k.slice(0, i)); // 登记它的所有真前缀
  }
  return s;
})();

/**
 * 该替身是否**本身也是词表里的源词**（即会不会被下一轮词条循环再替一次）。
 *
 * 导出它是为了让 `humanize-quality-v0922.test.ts` 能白盒钉住这个集合——
 * 端到端那条断言当前被「落地」的前置守卫遮蔽（见下方用例注释），
 * 光靠端到端会变成一条永远绿的假绿断言。
 */
export function wouldCascade(rep: string): boolean {
  return VOCAB_KEY_SET.has(rep);
}

/**
 * v0.9.22 类别级守卫：口语「结果动词」不能带抽象名词宾语。
 *
 * 这些替身（搞出/弄出/干出/整出…）是**动结式口语动词**，语义上要求宾语是
 * 具体、可做出来的东西（"搞出一个方案""弄出个结果"）。接抽象名词就成了病句：
 *   实测「建立健全的监管框架」→「搞出健全的监管框架」
 *        （框架是抽象制度，不是"搞出来"的物件）
 *
 * 为什么做成**类别级**而不是给「建立」加一条 GUARD_AFTER：
 *   ——这条错的不是「建立」这一个词，是"口语结果动词 + 抽象名词"这**一类**搭配。
 *   给「建立」打补丁，下次有人给「制定/形成/确立」配上「搞出」照样翻车。
 *   类别级守卫一次覆盖全表，且替身表将来加词也自动受保护。
 */
const COLLOQUIAL_RESULT_VERBS = new Set([
  "搞出",
  "弄出",
  "干出",
  "整出",
  "弄成",
  "搞成",
  "搞出来",
  "弄出来",
  "干出来",
  "整出来",
  "搞起",
  "弄起",
]);

/**
 * v0.9.31：方向/性质类修饰语（正向/逆向/良性/负向）**接行为动词** = 搭配不当。
 *
 * 实测：`积极→正向`（v0.9.22 特意保留的替身，原注释写"可搭配"）产出
 * 「我们应当**正向拥抱**人工智能技术」「各家企业都在**正向构建**自身的技术护城河」
 * ——150 次运行命中 56 次。而同一批运行里「正向作用/正向影响/正向反馈」有 27 次且都成立。
 *
 * ⇒ 结论不是"这个词不能用"，是**位置**：正向 + 名词（作用/影响/反馈/情绪）成立，
 *   正向 + 行为动词（拥抱/构建/推动/参与…）不成立。所以做位置守卫，不删词条
 *   ——删掉会连那 27 次合法替换一起废掉，白丢去味机会。
 *
 * ⚠️ 守卫与探针（`scan-bugs` v8.0「方向修饰语+行为动词」）**共用这一条正则**：
 *   守卫侧测 `rep + 右邻2字`，探针侧测整段输出。同表才不会出现
 *   "守卫否掉的比签名抓的多/少"这类对不齐（NP_TAIL_RE 的教训）。
 */
export const DIR_MODIFIER_VERB_CLASH_RE =
  /(?:\u6b63\u5411|\u9006\u5411|\u8d1f\u5411|\u826f\u6027|\u6076\u6027)(?:\u62e5\u62b1|\u63a8\u52a8|\u53c2\u4e0e|\u54cd\u5e94|\u63a8\u8fdb|\u5e94\u5bf9|\u5f00\u5c55|\u53d1\u6325|\u843d\u5b9e|\u6539\u8fdb|\u8c03\u6574|\u63a2\u7d22|\u5c1d\u8bd5|\u914d\u5408|\u534f\u8c03|\u5bf9\u63a5|\u5f15\u5bfc|\u5e26\u52a8|\u4fc3\u8fdb|\u5021\u5bfc|\u5b66\u4e60|\u501f\u9274|\u5e03\u5c40|\u8ddf\u8fdb|\u4e89\u53d6|\u91c7\u7eb3|\u6c9f\u901a|\u5ba3\u4f20|\u57f9\u80b2|\u6276\u6301|\u6784\u5efa|\u5efa\u7acb|\u5b8c\u5584|\u4f18\u5316|\u63d0\u5347|\u63d0\u9ad8|\u5b9e\u73b0|\u4fdd\u969c|\u52a0\u5f3a|\u90e8\u7f72|\u843d\u5730|\u53d1\u529b|\u53c2\u52a0)/;

/** 抽象名词宾语（8 字窗口内出现即判为抽象宾语位）
 *
 *  v0.9.31：补**制度法规类**（法律/法规/法令/条例/规章/纪律/规矩/公约/条约）。
 *  起因是 `建立→搞出` 命中「建立健全相关的法律法规」→ **「搞出健全相关的法律法规」**
 *  （实测 27/30，scan-bugs v8.0「口语动词+制度法规宾语」）。旧表收了「制度/规范/规则」
 *  却漏了「法律法规」——同一语义场的词，漏一半等于这条守卫只在半个场里生效。 */
/**
 * v0.9.22：口语结果动词（见 COLLOQUIAL_RESULT_VERBS）不该接抽象名词宾语。
 *
 * ⚠️ v0.9.46 距离上限 6 → 12（与调用处 slice 窗口同步 8 → 14）：
 * 真实案例 C2 公众号观点文实测产出「我们需要搞出一个清晰的自我认识体系」——
 * 宾语前に9 字修饰语（"一个清晰的自我认识"），在 6 字窗口内完全看不到"体系"，
 * 于是 clashAbstract 不命中、病句放行。模板语料的宾语几乎都是零修饰，测不出这个洞。
 * 放宽方向是**多否决替换**（宁可少改，不可错改），与既定方针同向。
 */
const ABSTRACT_OBJECT_RE =
  /^[\s\S]{0,12}(?:框架|机制|体系|格局|价值|水平|质量|效率|意义|能力|模式|结构|制度|规范|标准|流程|生态|共识|关系|布局|目标|任务|要求|原则|方针|政策|战略|愿景|理念|文化|氛围|环境|条件|基础|保障|支撑|引领|指导|监管|治理|服务|管理|评价|评估|指标|模型|方法|方案|路径|思路|逻辑|规则|秩序|信誉|口碑|信任|权威|优势|潜力|空间|机遇|挑战|风险|压力|动力|活力|合力|效力|影响力|竞争力|凝聚力|创造力|生产力|法律法规|法律|法规|法令|条例|规章|纪律|规矩|公约|条约)/;

/**
 * v0.9.46：正式语体下**不得采用**的口语替身（按"替身"而不是源词冻结）。
 *
 * 为什么是这张表：此前的处置方式是"事后打补丁"——先在 VOCAB 层把「努力」换成「使劲」、
 * 把「围绕」换成「环绕」，再靠 anti-fingerprint 的 FORMAL_RESTORE（和 v0.9.46 新增的
 * fixBrokenCollocations）把它们在正式语体下改回来。问题是补丁必须逐条写、且只在
 * formal 门控打开时跑；真实案例 C1（季度工作总结）实测照样产出「使劲在下一季度取得」
 * 「紧紧环绕公司年度战略目标」「主要看得出来在跨部门…」——说明补丁既不全也太晚。
 *
 * 治本：在**替换阶段**就把这些替身否掉，该处保留原词。
 * 取舍：宁可少改一处，不可先改成病句再指望下游救回来（与项目既定方针同向）。
 *
 * 收词口径（不自造新判断）：只收**当前真在 VOCAB 候选里**的替身。
 * 由 `vocab-formal-substitutes.test.ts` 自动校验这张表的两项合法性：
 *   ① 每个词必须在某个 VOCAB 词条的候选里出现（否则写了也拦不住任何东西）；
 *   ② 每个词要么已被 FORMAL_RESTORE 还原、要么有真实案例实证。
 *
 * ⚠️ 初版曾把 FORMAL_RESTORE 的 9 个目标词（死磕/摆平/捋顺/弄全/兜好/盯紧/把牢/兜住/搭起）
 *    一起抄进来，被第 ① 条当场抓出：**它们早已从 VOCAB 整条删除**（见 humanize-vocab.ts 的
 *    "构筑/完善"词条注释），FORMAL_RESTORE 里那些规则是历史保险。抄进来只会让表看起来很全、
 *    实际一个都拦不住。 ⇒ 教训：表必须从"当前词表"倒推，不能从"补丁表"顺推。
 *
 * ⚠️ 实现要点：只**否决**结果、不重新挑选，也不额外消耗 rng。
 *    原实现注释明确写着"每个命中位置无条件消耗一次 rng"，与其配套的所有 lithium
 *    （regression-12 / quality / bestof）都按这个序列复现；多调一次 pick 会让全仓 seed
 *    敏感断言整体漂移。
 */
export const FORMAL_FORBIDDEN_SUBSTITUTES = new Set([
  // —— FORMAL_RESTORE 已经在还原的（且当前 VOCAB 里仍然存在的）——
  "拔高",
  "稳当",
  // —— 本轮真实案例新增（scripts/realcase C1 季度工作总结实测产出）——
  "使劲", // 努力 → 使劲：「使劲在下一季度取得更加优异的成绩」——总结体里的语体崩
  "环绕", // 围绕 → 环绕：「紧紧环绕公司年度战略目标」——FORMAL_RESTORE 只写了「环绕年度」这一组合
  "看得出来", // 体现 → 看得出来：「主要看得出来在跨部门…」——谓词位置的错配
  // —— v0.9.49：C1 剩余两条缺陷。这两条的源词条是**混合池**（含正式安全替身），
  //    按收词口径不进 INFORMAL_ONLY_KEYS，坏的那一个替身在这里毙——
  //    两条线各管各的：整池口语走词条级，混合池走替身级。
  "做到位", // 落实 → 做到位：「方方面面做到位各项重点工作任务」——动补结构套名词短语
  "一起", // 协同 → 一起：「跨部门一起效率有待提升」；通力 → 一起 同样毙（一起在正式体是语体崩）
  // —— v0.9.49：赋能/心智的口语三人组。这两个源词是 LEAK_WORDS 营销黑话，
  //    强度 1.0 下无论体裁都必须换掉（verify-quality 零泄漏门禁），所以不能整条冻结；
  //    v0.9.49 给池子补了正式安全候选（赋能+「助力」、心智+「思路」），
  //    其余口语替身在这里毙掉 ⇒ 正式体只可能挑中安全候选。
  //    证据类别见 vocab-formal-substitutes.test.ts 的 LEAK_WORD_PROVEN。
  "助攻", // 赋能 → 助攻（正式体语体崩）
  "帮衬", // 赋能 → 帮衬
  "帮着", // 赋能 → 帮着
  "心思", // 心智 → 心思
  "脑子", // 心智 → 脑子
  "心神", // 心智 → 心神
  // —— v0.9.50 第二批：来源不是"猜"，而是 scripts/realcase/leak-scan.ts 的
  //    **多种子复核窗**（10 篇 × 12 seed，正式体裁产出里真的写了这些词）。
  //    收词口径与上一版一致：混合池只毙坏的那一个，留下来的一定是正式可用的。
  "变强", // 增强 → [强化, 变强, 加把劲]：「强化」正式安全，另两个毙
  "加把劲", // 同上（正式体裁产出 6/12 seed）
  "抓实", // 加强 → [强化, 抓实, 抓紧]：「强化」正式安全
  "抓紧", // 同上
  "联手", // 协同 / 通力 → 联手：「配合 / 合力」正式安全（跨篇累计 14 次命中）
  "这么一来", // 从而 → [这么一来, 借此]：学术摘要实测「这么一来增强了模型的迁移能力」
]);

/* ------------------------------------------------------------------
  v0.9.50 试错存档：SCORING_EXCLUDE 派生冻结（已废弃，保留理由）
  ------------------------------------------------------------------
  思路曾很漂亮：SCORING_EXCLUDE 是项目自己认定的「正常书面语、不计 aiScore」名单，
  那么在正式语体下把它换成口语词的收益恒为 0、风险恒为正 ⇒ 一律冻结。
  实测（scripts/realcase 10 篇 × 12 seed）**确实一分 aiScore 都没掉**。

  但 verify-quality 的门禁全线报警，所以它错在用 aiScore 当唯一代价函数：
    · H0 纯人稿 6 → 7、O1 论说原文检出力 44 → 43、N1 叙事基础档 3 → 8
    · 分离度 min(AI原文)-H0 = 26 < 27（D 组绝对刻度守卫红）
    · 8 条单测红，多数以「提升 → 提高」为载体——这个词被冻掉后，
      宁定语感的去味收益实实在在少了一块。
  ⇒ 正式体裁下**看得过时而被视为 written-language 的词**（提升→提高、显著→明显）
    正是去味的主力，不能因为"不算分"就否掉。
  教训再记一条：**「替换不改善某个指标」不等于「替换没有价值」**。
  aiScore 是本地代理分，拿它当唯一代价函数会把路线带偏（与 memory 里
  「aiScore 不与朱雀官方分标定」同源）。
  处置：回到"见一个冻一个"，但必须有**多种子实测证据**才收录，见 INFORMAL_ONLY_KEYS 注释。
------------------------------------------------------------------ */

/** v0.9 专家修复 P5：academic 文风下禁止的口语替身（书面语体错位签名）。
 *  按源词建白名单表——源词在这些学术语义词上不得替换成口语替身。 */
const ACADEMIC_FROZEN = new Set([
  "改善",
  "持续",
  "推动",
  "认知",
  "总而言之",
  "综上所述",
  "本质上",
  "值得注意的是",
  "由此可见",
  "事实上",
  "此外",
  "因此",
  "然而",
  "从而",
  "进而",
  "逐步",
  "日益",
  "愈发",
  "亟需",
  "亟待",
  "尚待",
  "已然",
  "不容忽视",
  "不容小觑",
  "至关重要",
  // v0.9 长尾：书面连接词的口语替身在学术体里同样错位（与此同时→这期间/另一头）
  "与此同时",
  "伴随着",
  "具体而言",
  "换言之",
  "不仅",
  "而且",
  "诸如",
  "诸如",
]);

/** 替换文本里命中 VOCAB 的词（单趟收集命中、每词条一次线性拼接，避免逐命中整串重建） */
function replaceVocab(
  text: string,
  rng: () => number,
  intensity: number,
  style: RewriteStyle = "casual",
  /** 正式语体（main / academic）：VOCAB 的口语替身在替换阶段直接否掉，见 FORMAL_FORBIDDEN_SUBSTITUTES */
  formal = false,
): string {
  const p = intensity <= 0 ? 0 : Math.min(1, REPLACE_VOCAB_BASE + REPLACE_VOCAB_SLOPE * intensity);
  const academic = style === "academic";
  const formalSubstituteBlocked = formal || academic;
  let base = text;
  for (const [from, candidates] of REPLACE_VOCAB_CANDIDATES) {
    let idx = base.indexOf(from);
    if (idx === -1) continue;
    // P5：academic 冻结表——学术语义词的口语替身（调顺/推一把/没停过/拉总账）
    // 是书面语体 + 口语词的错位签名，学术体下直接跳过替换
    const frozen = academic && ACADEMIC_FROZEN.has(from);
    const hits: { at: number; rep: string }[] = [];
    while (idx !== -1) {
      const end = idx + from.length;
      // 与原实现一致：每个命中位置无条件消耗一次 rng
      if (
        !frozen &&
        rng() < p &&
        // v0.8.6 术语保护：命中位置落在受保护术语内则跳过（不影响 rng 消耗节奏）
        !isProtectedTerm(base, idx, end) &&
        // 前窗取 6 字而非 3 字：够着"受到广泛"这类隔了状语的搭配。
        // judgeGuardBlocks 里所有前缀判据都是尾锚定（endsWith / /…$/），加宽不改变既有行为。
        !guardBlocks(from, base.slice(end, end + 8), base.slice(Math.max(0, idx - 6), idx)) &&
        // v0.9.24 前缀闭包：本词条是某个「助词结尾词条」的前缀 → 一起让位。
        // 见 PARTICLE_PREFIX_BLOCK 注释：不加这条，守卫拦住「取得了」的那一刻，
        // 「取得」会立刻在同一位置顶上来，替换词干并把助词留成病句。
        !PARTICLE_PREFIX_BLOCK.has(from)
      ) {
        // v0.9.49 正式语体候选**预滤**：被否决的替身在 pick 之前就滤出候选池，
        // 而不是 v0.9.46 的"挑了再毙"。后者在强度 1.0（p=1.0，每个命中都过门）
        // 等于按池子比例直接不换——实测赋能（池 4 个毙 3 个）19/25 seed 泄漏、
        // 心智 16/25，verify-quality 的零泄漏门禁当场红。预滤后 pick 永远落在
        // 安全候选上，强度 1.0 恢复 100% 替换。
        // ⚠️ 不违反 rng 纪律：pick 固定只调一次 rng()，滤池子不改变消耗次数，
        //    随机序列与此前逐位一致（变的是"这次挑中谁"，不是"何时挑"）。
        // 整池口语词条（INFORMAL_ONLY_KEYS）不走预滤——它们在下面 clashInformalEntry
        // 整条否决；那些池子里剩下的"次口语"替身（围着/下功夫）同样不许上场。
        const formalPool =
          formalSubstituteBlocked && !INFORMAL_ONLY_KEYS.has(from)
            ? candidates.filter((c) => !FORMAL_FORBIDDEN_SUBSTITUTES.has(c))
            : candidates;
        let rep = pick(rng, formalPool);
        // v0.9.41 替身降级（MEDIUM_DOWNGRADE）：「通过」后紧邻媒介/渠道名词时，
        // 「靠/借」崩坏（"靠短信通知"×）——但与 VERB_PHRASE_AFTER 的处置不同：
        // 那条是「跳过替换」（宁保留原词），本条**降级到「用」**（"用短信通知"√），
        // 保留去味收益。候选里没有「用」时不动（宁保留原选，不引入未验证的替身）。
        // 实证：操作说明语料 × 20 seed，"靠短信通知/靠邮件发送"稳定复现；
        // 判据必须紧邻（8 字窗口会把"通过各部门协作，用短信通知"误算）。
        if (
          (rep === "靠" || rep === "借") &&
          candidates.includes("用") &&
          MEDIUM_NOUN_AFTER.test(base.slice(end, end + 8))
        ) {
          rep = "用";
        }
        // v0.9.22 级联守卫（见 VOCAB_KEY_SET 注释）：替身本身是源词 → 会被下一轮
        // 词条循环再替一次（「实现→落地」后再「落地→真正做出来」）。作废该次替换。
        // v0.8.9 叠字守卫（右侧）：替换词尾字与右侧首字相同时将产生叠字——
        // 「彰显着」→「透着着」、「不仅是」→「不只是是」。
        // v0.9.22 补**左侧**：原守卫只查了右侧，漏了"替身首字撞左侧末字"。
        // 实测「从X的角度」模板先产出"从X看"，随后词条「审视→看看」再命中
        // → **"从治理与合规看看看"**。两侧都要查，缺一边就仍有三连字。
        // 作废时 rng 已消耗，不改变后续随机节奏。
        // ⚠️ 这里不能用 continue —— 循环末尾的 `idx = base.indexOf(from, end)` 是推进语句，
        // continue 会跳过它导致死循环。判定一律并入下面这一个 if。
        const nextCh = base.charAt(end);
        const prevCh = base.charAt(idx - 1);
        const cascade = wouldCascade(rep);
        const clashRight = nextCh !== "" && rep.endsWith(nextCh);
        const clashLeft = prevCh !== "" && rep.startsWith(prevCh);
        // v0.9.22 类别级：口语结果动词接抽象名词宾语 = 搭配不当（见 COLLOQUIAL_RESULT_VERBS）
        const clashAbstract =
          // 窗口必须与 ABSTRACT_OBJECT_RE 的 {0,12} 同宽再加一点余量（宾语词本身也要进得来）
          COLLOQUIAL_RESULT_VERBS.has(rep) && ABSTRACT_OBJECT_RE.test(base.slice(end, end + 14));
        // v0.9.24 类别级：替身**末字或倒数第二字**是助词，且右邻也是助词 = 助词连用。
        //
        // 「抱着」+「了」→「抱着了」；「就出现了」+「地」→「就出现了地」。
        //
        // 为什么 clashRight 拦不住：它查**单字碰撞**，「着」≠「了」⇒ 放行。
        // 与「不光仅」同型——各部分都没问题，合起来才成病（**第三类盲区**）。
        //
        // 全表实测 48 处，分三轮收敛：
        //   v1 只判「着尾+了」     → 48 → 41（漏 着+地/得/着）
        //   v2 「着尾+任一助词」   → 48 → 27（漏 了尾的动补短语）
        //   v3 +「了尾+地得着」    → 48 → 15（漏 源词自身残留助词的）
        //
        // ⚠️ 只看倒数第二字（不是全串扫助词）：替身中间带助词但句尾干净的
        //   情况很少见，全串扫会误伤「得到了成果」这类正常搭配。
        //
        // 注：源词自身以助词结尾的那 15 处（发挥着/取得了/展现出了…）
        // 由 `guardBlocks` 里的**类别规则**拦——只有那里能覆盖前缀链。
        const clashParticle =
          "了地得着".includes(nextCh) &&
          ("了地得着".includes(rep[rep.length - 1]) || "了地得着".includes(rep[rep.length - 2]));
        // v0.9.31：方向修饰语 + 行为动词 = 搭配不当（见 DIR_MODIFIER_VERB_CLASH_RE 注释）。
        // 只测 `替身 + 右邻 2 字`：够判定"正向"后面接的是不是行为动词。
        const clashDirVerb = DIR_MODIFIER_VERB_CLASH_RE.test(rep + base.slice(end, end + 2));
        // v0.9.46 正式语体守卫：口语替身在替换阶段就否掉（详见 FORMAL_FORBIDDEN_SUBSTITUTES）。
        // ⚠️ v0.9.49 起这条是**兜底**：正式体的候选池已在 pick 前预滤（见上方 formalPool），
        //    正常路径走不到这里；留着是防将来有人改预滤条件时静默失效。
        const clashFormalSub = formalSubstituteBlocked && FORMAL_FORBIDDEN_SUBSTITUTES.has(rep);
        // v0.9.49 词条级正式语体守卫：整池口语的词条（数据见 humanize-vocab.ts 的
        // INFORMAL_ONLY_KEYS）在正式体裁下不发起替换——治本替代身级逐条打补丁。
        // 位置刻意放在 pick **之后**：pick 消耗的 rng 必须照常发生，否则正式体裁下的
        // 随机序列与 v0.9.48 不同，全仓 seed 敏感断言整体漂移（与 clashFormalSub 同哲学）。
        const clashInformalEntry = formalSubstituteBlocked && INFORMAL_ONLY_KEYS.has(from);
        if (
          rep &&
          !cascade &&
          !clashRight &&
          !clashLeft &&
          !clashAbstract &&
          !clashParticle &&
          !clashDirVerb &&
          !clashFormalSub &&
          !clashInformalEntry
        )
          hits.push({ at: idx, rep });
      }
      idx = base.indexOf(from, end);
    }
    // 同一词条内各命中互不重叠，一次线性拼接完成全部替换
    if (hits.length) {
      let out = "";
      let cursor = 0;
      for (const { at, rep } of hits) {
        out += base.slice(cursor, at) + rep;
        cursor = at + from.length;
      }
      base = out + base.slice(cursor);
    }
  }
  return base;
}

/** 处理 "随着……的发展" 套话 */
function replaceWithDevelopment(text: string, rng: () => number, intensity: number): string {
  const re = /随着[\s\S]{0,18}?(的)?发展[，,]?/g;
  const timeTail = /(?:如今|现在|眼下|后来)[，,]?$/;
  return text.replace(re, (m: string, _g: string, offset: number, str: string) => {
    // v0.9.31：这条套话的删除会**连坐后句的主语**——「随着人工智能技术的不断发展，其在…」
    // 里「其」的先行词正是"人工智能技术"，状语一删，「其」就无所指（实测 6/30 命中
    // 「现在其在各个领域的应用越来越广泛。」，scan-bugs v8.0「代词主语悬空」）。
    // 故后接代词主语时整条保留，宁可留一处套话也不造病句。
    // rng() 照常消耗一次：守卫若少抽一次，后续所有随机步骤整体错位，
    // 等于用"改不改病句"顺手改了一遍全局随机序列——那是另一类不可控。
    if (/^(?:其|它|它们|该|此|这|那)/.test(str.slice(offset + m.length))) {
      rng();
      return m;
    }
    if (timeTail.test(str.slice(0, offset))) {
      return rng() < Math.max(intensity, 0.85) ? "" : m;
    }
    return rng() >= intensity ? m : pick(rng, ["如今", "现在", "", "", "后来"]);
  });
}

/** 句首连接词替换 */
function replaceOpener(sentence: string, rng: () => number, p: number): string {
  for (const [from, tos] of Object.entries(OPENERS)) {
    if (sentence.startsWith(from)) {
      if (!"，、。：；".includes(sentence.charAt(from.length))) continue;
      if (rng() < p) return pick(rng, tos) + sentence.slice(from.length);
    }
  }
  return sentence;
}

/** 预编译：冗余动词前缀正则（热路径免循环内重复构造） */
const RELAX_REDUNDANT_RES = ["进行", "予以", "加以"].map(
  (pre) => new RegExp("(?<![正在])" + pre + "(?![了到下])([\\u4e00-\\u9fa5]{2,4})", "g"),
);

function relaxRedundantVerb(text: string, rng: () => number, p: number): string {
  for (const re of RELAX_REDUNDANT_RES) {
    text = text.replace(re, (_m, verb: string) => (rng() < p ? verb : _m));
  }
  return text;
}

/**
 * 被动软化白名单：AI 稿爱堆无施事被动（被广泛使用于 / 受到广泛关注 / 被认为是），
 * 人写稿通常把施事补出来或干脆说主动。
 *
 * 只做**固定搭配整块替换**，不做切词式泛化：非白名单的"得到提高""受到启发"一律不碰，
 * 按"被+V于X"通用捕获重排会把主语边界切错（历史版本实测切出"人工智能技在…中，术…"）。
 */
const PASSIVE_REWRITES: { re: RegExp; variants: string[] }[] = [
  {
    re: new RegExp("被广泛使用于([^\\n，。！？；]{2,20})", "g"),
    variants: ["在$1用得很广", "在$1到处都在用"],
  },
  { re: /受到广泛关注/g, variants: ["大家都很关注", "被不少人盯着看", "挺受看重"] },
  { re: /得到广泛认可/g, variants: ["大家都很认可", "口碑不错", "普遍叫好"] },
  // 必须保留系词"是"；且替身要能直接接在原主语后面——"大家普遍觉得是"会留下
  // "这大家普遍觉得是行业趋势"这种悬空话题，"公认是/大家都说是"才读得通。
  { re: /被认为是/g, variants: ["公认是", "大家都说是"] },
  // "大家管它叫"要不得：原句式是「主语 + 被称之为 + 宾」，换完变"它大家管它叫里程碑"，
  // 主语与"管它"重复。只有能直接跟在主语后的谓语性说法才安全。
  { re: /被称之为/g, variants: ["人称", "俗称"] },
];

function softenPassive(text: string, rng: () => number, p: number): string {
  for (const { re, variants } of PASSIVE_REWRITES) {
    text = text.replace(re, (...args: unknown[]) => {
      const matched = args[0] as string;
      if (rng() >= p) return matched;
      const g1 = args[1];
      return pick(rng, variants).replace(/\$1/g, typeof g1 === "string" ? g1 : "");
    });
  }
  return text;
}

/** 强化副词+动词搭配修残 */
const INTENSIFIER_ADV = ["大幅", "非常", "特别", "极为", "格外", "十分", "高度", "进一步", "不断"];
const INTENSIFIER_VERB = ["提高", "提升", "增强", "加强", "降低", "减少", "优化"];
/** 预编译：强化副词+动词搭配正则（热路径免 join 重组） */
const INTENSIFIER_RE = new RegExp(
  "(" + INTENSIFIER_ADV.join("|") + ")(" + INTENSIFIER_VERB.join("|") + ")(?!了)",
  "g",
);

function relaxIntensifierVerb(text: string, rng: () => number, p: number): string {
  const re = INTENSIFIER_RE;
  return text.replace(re, (_m, _adv: string, verb: string) => (rng() < p ? verb : _m));
}

/**
 * v0.9.33：目的/未然从句里的完成态动词**不许补「了」**。
 *
 * 实测：政务短章 30 次运行命中 16 次「以保证其在健康有序的轨道上踏实推进了。」
 * ——「以确保/为了/需要/应当」引导的从句，动作**尚未发生**，补上「了」就把它标成
 * 已完成，是时态错误（不是语感问题，是语法错误）。
 *
 * 守卫与探针（`scan-bugs` v8.0「未然从句补了」）**共用这一条正则**：
 *   守卫侧测 `从句头…动词 + 句末标点`，探针侧测整段输出——同一形态、同一条判据。
 * ⚠️ 不含「使得」：「这使得效率提升了。」是**合法**完成态，人写也这么说。
 */
export const PURPOSE_LE_RE =
  /(?:\u4ee5\u786e\u4fdd|\u4ee5\u4fdd\u8bc1|\u4e3a\u4e86|\u4ee5\u4fbf|\u65e8\u5728|\u529b\u6c42|\u4ee5\u671f|\u624d\u80fd|\u9700\u8981|\u5e94\u5f53|\u5e94\u8be5|\u5fc5\u9808|\u6709\u5f85|\u5373\u5c06|\u5c06\u8981)[^\u3002\uff01\uff1f\n]{2,40}\u4e86[\u3002\uff01\uff1f]/;

/** 预编译：补"了"口语化正则（依赖导入的 LE_VERBS） */
const LE_RE = new RegExp(
  "(?<!\u7684[\\u4e00-\\u9fa5]{0,3})(?<!\u4e86[\\u4e00-\\u9fa5]{0,3})(" +
    LE_VERBS.join("|") +
    ")([\u3002\uff01\uff1f!?])",
  "g",
);

function relaxLe(text: string, rng: () => number, p: number): string {
  const re = LE_RE;
  return text.replace(re, (m: string, verb: string, end: string, offset: number, str: string) => {
    // v0.9.33：从句头到动词之间若出现过目的/未然引导词，这一句整体不补「了」。
    // 测的形态是"补了之后"的样子（clause + verb + 了 + end）——PURPOSE_LE_RE 要的正是
    // "引导词…了。"这个完整形态，少了「了」永远匹配不上（第一版就这么漏的，一条不减）。
    const clauseStart = Math.max(
      str.lastIndexOf("\u3002", offset),
      str.lastIndexOf("\uff01", offset),
      str.lastIndexOf("\uff1f", offset),
      str.lastIndexOf("\n", offset),
      -1,
    );
    if (PURPOSE_LE_RE.test(str.slice(clauseStart + 1, offset) + verb + "\u4e86" + end)) {
      rng(); // 守卫命中也抽一次：少抽会让后续随机序列整体错位（同 replaceWithDevelopment 的做法）
      return m;
    }
    return rng() < p ? verb + "\u4e86" + end : m;
  });
}

/** 结构级去味：句/段首过渡词直接删除 */
function dropLeadingConnectives(text: string, rng: () => number, intensity: number): string {
  if (intensity <= DROP_CONNECTIVE_INTENSITY_THRESHOLD) return text;
  const re =
    /([。！？!?\n])(\s*)(然而|因此|此外|与此同时|同时|另外|而且|更重要的是|综上所述|总而言之|总的说来|总的来说)(，|、)?/g;
  return text.replace(re, (m, end: string, ws: string, _w: string, _c: string) =>
    rng() < 0.35 * (intensity - DROP_CONNECTIVE_INTENSITY_THRESHOLD) ? end + ws : m,
  );
}

/** 处理带"……"通配的套话模板 */
function replaceTemplates(text: string, rng: () => number, intensity: number): string {
  const rules: { re: RegExp; tos: string[] }[] = [
    {
      re: /以([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)为抓手/g,
      tos: ["拿$1当发力点", "靠$1发力", "用$1当突破口"],
    },
    {
      re: /在([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)的(背景|大环境)下/g,
      tos: ["借着$1的风", "在$1当口", "赶上$1这波"],
    },
    {
      re: /为([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)注入(?:了|了一)?(?:新|强劲|强大|新的)?(动能|活力|动力|血液)/g,
      // v0.9 专家修复 P6：原正则缺「了/强劲」可选组，「为经济增长注入了强劲动力」
      // 整句漏匹配（专家实测 0.9 档原样存活）
      tos: ["给$1添了把劲", "让$1更有劲", "给$1加了把火", "带动了$1"],
    },
    {
      re: /为([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)提供了(有力|坚实|重要)?(支撑|保障)/g,
      tos: ["给$1撑了腰", "为$1兜了底"],
    },
    {
      re: /成为([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)的重要组成部分/g,
      tos: ["成了$1里重要的一块", "变$1里少不了的部分"],
    },
    { re: /以([\s\S]{1,12}?)为契机/g, tos: ["借着$1的机会", "趁$1"] },
    { re: /([\s\S]{1,14}?)发挥着([\s\S]{1,8}?)作用/g, tos: ["$1很重要", "$1顶用", "$1是关键"] },
    {
      re: /为([\s\S]{1,10}?)奠定了(坚实|良好|重要)?基础/g,
      tos: ["给$1打了底", "为$1铺了路", "给$1垫了基"],
    },
    {
      re: /在([\s\S]{1,12}?)方面取得(了)?(显著|明显|良好|阶段性)?成效/g,
      tos: ["在$1上见到了真章", "在$1上干出了名堂"],
    },
    {
      re: /以([\s\S]{1,10}?)为(引领|统领|指导|核心)/g,
      tos: ["由$1带着", "拿$1当头", "以$1为主心骨"],
    },
    {
      // v0.9.22：末尾补一段可选的"看类动词"。原正则只吃到"...的角度"，后面的动词
      // （审视/观察/考量/分析）会被留在原地 → 实测「从治理与合规的角度审视」
      // → 模板产出"从治理与合规看" + 残留"审视" = **"从治理与合规看审视"**。
      // 这些动词正是"从X的角度"这个套话的谓语，套话要整块替换，不能只换半截。
      re: /(?:从|站在)([\s\S]{1,10}?)的(?:角度|视角)(?:来看|出发|讲)?(?:审视|观察|考量|分析|考察)?/g,
      tos: ["搁$1看", "站$1这边看", "从$1看"],
    },
    {
      re: /不仅([\s\S]{1,16}?)，而且([\s\S]{1,16}?)(?=[。，；;])/g,
      tos: ["$1，也$2", "$1，还$2", "不光$1，还$2"],
    },
    {
      re: /不但([\s\S]{1,16}?)，而且([\s\S]{1,16}?)(?=[。，；;])/g,
      tos: ["$1，也$2", "$1，还$2", "不光$1，还$2"],
    },
    {
      re: /一方面([\s\S]{1,16}?)，另一方面([\s\S]{1,16}?)(?=[。，；;])/g,
      tos: ["先说$1，再说$2", "一头$1，另一头$2"],
    },
    {
      re: /既要([^，。；\n]{1,16}?)，也要([^，。；\n]{1,16}?)(?=[。，；;])/g,
      tos: ["$1，也要$2", "又$1，又$2"],
    },
    {
      re: /既要([^，。；\n]{1,16}?)，又要([^，。；\n]{1,16}?)(?=[。，；;])/g,
      tos: ["$1，也要$2", "又$1，又$2"],
    },
    { re: /只要([^，。；\n]{1,16}?)，就([^，。；\n]{1,16}?)(?=[。，；;])/g, tos: ["$1，便$2"] },
    {
      re: /无论([^，。；\n]{1,16}?)，都([^，。；\n]{1,16}?)(?=[。，；;])/g,
      tos: ["不管$1，都$2", "不论$1，都$2"],
    },
    { re: /不管([^，。；\n]{1,16}?)，都([^，。；\n]{1,16}?)(?=[。，；;])/g, tos: ["不论$1，都$2"] },
    {
      re: /并非([^，。；\n]{1,16}?)，而是([^，。；\n]{1,16}?)(?=[。，；;])/g,
      tos: ["不是$1，是$2", "倒不是$1，是$2", "压根不是$1，而是$2"],
    },
    {
      re: /与其(?!说)([^，。；\n]{1,16}?)，不如([^，。；\n]{1,16}?)(?=[。，；;])/g,
      tos: ["与其$1，还不如$2"],
    },
    { re: /这说明([^，。；\n]{1,20}?)(?=[。，；;])/g, tos: ["这其实意味着$1", "说白了就是$1"] },
    {
      re: /由此(?:可见|可以看出)([^，。；\n]{1,20}?)(?=[。，；;])/g,
      tos: ["这么看$1", "照这么说$1"],
    },
    { re: /可以看出([^，。；\n]{1,20}?)(?=[。，；;])/g, tos: ["能瞅出$1", "看得出$1"] },
    { re: /通过([\s\S]{1,8}?)(可以)?看出/g, tos: ["从$1能看出", "拿$1说，能看出"] },
    {
      re: /关于([\s\S]{1,12}?)的(论述|分析|研究|探讨|思考|认识)(表明|指出|发现|显示)?[，,]?/g,
      tos: ["$1这块，", "聊到$1，", "$1这事儿，"],
    },
    { re: /充分发(挥了|挥)/g, tos: ["用足了", "用足"] },
  ];
  let result = text;
  for (const { re, tos } of rules) {
    result = result.replace(re, (...args) => {
      if (rng() >= intensity) return args[0] as string;
      const groups = args.slice(1, args.length - 2);
      let out = pick(rng, tos);
      for (let i = 0; i < groups.length; i++) {
        out = out.split("$" + (i + 1)).join(groups[i] ?? "");
      }
      return out;
    });
  }
  return result;
}

/* --------------------- 流水线可观测：trace 发射器 --------------------- */

/**
 * 计时源：浏览器与 Node 都有 performance；被裁掉的环境退回 Date.now。
 * 只在 opts.onStage 存在时才调用 —— 不传回调时这些代码路径根本不会执行。
 */
const nowMs = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/** 快照截断长度：够看清这一步动了哪里，又不至于把整篇原文塞进 trace */
const TRACE_SNIPPET_LEN = 120;

/** 发射一条阶段记录（onStage 未传时整体跳过，零开销） */
function emitStage(
  on: ((s: StageTrace) => void) | undefined,
  st: Omit<StageTrace, "ms" | "charsAfter" | "snippet">,
  t0: number,
  after: string,
): void {
  if (!on) return;
  on({
    ...st,
    ms: Math.round((nowMs() - t0) * 1000) / 1000,
    charsAfter: after.length,
    snippet: after.slice(0, TRACE_SNIPPET_LEN),
  });
}

/**
 * 词表命中计数：统计文本里出现的所有 VOCAB 词表词的总次数。
 * 只在开 trace 时调用（全表扫描有成本），用来给出「本步替换了几处」的真实数字。
 */
function countVocabTokens(text: string): number {
  let n = 0;
  for (const k of VOCAB_KEY_SET) {
    let i = text.indexOf(k);
    while (i !== -1) {
      n++;
      i = text.indexOf(k, i + k.length);
    }
  }
  return n;
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
    result = humanizeSingle(text, { ...opts, intensity, genre: effectiveGenre });
  } else {
    const baseSeed = opts.seed;
    result = paragraphs
      .map((p, i) =>
        humanizeSingle(p, {
          ...opts,
          intensity,
          genre: effectiveGenre,
          para: i,
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
          .map((p) => boostBurstinessByCutting(p, 0.55, 8))
          .join("\n\n")
      : boostBurstinessByCutting(result, 0.55, 8);
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
  const tClamp0 = nowMs();
  result = clampAvgSentenceLenUnder25(result, knobs.avgLenTarget, 8);
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
          .map((p) => boostBurstinessByCutting(p, knobs.burstTarget, 8))
          .join("\n\n")
      : boostBurstinessByCutting(result, knobs.burstTarget, 8);
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
            .map((p) => boostBurstinessByCutting(p, 0.55, 8))
            .join("\n\n")
        : boostBurstinessByCutting(result, 0.55, 8);
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
      r = relaxColon(r, rng, 0.4 * intensity);
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

    s = replaceOpener(s, rng, intensity);

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
    if (s.length > SPLIT_SENTENCE_THRESHOLD && rng() < SPLIT_SENTENCE_RATE * intensity) {
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
  if (intensity > 0.4) {
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
