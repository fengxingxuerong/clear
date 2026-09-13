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
  SOFT_TAIL_VARIANTS,
  FORMULAIC,
  guardBlocks,
  isSceneBlockLine,
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
  boostBurstiness,
  reframeConcessives,
  crossChunkCleanup,
  mechanicalShuffle,
  resegmentParagraphsAggressive,
  injectSelfQA,
  injectHumanTypos,
  structuralShuffleParagraph,
  // v3 P4+P5 最终清尾（humanize() return 前最后一步调用）
  ensureEmDashCountHardCap,
  boostBurstinessIfLow,
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
        !guardBlocks(from, base.slice(end, end + 8), base.slice(Math.max(0, idx - 3), idx))
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
    result = humanizeSingle(text, { ...opts, intensity });
  } else {
    const baseSeed = opts.seed;
    result = paragraphs
      .map((p, i) =>
        humanizeSingle(p, {
          ...opts,
          intensity,
          seed: baseSeed === undefined ? undefined : (baseSeed + i * 2654435761) >>> 0,
        }),
      )
      .join("\n\n");
  }

  // 朱雀增强模式（全文本级）——P7-D humanHand 强制关闭；P7-E 对话体场景块跳过自问自答
  // v0.9.1：narrative/humanHand 跳过自问自答+碎片注入（"例子呢？"不属于叙事/人写原稿）
  // v0.9.4 P2：垫词饱和守卫——输入已被垫词塞满（多轮处理/高度口语）时不再注入
  if (zhuqueOn && intensity >= 0.35 && countPadHeads(text) < PAD_INJECT_CAP) {
    result = applyZhuqueFeatures(result, intensity, opts.seed, opts.style ?? "casual", {
      skipSceneInject: knobs.skipSceneInject,
      skipSelfQA: knobs.skipSelfQA,
    });
  }

  // v0.8 结构级：本地引擎跑完后做二次扫荡（强度 >= 0.55），对段落骨架再动刀
  if (intensity >= 0.55) {
    const structRng = makeRng(opts.seed, 5555);
    // P7-B：论说文 + 强度≥0.75 → 强制开启 P3 结构增强（覆盖 expoScore 略低于 0.55 的边缘论说文）
    // P7-E：对话体 → 剧本【场景/人物/背景】块跳过自问自答注入
    const structOpts = {
      zhuqueMode: zhuqueOn,
      expoForceP3: knobs.expoForceP3(intensity),
      skipSceneInject: knobs.skipSceneInject,
      skipSelfQA: knobs.skipSelfQA, // v0.9.1：narrative/humanHand 跳过结构层自问自答
      // v0.9 专家修复 P5：文风透传到结构层（academic 禁口语承接头/自问自答）
      style: opts.style ?? "casual",
    };
    result = result
      .split(/\n\n+/)
      .map((p) => structuralShuffleParagraph(p, structRng, intensity, structOpts))
      .join("\n\n");
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
    // v0.9.4 P2：垫词饱和时改走「纯切句」兜底（零注入），只拉节奏不再加料
    result =
      countPadHeads(result) >= PAD_INJECT_CAP
        ? boostBurstinessByCutting(result, 0.55, 8)
        : boostBurstiness(result, rng3, 0.6 * intensity, opts.style ?? "casual");
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
  const formalRegister = effectiveGenre === "main" || (opts.style ?? "casual") === "academic";
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
    const p4Rng = makeRng(opts.seed, 9401);

    // v0.9 专家修复 P5：style 透传——academic 禁极短语气锚
    result = boostBurstinessIfLow(result, p4Rng, knobs.burstTarget, 8, opts.style ?? "casual");
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

  const isCasual = style === "casual";
  const skipSelfQA = opts.skipSelfQA ?? false;
  if (isCasual) {
    result = injectDialect(result, zrng, 0.2 * intensity);
  }
  if (style !== "academic") {
    result = injectParentheticals(result, zrng, 0.15 * intensity);
    result = injectOpinion(result, zrng, 0.12 * intensity);
  }
  if (isCasual && !skipSelfQA) {
    result = injectParentheticNotes(result, zrng, 0.08 * intensity);
    result = injectFragments(result, zrng, 0.06 * intensity);
  }
  result = dedupePadWords(result);
  result = limitPunctuation(result, "——", 1, "，");
  // v0.8：自问自答（增强句式跳脱，AI 极少写自问自答，人类日常到处是）
  // P7-E：对话体剧本【场景/人物/背景】块跳过注入，避免台词区被塞"问：…答：…"违和
  // v0.9.1：narrative/humanHand 跳过全部自问自答（"例子呢？"不属于叙事/人写原稿）
  if (isCasual && intensity >= 0.7 && !skipSelfQA) {
    const qrng = makeRng(seed, 8888);
    // P7-E：体裁级开关（对话体）→ 全文跳过；未开开关时逐段保护——
    // 含剧本【场景/人物/背景】行的段落原样保留，其余段落照常注入
    const skipFlag = opts.skipSceneInject ?? false;
    // v0.9 专家修复 P5：academic 文风禁自问自答（style !== "academic" 已在
    // 外层 if 拦截方言/插话，但本块 isCasual 为 false 时 academic 仍会进来——
    // 明确跳过）。plain 走克制型池。
    if (style === "casual") {
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
  }
  return result;
}

function humanizeSingle(text: string, opts: HumanizeOptions = {}): string {
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 0.6));
  const rng = makeRng(opts.seed);
  const style = opts.style ?? "casual";
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

  for (let i = 0; i < sentences.length; i++) {
    let s = sentences[i];

    // v0.9-D 场景块行保护：剧本【场景/人物/背景…】块头行原样保留，
    // 跳过语气词/句尾软化/拆句/合并等全部注入（此前"啧。嗯。呣。"会污染块头）
    if (isSceneMetaSentence(s)) {
      out.push(s);
      continue;
    }

    s = replaceOpener(s, rng, intensity);

    if (
      !isAcademic &&
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

    // 过短句偶尔与前句合并
    if (
      out.length > 0 &&
      s.length < MERGE_SENTENCE_THRESHOLD &&
      out[out.length - 1].length < MERGE_SENTENCE_PREV_MAX &&
      rng() < MERGE_SENTENCE_RATE * intensity
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
      if (!formalityGuard) {
        if (r < SOFT_ENDING_PROB * intensity && isCasual) {
          s = s.replace(/[。！？!?]+$/, "") + pick(rng, SOFT_TAIL_VARIANTS);
        } else if (r < SOFT_ENDING_PROB * intensity + SOFT_TAIL_PROB * intensity) {
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

  return result;
}

/* ======================== 朱雀增强：深度反检测特征 ======================== */

/** 启动时预计算剔除自替身后的候选列表（与 replaceVocab 一致） */
const DIALECT_CANDIDATES: [string, string[]][] = DIALECT_ENTRIES.map(([from, tos]) => {
  const realTos = tos.filter((t) => t !== from);
  return [from, realTos.length ? realTos : tos];
});

function injectDialect(text: string, rng: () => number, p: number): string {
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
  const sentences = splitSentences(text);
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    let s = sentences[i];
    if (isSceneBlockLine(s) || s.length < 15 || rng() >= p) {
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
  const sentences = splitSentences(text);
  const out: string[] = [];
  let lastOpinion = false;
  const used = new Set<string>();
  for (let i = 0; i < sentences.length; i++) {
    let s = sentences[i];
    const hasOpinion = /^(我觉得|我认为|在我看来|以我的经验|我个人的看法|我寻思着|要我说)/.test(s);
    const hasInterjection = /^(说真的|说实话|老实讲|讲真|说白了|你别说|不瞒你说)/.test(s);
    if (isSceneBlockLine(s)) {
      out.push(s);
      continue;
    }
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
