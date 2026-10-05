/**
 * 机械扰动层 · 标点规则 / 垫词标点限额 / 竞品清理原语（自 humanize-shuffle.ts 拆出，逐字搬移）。
 * 导入面兼容由 ../humanize-shuffle.ts 门面统一 re-export。
 */
import {
  PAD_WORDS,
  SENT_STARTERS,
  MECH_CLICHES,
  MECH_CLICHE_REWRITE,
  splitSentences,
  pick,
} from "../humanize-data.ts";

import { EXTRA_SENT_STARTERS, EXTRA_STRIP_CONNECTIVES } from "../humanize-vocab-extra.ts";

const ALL_SENT_STARTERS = [...SENT_STARTERS, ...EXTRA_SENT_STARTERS];

/* =========================================================
   标点规则（与 v0.7 保持一致，不重写但保留入口）
   ========================================================= */

export function relaxEmDash(text: string, rng: () => number, p: number): string {
  return text.replace(/——/g, () => (rng() < p ? pick(rng, ["，", "。", "——"]) : "——"));
}

export function relaxDunhao(text: string, rng: () => number, p: number): string {
  return text.replace(/[^\n，。；！？、]{1,14}(?:、[^\n，。；！？、]{1,14})+/g, (run) => {
    if (rng() >= p) return run;
    const hasConj = /[与和及]/.test(run);
    const verbish = /[推干办做化走抓建拉提打治整修铺]/.test(run);
    const last = run.lastIndexOf("、");
    const joint = hasConj || verbish ? "，" : pick(rng, ["以及", "和", "，"]); // v0.8.5 去掉"跟"：「X拓宽跟搭台子」式连读拗口且命中接跟探针
    return run.slice(0, last) + joint + run.slice(last + 1);
  });
}

export function relaxColon(text: string, rng: () => number, p: number): string {
  let out = text.replace(
    /([\u4e00-\u9fa5])：(?=[\u4e00-\u9fa5])/g,
    (_m: string, pre: string, offset: number) => {
      const next = text[offset + 1];
      if (next === '"' || next === "\u201c" || next === "\u201d") return _m;
      return rng() < p ? pre + pick(rng, ["，", "，", "："]) : _m;
    },
  );
  out = out.replace(/([\u4e00-\u9fa5]):(?=[\u4e00-\u9fa5])/g, (_m: string, pre: string) =>
    rng() < p ? pre + "，" : _m,
  );
  return out;
}

export function relaxQuotes(text: string, rng: () => number, p: number): string {
  return text.replace(/[\u201c]([^\u201d，。；：]{1,10})[\u201d]/g, (_m: string, inner: string) =>
    rng() < p ? inner : _m,
  );
}

const CONNECTOR_RES = new Map(
  ["使得", "导致", "这样一来", "在此基础上", "与此同时", "正因如此"].map((c) => [
    c,
    new RegExp("([^。，；]{4,28}?)" + c + "([^。]{3,40})", "g"),
  ]),
);

export function splitOnConnectors(text: string, rng: () => number, p: number): string {
  for (const c of ["使得", "导致"]) {
    const re = CONNECTOR_RES.get(c)!;
    text = text.replace(re, (_m: string, pre: string, post: string) =>
      rng() < p ? pre + "。结果" + post : _m,
    );
  }
  for (const c of ["这样一来", "在此基础上", "与此同时", "正因如此"]) {
    const re = CONNECTOR_RES.get(c)!;
    text = text.replace(re, (_m: string, pre: string, post: string) =>
      rng() < p ? pre + "。" + c + post : _m,
    );
  }
  return text;
}

/* =========================================================
   垫词 / 标点 限额
   ========================================================= */

export function dedupePadWords(text: string): string {
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

export function limitPunctuation(
  text: string,
  mark: string,
  limit: number,
  replacement: string,
): string {
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

export function dedupeStarters(text: string): string {
  for (const s of ALL_SENT_STARTERS) {
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

/* =========================================================
   竞品移植 & 其他确定性清理
   ========================================================= */

/**
 * v0.8.9 P0：改写为「尊重原文排版习惯」。
 *
 * 原实现无条件删除中英/中数之间的空格，对技术文档是破坏性的：
 *   「从 Webpack 迁移到 Vite」→「从Webpack迁移到Vite」
 *   「第 47 分钟」→「第47分钟」、「手动 scp」→「手动scp」
 * 既毁排版规范，也让 bundle-based / optimizeDeps.include 这类术语的可读性崩掉。
 * 而空格是排版习惯而非 AI 语义特征，删掉对降分的边际收益远小于破坏。
 *
 * 现行规则：原文中英之间带空格 = 作者有排版意识 → 原样保留；
 *           原本就不带空格 → 无空格可删，剥离结果为空操作。
 *
 * v0.8.9 补充：初版按"≥3 处混排空格才算技术排版"分级，但实测豆瓣影评这类短文
 * 只有一两处（"第 47 分钟"）照样会被删。既然空格不是可靠的 AI 语义特征，
 * 分级阈值没有收益，改为完全跟随原文——与 LLM 侧 SYSTEM_PROMPT 第 18 条口径一致。
 */
const TYPED_SPACING_MIN = 1;
/** aggressive=true 恢复无条件剥离（v0.8.8 及之前行为），仅供回归探针使用 */
export function stripCJKEdgeSpaces(text: string, aggressive = false): string {
  const typed = (text.match(/[\u4e00-\u9fa5]\s[A-Za-z0-9]|[A-Za-z0-9]\s[\u4e00-\u9fa5]/g) || [])
    .length;
  if (!aggressive && typed >= TYPED_SPACING_MIN) return text;
  return text
    .replace(/([\u4e00-\u9fa5，。；：、])[ \t]+(?=[A-Za-z0-9])/g, "$1")
    .replace(/([A-Za-z0-9%）)\]])[ \t]+(?=[\u4e00-\u9fa5])/g, "$1");
}

/**
 * v0.8.9：LLM 改写稿的中英/中数空格回填（stripCJKEdgeSpaces 的反操作）。
 *
 * 背景：LLM 改写倾向压掉中英之间的空格（"Webpack是""Vite走""1200个模块"）——
 * 即便把"跟随原文排版"写进提示词铁律，模型仍只对"数字+中文"敏感，英文术语旁照删。
 * 这与本地引擎"尊重原文排版"的口径不一致，也让技术文档可读性受损。
 *
 * 判定：仅当原文本身是"带空格排版"时才回填；原文从不加空格的，原样返回。
 * 幂等：已有空格的位置不会重复插入（正则只匹配紧贴的中英边界）。
 */
export function restoreMixedSpacing(original: string, rewritten: string): string {
  const typed = (original.match(/[\u4e00-\u9fa5]\s[A-Za-z0-9]|[A-Za-z0-9]\s[\u4e00-\u9fa5]/g) || [])
    .length;
  if (typed < 1) return rewritten;
  // 只在「汉字 ↔ 字母/数字」之间插入。中文标点（，。；：、）与括号后
  // 一律不加空格——初版把标点也算进字符类，结果产出"， 1200 个模块""。 Webpack 是"
  // 这类错误空格，比不加还糟。
  return rewritten
    .replace(/([\u4e00-\u9fa5])(?=[A-Za-z0-9])/g, "$1 ")
    .replace(/([A-Za-z0-9])(?=[\u4e00-\u9fa5])/g, "$1 ");
}

export function reframeConcessives(text: string, rng: () => number, p: number): string {
  const _tpl = (_m: string, inner: string) =>
    rng() < p ? "\u4f60\u53ef\u80fd\u89c9\u5f97" + inner + "\uff1f\u5176\u5b9e" : _m;
  return text.replace(/虽然([^，。！？]{2,16})[，,]?但是/g, _tpl);
}

export function injectHalfWidth(text: string, rng: () => number, p: number): string {
  if (p <= 0) return text;
  const total = (text.match(/，/g) || []).length;
  if (total < 10) return text;
  const cap = Math.max(1, Math.floor(total * 0.05));
  let injected = 0;
  return text.replace(/，/g, () => {
    if (injected < cap && rng() < p) {
      injected++;
      return ",";
    }
    return "，";
  });
}

export function varyParagraphs(text: string, rng: () => number, p: number): string {
  if (!text.includes("\n\n") && !text.includes("\n")) return text;
  const paras = text.split(/\n{2,}/).filter((s) => s.trim());
  if (paras.length < 2) return text;
  const out: string[] = [];
  for (let i = 0; i < paras.length; i++) {
    const cur = paras[i].trim();
    const next = paras[i + 1]?.trim();
    if (next !== undefined && cur.length < 25 && next.length < 25 && rng() < p) {
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

/**
 * v0.9.23 性能：下面三张表都是**静态**常量，原来每次调用都重做一遍
 * 「逐条转义（本身就是一次 replace）+ new RegExp + 一次全文 replace」，
 * 68 条 MECH_CLICHES + 整张 REWRITE 表 + 19 条 EXTRA_STRIP，一条不落。
 * 预编译到模块级即可：转义函数照搬，输出**逐字等价**（实测 md5 一致）。
 * 实测（artifacts/_perf_strip.ts，两段合计 884 字 × 2000 次，输出 md5 前后一致）：
 *   stripAICliches 0.0473 → 0.0150 ms/次（-68.3%）
 *   stripLeadingConnectivesHard 0.0173 → 0.0050 ms/次（-71.1%）
 */
const escapeForRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CLICHE_LEADING_RES: RegExp[] = MECH_CLICHES.map(
  (c) => new RegExp(`(^|[。！？；，、\\n])${escapeForRe(c)}`, "g"),
);

/** 长键先换（原逻辑：短键先命中会打断长键的匹配），排序保留 */
const CLICHE_REWRITE_RES: [RegExp, string][] = Object.keys(MECH_CLICHE_REWRITE)
  .sort((a, b) => b.length - a.length)
  .map((c) => [new RegExp(escapeForRe(c), "g"), MECH_CLICHE_REWRITE[c]]);

const EXTRA_STRIP_RES: [RegExp, RegExp][] = EXTRA_STRIP_CONNECTIVES.map((w) => [
  new RegExp("([。！？!?\\n])[ \\t]*" + escapeForRe(w) + "[，,]?", "g"),
  new RegExp("^" + escapeForRe(w) + "[，,]?"),
]);

export function stripAICliches(text: string): string {
  let out = text;
  // 只在**小句起始位**删除：MECH_CLICHES 里混着两类东西——句首脚手架（综上所述，/在当今社会）
  // 和谓语短语（展望未来/按下了快进键/具有里程碑意义）。后者往往是句子里唯一的谓语，
  // 盲删会留下"人工智能技术。"式光杆主语，再被垫词补成"人工智能技术吧。"的废句
  //（实测谓语类 92~100/100 必塌）。判据与 stripLeadingConnectivesHard 同源：
  // 认边界不认内容，宁可留一个扣分项，也不产出读不通的句子。
  for (const re of CLICHE_LEADING_RES) {
    out = out.replace(re, "$1");
  }
  // 谓语位不能删的，改用口语等价物顶掉，避免把套话原样留在稿里。
  // 长键先换：否则短键会先命中并打断长键的匹配（排序已在 CLICHE_REWRITE_RES 里做掉）。
  for (const [re, to] of CLICHE_REWRITE_RES) {
    out = out.replace(re, to);
  }
  return out;
}

export function stripLeadingConnectivesHard(text: string): string {
  let out = text
    .replace(/([。！？!?\n])[ \t]*(然而|因此|此外|与此同时|更重要的是|另外|而且)[，,]?/g, "$1")
    .replace(/^(然而|因此|此外|与此同时|更重要的是)[，,]?/, "");
  for (const [re1, re2] of EXTRA_STRIP_RES) {
    out = out.replace(re1, "$1").replace(re2, "");
  }
  return out;
}
