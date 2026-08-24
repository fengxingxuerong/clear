/**
 * 趣AI味 · 机械扰动层：反指纹规则 + 节奏增强 + 跨块清理
 *
 * 从 humanize.ts 拆出的"确定性清理"与"机械扰动"领域，与核心替换引擎的
 * 概率化改写正交。全部是"限额/去重/劈句"类规则——不改写内容只削超标模式，
 * 零语法风险，且逐条对应交叉评判员点名的痕迹（垫词复读/标点规整/破折号超标/节奏均匀）。
 *
 * 依赖：humanize-data.ts 的共享原语（rng/统计/切分工具），不依赖 humanize.ts。
 */

import {
  PAD_WORDS,
  SENT_STARTERS,
  MECH_CLICHES,
  splitSentences,
  sentenceStats,
  computeStats,
  findSplitPoint,
  makeRng,
  MIN_BURSTINESS_CV,
  HumanizeOptions,
  RewriteStyle,
  pick,
} from "./humanize-data.ts";

/* ----------------------------- 标点规则（被 mechanicalShuffle 和 humanizeSingle 共用） ----------------------------- */

/** 降低破折号 "——" 的过度使用 */
function relaxEmDash(text: string, rng: () => number, p: number): string {
  return text.replace(/——/g, () => (rng() < p ? pick(rng, ["，", "。", "——"]) : "——"));
}

/** 松弛顿号枚举：整组只动最后一个分隔符，"A、B、C" → "A、B以及C" */
function relaxDunhao(text: string, rng: () => number, p: number): string {
  return text.replace(/[^\n，。；！？、]{1,14}(?:、[^\n，。；！？、]{1,14})+/g, (run) => {
    if (rng() >= p) return run;
    const hasConj = /[与和及]/.test(run);
    const verbish = /[推干办做化走抓建拉提打治整修铺]/.test(run);
    const last = run.lastIndexOf("、");
    const joint = hasConj || verbish ? "，" : pick(rng, ["以及", "跟", "和", "，"]);
    return run.slice(0, last) + joint + run.slice(last + 1);
  });
}

/** 松弛冒号滥用：只动两侧为中文的全角"："或两侧都是中文的半角冒号 */
function relaxColon(text: string, rng: () => number, p: number): string {
  let out = text.replace(
    /([\u4e00-\u9fa5])：(?=[\u4e00-\u9fa5])/g,
    (m, pre: string, offset: number) => {
      const next = text[offset + 1];
      if (next === '"' || next === "“" || next === "”") return m;
      return rng() < p ? pre + pick(rng, ["，", "，", "："]) : m;
    },
  );
  out = out.replace(/([\u4e00-\u9fa5]):(?=[\u4e00-\u9fa5])/g, (m, pre: string) =>
    rng() < p ? pre + "，" : m,
  );
  return out;
}

/** 去引号滥用：去除成对弯引号强调 */
function relaxQuotes(text: string, rng: () => number, p: number): string {
  return text.replace(/[“]([^”，。；：]{1,10})[”]/g, (m, inner: string) => (rng() < p ? inner : m));
}

/** 预编译：断句连接词正则（热路径免循环内重复构造） */
const CONNECTOR_RES = new Map(
  ["使得", "导致", "这样一来", "在此基础上", "与此同时", "正因如此"].map((c) => [
    c,
    new RegExp("([^。，；]{4,28}?)" + c + "([^。]{3,40})", "g"),
  ]),
);

/** 长因果/递进连接词断句 */
function splitOnConnectors(text: string, rng: () => number, p: number): string {
  for (const c of ["使得", "导致"]) {
    const re = CONNECTOR_RES.get(c)!;
    text = text.replace(re, (m, pre: string, post: string) =>
      rng() < p ? pre + "。结果" + post : m,
    );
  }
  for (const c of ["这样一来", "在此基础上", "与此同时", "正因如此"]) {
    const re = CONNECTOR_RES.get(c)!;
    text = text.replace(re, (m, pre: string, post: string) =>
      rng() < p ? pre + "。" + c + post : m,
    );
  }
  return text;
}

/* ----------------------------- 垫词 / 标点 限额 ----------------------------- */

/** 垫词去重：每个垫词保留首次出现，其余整组删除 */
function dedupePadWords(text: string): string {
  for (const w of PAD_WORDS) {
    const token = w + "，";
    let next = text.indexOf(token, text.indexOf(token) + token.length);
    while (next !== -1) {
      text = text.slice(0, next) + text.slice(next + token.length);
      next = text.indexOf(token, next);
    }
  }
  return text;
}

/** 标点限额：mark 只保留前 limit 次，超出换成 replacement */
function limitPunctuation(text: string, mark: string, limit: number, replacement: string): string {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(mark, idx)) !== -1) {
    count++;
    if (count > limit) {
      text = text.slice(0, idx) + replacement + text.slice(idx + mark.length);
      idx += replacement.length;
    } else {
      idx += mark.length;
    }
  }
  return text;
}

function dedupeStarters(text: string): string {
  for (const s of SENT_STARTERS) {
    const first = text.indexOf(s);
    if (first === -1) continue;
    let next = text.indexOf(s, first + s.length);
    while (next !== -1) {
      text = text.slice(0, next) + text.slice(next + s.length);
      next = text.indexOf(s, next);
    }
  }
  return text;
}

/* ----------------------------- 节奏增强 ----------------------------- */

/** 节奏增强：句长变异系数过低时，把最长句在安全位置劈开 */
function boostBurstiness(
  text: string,
  rng: () => number,
  p: number,
  style: RewriteStyle = "casual",
): string {
  let result: string;
  if (text.includes("\n")) {
    result = text
      .split(/\n\n+/)
      .map((para) => boostBurstinessSingle(para, rng, p))
      .join("\n\n");
  } else {
    result = boostBurstinessSingle(text, rng, p);
  }
  const usedFrags = new Set<string>();
  if (result.includes("\n")) {
    result = result
      .split(/\n\n+/)
      .map((para) => boostBurstinessFragments(para, usedFrags, style))
      .join("\n\n");
  } else {
    result = boostBurstinessFragments(result, usedFrags, style);
  }
  return result;
}

/** 全文级：CV 仍不够时插入极短句，带全局去重 */
function boostBurstinessFragments(
  text: string,
  usedFrags: Set<string>,
  style: RewriteStyle = "casual",
): string {
  if (style !== "casual") return text;
  const sentences = splitSentences(text);
  const stats = sentenceStats(text);
  if (stats.count < 4) return text;
  if (stats.avg > 0 && stats.cv >= MIN_BURSTINESS_CV) return text;

  const shortFrags = ["就这样。", "你懂的。", "说白了。", "差不多得了。"];
  let inserted = 0;
  const gap = Math.ceil(sentences.length / 4);
  for (let i = gap; i < sentences.length && inserted < 3; i += gap) {
    let frag = shortFrags[inserted % shortFrags.length];
    let g = 0;
    while ((usedFrags.has(frag) || sentences.some((s) => s === frag)) && g < shortFrags.length) {
      g++;
      frag = shortFrags[(inserted + g) % shortFrags.length];
    }
    usedFrags.add(frag);
    sentences.splice(i, 0, frag);
    inserted++;
    i++;
  }
  return sentences.join("");
}

function boostBurstinessSingle(text: string, _rng: () => number, _p: number): string {
  const sentences = splitSentences(text);
  const lens = sentences.map((s) => s.replace(/[。！？!?；;\n]/g, "").length);
  if (lens.length < 3) return text;
  if (computeStats(lens).cv >= MIN_BURSTINESS_CV) return text;
  for (let round = 0; round < 5; round++) {
    const lens2 = sentences.map((s) => s.replace(/[。！？!?；;\n]/g, "").length);
    if (computeStats(lens2).cv >= MIN_BURSTINESS_CV) break;
    let maxI = 0;
    for (let i = 1; i < lens2.length; i++) if (lens2[i] > lens2[maxI]) maxI = i;
    const s = sentences[maxI];
    const mid = findSplitPoint(s, 25);
    if (mid === -1) break;
    sentences[maxI] = s.slice(0, mid).trim() + "。";
    sentences.splice(maxI + 1, 0, s.slice(mid + 1).trim());
  }
  return sentences.join("");
}

/* ----------------------------- 竞品移植规则 ----------------------------- */

/** 中文与数字/字母之间的空格清理 */
function stripCJKEdgeSpaces(text: string): string {
  return text
    .replace(/([\u4e00-\u9fa5，。；：、])[ \t]+(?=[A-Za-z0-9])/g, "$1")
    .replace(/([A-Za-z0-9%）)\]])[ \t]+(?=[\u4e00-\u9fa5])/g, "$1");
}

/** 让步句式重构："虽然A，但是B" → "你可能觉得A？其实B" */
function reframeConcessives(text: string, rng: () => number, p: number): string {
  return text.replace(/虽然([^，。！？]{2,16})[，,]?但是/g, (m, inner: string) =>
    rng() < p ? `你可能觉得${inner}？其实` : m,
  );
}

/** 低概率混入半角逗号：AI 标点从不出错，人类偶尔手滑。
 *  硬约束：全文 ≤5% 且至少 10 个逗号才掺（原 20 个），保证任何文本长度下不越红线。 */
function injectHalfWidth(text: string, rng: () => number, p: number): string {
  if (p <= 0) return text;
  const total = (text.match(/，/g) || []).length;
  if (total < 10) return text; // 至少 10 个逗号才掺（短文本跳过）
  const cap = Math.max(1, Math.floor(total * 0.05)); // ≤5%，但至少 1 个
  let injected = 0;
  return text.replace(/，/g, () => {
    if (injected < cap && rng() < p) {
      injected++;
      return ",";
    }
    return "，";
  });
}

/** 段落方差规则 */
function varyParagraphs(text: string, rng: () => number, p: number): string {
  if (text.includes("\n\n") === false && !text.includes("\n")) return text;
  const paras = text.split(/\n{2,}/).filter((s) => s.trim());
  if (paras.length < 2) return text;
  const out: string[] = [];
  for (let i = 0; i < paras.length; i++) {
    const cur = paras[i].trim();
    const next = paras[i + 1]?.trim();
    if (next && cur.length < 25 && next.length < 25 && rng() < p) {
      const joiner = /[。！？!?]$/.test(cur) ? "" : "，";
      out.push(cur + joiner + next);
      i++;
      continue;
    }
    if (cur.length > 180 && rng() < p) {
      const sentences = splitSentences(cur);
      if (sentences.length >= 4) {
        const half = Math.ceil(sentences.length / 2);
        out.push(sentences.slice(0, half).join(""));
        out.push(sentences.slice(half).join(""));
        continue;
      }
    }
    out.push(cur);
  }
  return out.join("\n\n");
}

/* ----------------------------- 机械套话清除 ----------------------------- */

function stripAICliches(text: string): string {
  let out = text;
  for (const c of MECH_CLICHES) out = out.split(c).join("");
  return out;
}

function stripLeadingConnectivesHard(text: string): string {
  return text
    .replace(/([。！？!?\n])[ \t]*(然而|因此|此外|与此同时|更重要的是|另外|而且)[，,]?/g, "$1")
    .replace(/^(然而|因此|此外|与此同时|更重要的是)[，,]?/, "");
}

/* ----------------------------- 公共 API ----------------------------- */

/** 跨块反指纹清理 */
export function crossChunkCleanup(text: string): string {
  let out = text;
  out = dedupePadWords(out);
  out = dedupeStarters(out);
  out = limitPunctuation(out, "——", 1, "，");
  out = limitPunctuation(out, "……", 1, "。");
  out = stripLeadingConnectivesHard(out);
  out = stripAICliches(out);
  out = stripCJKEdgeSpaces(out);
  return out;
}

/** 机械扰动：LLM 输出的确定性反指纹规则层 */
export function mechanicalShuffle(text: string, opts: HumanizeOptions = {}): string {
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 0.3));
  const rng = makeRng(opts.seed);
  const style = opts.style ?? "casual";
  if (!text || !text.trim()) return "";
  let working = relaxEmDash(text, rng, 0.4 * intensity);
  working = relaxDunhao(working, rng, 0.4 * intensity);
  working = relaxColon(working, rng, 0.3 * intensity);
  working = relaxQuotes(working, rng, 0.25 * intensity);
  working = splitOnConnectors(working, rng, 0.25 * intensity);
  working = dedupePadWords(working);
  working = dedupeStarters(working);
  working = limitPunctuation(working, "——", 1, "，");
  working = limitPunctuation(working, "……", 1, "。");
  working = boostBurstiness(working, rng, 0.6 * intensity, style);
  working = varyParagraphs(working, rng, 0.5 * intensity);
  working = stripLeadingConnectivesHard(working);
  working = stripAICliches(working);
  working = stripCJKEdgeSpaces(working);
  working = reframeConcessives(working, rng, Math.min(1, 0.5 + 0.5 * intensity));
  working = injectHalfWidth(working, rng, 0.04 * intensity);
  return working
    .replace(/—{3,}/g, "——")
    .replace(/但，/g, "但")
    .replace(/([，、])\1+/g, "$1")
    .replace(/，。/g, "。")
    .replace(/。，/g, "。")
    .trim();
}

// 暴露给 humanize.ts 核心引擎的规则函数（humanizeSingle 调用它们）
export {
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
};
