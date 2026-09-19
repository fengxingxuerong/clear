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
  OPENERS,
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

import { countPadHeads, PAD_INJECT_CAP } from "./humanize-primitives.ts";

import {
  aiScore,
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
} from "./humanize-metrics.ts";

// v0.9 反「新指纹」层：模板复读封顶 / 语体门控 / 残句守卫 / 场景块保护
import {
  capLongTemplateRepetition,
  guardFormalRegister,
  collapseDoubleConnectives,
  fixOrphanConnectiveLeads,
  isSceneMetaSentence,
} from "./anti-fingerprint.ts";

// P7 引擎级体裁联动：自动体裁识别 + 每体裁参数旋钮
import { classifyGenre, AutoGenre } from "./classify-genre.ts";
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
 * 起因（scripts/_stability.ts 全档位扫描）：
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
 *  · skipSceneInject：只有对话体需要（剧本【场景/人物/背景】块不塞自问自答，避免违和）。
 */
type EffectiveGenre = AutoGenre | "humanHand";

interface GenreKnobs {
  avgLenTarget: number;
  burstTarget: number;
  intensityCap: number; // 硬上限：> 这个值会被 clamp
  disableZhuque: boolean; // 强制关闭朱雀增强
  expoForceP3: (intensity: number) => boolean;
  skipSceneInject: boolean; // 剧本场景块跳过自问自答
  disableTyposAnchor: boolean; // 关闭错别字/第一人称锚点注入（humanHand专用）
  skipSelfQA: boolean; // v0.9.1：叙事文跳过自问自答/碎片注入（"例子呢？"不属于叙事）
}

function getGenreKnobs(genre: EffectiveGenre): GenreKnobs {
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
): string {
  const p = intensity <= 0 ? 0 : Math.min(1, REPLACE_VOCAB_BASE + REPLACE_VOCAB_SLOPE * intensity);
  const academic = style === "academic";
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
        !guardBlocks(from, base.slice(end, end + 8), base.slice(Math.max(0, idx - 6), idx))
      ) {
        const rep = pick(rng, candidates);
        // v0.8.9 叠字守卫：替换词尾字与右侧首字相同时将产生叠字——
        // 「彰显着」→「透着着」、「不仅是」→「不只是是」，属一眼可辨的机器破坏。
        // 该次替换作废但仍保留 rng 消耗，不改变后续随机节奏。
        const nextCh = base.charAt(end);
        if (!rep || !nextCh || !rep.endsWith(nextCh)) hits.push({ at: idx, rep });
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

/** 预编译：补"了"口语化正则（依赖导入的 LE_VERBS） */
const LE_RE = new RegExp(
  "(?<!的[\\u4e00-\\u9fa5]{0,3})(?<!了[\\u4e00-\\u9fa5]{0,3})(" +
    LE_VERBS.join("|") +
    ")([。！？!?])",
  "g",
);

function relaxLe(text: string, rng: () => number, p: number): string {
  const re = LE_RE;
  return text.replace(re, (m, verb: string, end: string) => (rng() < p ? verb + "了" + end : m));
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
      re: /(?:从|站在)([\s\S]{1,10}?)的(?:角度|视角)(?:来看|出发|讲)?/g,
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

/* ----------------------------- 主流程 ----------------------------- */

/** 入口：按段落拆分逐段处理、保留原文分段 */
export function humanize(text: string, opts: HumanizeOptions = {}): string {
  if (!text || !text.trim()) return "";
  // v0.9.4 P1 边界守卫：超短文本透传。实测「短。」（3 字符）经整条管线后被清成
  // 空串（替换/删除类 pass 在孤词上无东西可保，最终输出丢失原文）——数据丢失级
  // 边界 bug。10 字以内没有"去味"的空间与必要，原样返回最安全。
  if (text.replace(/\s+/g, "").length < 10) return text;
  // v0.8.6：强度=0 必须严格返回原文。之前所有 pass 都按概率 0 跳过，
  // 但最后几道确定性兜底（stripAICliches / stripLeadingConnectivesHard /
  // clampAvgSentenceLenUnder25 / replaceGuardedFormulaicDerivs 等）不关心强度，
  // 会删掉"值得注意的是/然而/因此"这类连接词、切长句、替换"有效性→实际效果"，
  // 导致用户选 0 时原文仍被改写。在入口直接短路，语义最直观。
  const rawIntensity = opts.intensity ?? 0.6;
  if (rawIntensity <= 0) return text;
  // P7-A：体裁判定——显式 opts.genre 优先，否则自动识别（纯人写不自动判，必须用户显式传 humanHand）
  const effectiveGenre: EffectiveGenre = opts.genre ?? classifyGenre(text).genre;
  const knobs = getGenreKnobs(effectiveGenre);
  // P7-D：humanHand 强约束——强度硬钳制到 ≤0.48（该体裁斜率为负，越去味官分越高）
  const intensity = Math.min(Math.max(0, Math.min(1, opts.intensity ?? 0.6)), knobs.intensityCap);
  // P7-D：humanHand 强制关闭朱雀增强
  const zhuqueOn = (opts.zhuqueMode ?? false) && !knobs.disableZhuque;
  const paragraphs = text.split(/\n+/).filter((p) => p.trim());
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
          seed: baseSeed === undefined ? undefined : (baseSeed + i * 2654435761) >>> 0,
        }),
      )
      .join("\n\n");
  }

  // 朱雀增强模式（全文本级）——P7-D humanHand 强制关闭；P7-E 对话体场景块跳过自问自答
  // v0.9.1：narrative/humanHand 跳过自问自答+碎片注入（"例子呢？"不属于叙事/人写原稿）
  // v0.9.4 P2：垫词饱和守卫——输入已被垫词塞满（多轮处理/高度口语）时不再注入
  if (zhuqueOn && intensity >= 0.35 && countPadHeads(text) < PAD_INJECT_CAP) {
    // v0.9.8 P0 收敛（七）：兜底风格 casual → plain（与 DEFAULT_API.style 对齐）。
    result = applyZhuqueFeatures(result, intensity, opts.seed, opts.style ?? "plain", {
      skipSceneInject: knobs.skipSceneInject,
      skipSelfQA: knobs.skipSelfQA,
    });
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
  const structuralAllowedGenre =
    effectiveGenre !== "narrative" && effectiveGenre !== "humanHand";
  if (intensity >= 0.55 && structuralAllowedGenre) {
    const structRng = makeRng(opts.seed, 5555);
    // P7-B：论说文 + 强度≥0.75 → 强制开启 P3 结构增强（覆盖 expoScore 略低于 0.55 的边缘论说文）
    // P7-E：对话体 → 剧本【场景/人物/背景】块跳过自问自答注入
    const structOpts = {
      zhuqueMode: zhuqueOn,
      expoForceP3: knobs.expoForceP3(intensity),
      skipSceneInject: knobs.skipSceneInject,
      skipSelfQA: knobs.skipSelfQA, // v0.9.1：narrative/humanHand 跳过结构层自问自答
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

  // 全文级垫词去重
  result = dedupePadWords(result);

  // 全文级句长节奏兜底
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

  // v3 P4+P5 最终清尾（必须放在所有结构/自问自答生成之后）——
  // P4-C：VOCAB GUARD 保护的"针对→性/系统→性/有效→性"等合法套话衍生，保语义整体替换为口语
  result = replaceGuardedFormulaicDerivs(result);
  // v0.9 反「新指纹」层：引擎注入特征不得变成新指纹
  //  A) 长模板跨段复读封顶（自问自答/插话模板全文每种限 1 次，仅在注入强度 ≥0.65 时启用）
  if (intensity >= 0.65) {
    result = capLongTemplateRepetition(result);
  }
  //  B) 语体门控：论说/学术（formal）下还原过度口语替换；双连接词叠放不限语体
  const formalRegister = effectiveGenre === "main" || (opts.style ?? "plain") === "academic";
  result = guardFormalRegister(result, formalRegister);
  result = collapseDoubleConnectives(result);
  //  C) v0.9.5 P4 双语气词折叠：多个注入 pass 叠加时句尾出现"呀呀""嘛嗯""呢呵"
  //  式堆叠（Phase1 迭代实测），真人不会连发两个语气词。相邻重复折叠为一个，
  //  相邻异形双语气词保留第一个；"好吧/行吧/哦对"等合法组合不受影响
  //  （第二个字符非语气词时不匹配）。
  result = result
    .replace(/([哦呵啧呣诶呀嘛呢吧啊嗯])\1+/g, "$1")
    .replace(
      /([哦呵啧呣诶呀嘛呢吧啊嗯])[哦呵啧呣诶呀嘛呢吧啊嗯]+(?=[。，！？；、\n]|$)/g,
      "$1",
    );
  //  C) 残句开头守卫：句首独词连接词（并/而/且/但/亦/另）修复
  if (intensity >= 0.55) {
    result = fixOrphanConnectiveLeads(result);
  }
  // P7-C + P5-A：按体裁压 avgLen（论说23 / 叙事28 / 对话32 / 人写36 不触发硬切）
  // v0.9 专家修复 P2 连带：切点守卫收紧后长句切分机会变少，maxCuts 5→8 补偿——
  // 只放宽「尝试次数」，每刀仍逐点过守卫，不会切出残句
  result = clampAvgSentenceLenUnder25(result, knobs.avgLenTarget, 8);
  // P7-C + P4-B（P5 增强版）：按体裁拉 burstiness CV（论说0.63 / 叙事0.59 / 对话0.57 / 人写0.50）
  //       （原全局固定 0.61 → 现按体裁分档，论说最严、人写最松，避免负斜率体裁被过度注入锚点）
  // P4-A：最终保险整篇破折号/省略号硬上限，解决指纹自检"破折号超标×2/×3"红项
  result = ensureEmDashCountHardCap(result, 1);
  result = limitPunctuation(result, "……", 1, "。");
  result = limitPunctuation(result, "——", 1, "，");
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
    if (aiScore(result).burstiness < FP_LINE) {
      result = result.includes("\n\n")
        ? result
            .split(/\n\n+/)
            .map((p) => boostBurstinessByCutting(p, 0.55, 8))
            .join("\n\n")
        : boostBurstinessByCutting(result, 0.55, 8);
    }
  }
  // 行首残留标点清理（结构重排/模板删除可留下「，一句话概括」式残逗号）
  result = result
    .replace(/(^|\n)\s*[，、；：]+/g, "$1")
    .replace(/([。！？])\s*([，、；：]+)/g, "$1");

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
  // 缺陷（scripts/_stability.ts 全档位扫描）：
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
  // 补丁起因（scripts/_n60.ts / _narr_ab.ts，叙事 seed=2 恒定 31 分）：
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
    result = result
      .split(/\n\n+/)
      .map((p) => {
        if (skipFlag || p.split(/\n/).some((ln) => SCENE_BLOCK_LINE_RE.test(ln))) return p;
        const sents = splitSentences(p);
        if (sents.length < 5) return p;
        return injectSelfQA(sents, qrng, intensity, style).join("");
      })
      .join("\n\n");
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

  // P8 场景块全格式保真：整段为剧本【场景/人物/背景…】块头行 → 原样返回。
  // 块头是元数据不是行文：relaxColon 会改成【场景，…】、replaceVocab/templates 也会污染。
  if (isSceneBlockLine(text)) return text;

  // 1) 全局词汇替换 + 套话
  let working = dropLeadingConnectives(text, rng, intensity);
  working = relaxRedundantVerb(working, rng, 0.85 * intensity);
  working = relaxIntensifierVerb(working, rng, 0.85 * intensity);
  working = relaxLe(working, rng, 0.6 * intensity); // 补"了"概率从 0.4 提到 0.6，人味更强
  // 必须排在 replaceVocab 之前：否则"受到广泛关注"的"关注"先被换成"留意"，
  // 这里再也匹配不到，实测会留下"受到广泛留意"这种搭配病句。
  working = softenPassive(working, rng, Math.min(1, 0.85 * intensity));
  working = replaceTemplates(working, rng, intensity);
  working = replaceVocab(working, rng, intensity, style);
  working = replaceWithDevelopment(working, rng, intensity);
  working = reframeConcessives(working, rng, Math.min(1, 0.5 + 0.5 * intensity));
  working = relaxEmDash(working, rng, 0.6 * intensity);
  working = relaxDunhao(working, rng, 0.5 * intensity);
  working = relaxColon(working, rng, 0.4 * intensity);
  working = relaxQuotes(working, rng, 0.3 * intensity);
  working = splitOnConnectors(working, rng, 0.3 * intensity);

  // 2) 切句，逐句处理
  const sentences = splitSentences(working);
  const out: string[] = [];
  const usedInterjections = new Set<string>();
  let lastWasInterjection = false;
  // v0.9.8 P0 收敛：humanHand / narrative 体裁禁句首垫词（语体错位）。
  // narrative 的文风是「把事讲清楚」，humanHand 的原稿本来就是人写的——
  // 两者塞「说真的，」都是机器味而非人味。显式 genre 与自动识别都覆盖。
  const padForbiddenGenre =
    opts.genre === "humanHand" || opts.genre === "narrative";

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
    const padBudgetLeft = countPadHeads(out.join("")) < PAD_INJECT_CAP;
    const padInjectAllowed =
      !isAcademic && isCasual && !padForbiddenGenre && padBudgetLeft;
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
    const mergeForbiddenGenre =
      opts.genre === "narrative" || opts.genre === "humanHand";
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
      // 证据（scripts/_narr9.ts，叙事种子 9）：即使句尾软化走了斜坡，
      //   0.80/1.00 档仍恒定产出 29 分（句式 28），污染源就是句尾「哈。」「呢。」——
      //   「…停不了哈。」「…叶子贴了一地呢。」这类聊天腔落在叙事文上是语体错位。
      //   avg 只有 2.1 却 max 29，一个坏种子的体验远重于均值。
      //
      // 为什么此前保留单字尾：注释（见下）说「A/B 显示不贡献污染分」，
      //   但那是在 humanizeSingle 单层测的；全文级（含朱雀层）复测推翻了该结论。
      //   对 casual 的论说/对话体裁仍保留——那里「嘛」「吧」是有效的人味信号。
      const tailForbiddenGenre =
        opts.genre === "humanHand" || opts.genre === "narrative";
      if (!formalityGuard && !tailForbiddenGenre) {
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

  // 3) 重新拼接 + 清理
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

  // 4) 确定性套话兜底
  result = stripAICliches(result);
  result = stripLeadingConnectivesHard(result);
  result = dedupePadWords(result);

  // 半角逗号微混入
  result = injectHalfWidth(result, rng, 0.04 * intensity);

  // 5) 句长节奏兜底
  if (intensity > 0.4) {
    const rng2 = makeRng(opts.seed, 3333);
    result = boostBurstinessSingle(result, rng2, 0.5 * intensity);
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
        const hasOpinion = /^(我觉得|我认为|在我看来|以我的经验|我个人的看法|我寻思着|要我说)/.test(s);
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

/** 一键：去味 + 前后评分，方便 UI 直接调用 */
export function humanizeWithScore(
  text: string,
  opts: HumanizeOptions = {},
): { text: string; before: ScoreBreakdown; after: ScoreBreakdown } {
  const before = aiScore(text);
  const result = humanize(text, opts);
  const after = aiScore(result);
  return { text: result, before, after };
}
