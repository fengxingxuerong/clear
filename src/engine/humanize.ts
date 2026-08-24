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
} from "./humanize-shuffle.ts";

import {
  aiScore,
  ScoreBreakdown,
  fingerprintCheck,
  FingerprintReport,
  FingerprintIssue,
  checkFidelityLocal,
  FidelityReport,
} from "./humanize-metrics.ts";

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

/* ----------------------------- 替换规则 ----------------------------- */

/** 启动时预计算剔除自替身后的候选列表，避免每次调用重复 filter 全表 */
const REPLACE_VOCAB_CANDIDATES: [string, string[]][] = VOCAB_ENTRIES.map(([from, tos]) => {
  const realTos = tos.filter((t) => t !== from);
  return [from, realTos.length ? realTos : tos];
});

/** 替换文本里命中 VOCAB 的词（单趟收集命中、每词条一次线性拼接，避免逐命中整串重建） */
function replaceVocab(text: string, rng: () => number, intensity: number): string {
  const p = intensity <= 0 ? 0 : Math.min(1, REPLACE_VOCAB_BASE + REPLACE_VOCAB_SLOPE * intensity);
  let base = text;
  for (const [from, candidates] of REPLACE_VOCAB_CANDIDATES) {
    let idx = base.indexOf(from);
    if (idx === -1) continue;
    const hits: { at: number; rep: string }[] = [];
    while (idx !== -1) {
      const end = idx + from.length;
      // 与原实现一致：每个命中位置无条件消耗一次 rng
      if (
        rng() < p &&
        !guardBlocks(
          from,
          base.slice(end, end + 8),
          base.slice(Math.max(0, idx - 3), idx),
        )
      ) {
        hits.push({ at: idx, rep: pick(rng, candidates) });
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
    { re: /以([\s\S]{1,12}?)为抓手/g, tos: ["拿$1当发力点", "靠$1发力", "用$1当突破口"] },
    { re: /在([\s\S]{1,12}?)的(背景|大环境)下/g, tos: ["借着$1的风", "在$1当口", "赶上$1这波"] },
    {
      re: /为([\s\S]{1,12}?)注入(新)?(动能|活力|动力)/g,
      tos: ["给$1添了把劲", "让$1更有劲", "给$1加了把火"],
    },
    {
      re: /为([\s\S]{1,12}?)提供了(有力|坚实|重要)?(支撑|保障)/g,
      tos: ["给$1撑了腰", "为$1兜了底"],
    },
    { re: /成为([\s\S]{1,12}?)的重要组成部分/g, tos: ["成了$1里重要的一块", "变$1里少不了的部分"] },
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
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 0.6));
  const paragraphs = text.split(/\n+/).filter((p) => p.trim());
  let result: string;
  if (paragraphs.length <= 1) {
    result = humanizeSingle(text, opts);
  } else {
    const baseSeed = opts.seed;
    result = paragraphs
      .map((p, i) =>
        humanizeSingle(p, {
          ...opts,
          seed: baseSeed === undefined ? undefined : (baseSeed + i * 2654435761) >>> 0,
        }),
      )
      .join("\n\n");
  }

  // 朱雀增强模式（全文本级）
  if (opts.zhuqueMode && intensity >= 0.35) {
    result = applyZhuqueFeatures(result, intensity, opts.seed, opts.style ?? "casual");
  }

  // 全文级垫词去重
  result = dedupePadWords(result);

  // 全文级句长节奏兜底
  if (intensity > 0.4) {
    const rng3 = makeRng(opts.seed, 4444);
    result = boostBurstiness(result, rng3, 0.6 * intensity, opts.style ?? "casual");
  }

  return result;
}

/** 朱雀增强：仅叠加反检测特征，不跑本地引擎 */
export function applyZhuqueFeatures(
  text: string,
  intensity: number,
  seed?: number,
  style: RewriteStyle = "casual",
): string {
  if (!text || intensity < 0.35) return text;
  const zrng = makeRng(seed, 7777);
  let result = text;

  const isCasual = style === "casual";
  if (isCasual) {
    result = injectDialect(result, zrng, 0.2 * intensity);
  }
  if (style !== "academic") {
    result = injectParentheticals(result, zrng, 0.15 * intensity);
    result = injectOpinion(result, zrng, 0.12 * intensity);
  }
  if (isCasual) {
    result = injectParentheticNotes(result, zrng, 0.08 * intensity);
    result = injectFragments(result, zrng, 0.06 * intensity);
  }
  result = dedupePadWords(result);
  result = limitPunctuation(result, "——", 1, "，");
  return result;
}

function humanizeSingle(text: string, opts: HumanizeOptions = {}): string {
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 0.6));
  const rng = makeRng(opts.seed);
  const style = opts.style ?? "casual";
  const isAcademic = style === "academic";
  const isCasual = style === "casual";

  if (!text || !text.trim()) return "";

  // 1) 全局词汇替换 + 套话
  let working = dropLeadingConnectives(text, rng, intensity);
  working = relaxRedundantVerb(working, rng, 0.85 * intensity);
  working = relaxIntensifierVerb(working, rng, 0.85 * intensity);
  working = relaxLe(working, rng, 0.6 * intensity); // 补"了"概率从 0.4 提到 0.6，人味更强
  working = replaceTemplates(working, rng, intensity);
  working = replaceVocab(working, rng, intensity);
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
        out.push(s.slice(0, mid).trim() + "。");
        out.push(s.slice(mid + 1).trim());
        continue;
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
      const r = rng();
      if (r < SOFT_ENDING_PROB * intensity && isCasual) {
        s = s.replace(/[。！？!?]+$/, "") + pick(rng, SOFT_TAIL_VARIANTS);
      } else if (r < SOFT_ENDING_PROB * intensity + SOFT_TAIL_PROB * intensity) {
        s = s.replace(/[。！？!?]+$/, "") + pick(rng, SOFT_ENDINGS) + "。";
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
  let base = text;
  for (const [from, candidates] of DIALECT_CANDIDATES) {
    const idx = base.indexOf(from);
    if (idx === -1) continue;
    // 只处理首个命中：先无条件消耗一次概率位再判定（与原实现的 rng 序列一致）
    if (rng() < p) {
      const rep = pick(rng, candidates);
      base = base.slice(0, idx) + rep + base.slice(idx + from.length);
    }
  }
  return base;
}

function injectParentheticals(text: string, rng: () => number, p: number): string {
  const sentences = splitSentences(text);
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
}

function injectFragments(text: string, rng: () => number, p: number): string {
  const paras = text.split(/\n\n+/);
  if (paras.length < 2) return text;
  const out: string[] = [];
  for (const para of paras) {
    let ptext = para.trim();
    if (!ptext) continue;
    if (rng() < p) {
      const frag = pick(rng, SENTENCE_FRAGMENTS);
      ptext += "\n\n" + frag;
    }
    out.push(ptext);
  }
  return out.join("\n\n");
}

function injectOpinion(text: string, rng: () => number, p: number): string {
  const sentences = splitSentences(text);
  const out: string[] = [];
  let lastOpinion = false;
  const used = new Set<string>();
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
}

function injectParentheticNotes(text: string, rng: () => number, p: number): string {
  const sentences = splitSentences(text);
  const out: string[] = [];
  for (const s of sentences) {
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
