/**
 * 趣AI味 v0.8 · 机械扰动层：反指纹规则 + 节奏增强 + 跨块清理 + 结构级去味（新增）
 *
 * v0.8 重大增强（针对朱雀结构特征的四大核心杠杆 + 两大句式级 + 两大反检测）：
 *  P0 shuffleSentencesSafe           段内句序安全重排（无承接依赖的自由句两两交换）
 *  P0 breakEnumerationStructure      首先/其次/最后 第一/第二/第三 列举结构打散
 *  P0 breakSummaryTail               总-分-总 尾总结句移位 + 可选拆段
 *  P0 resegmentParagraphsAggressive  AI 典型段（2-4句/极度均匀）激进重切
 *  P1 deParallelizeStructure         排比/对仗结构破坏（同头同长同结构连续 3+ 句）
 *  P1 injectSelfQA                   自问自答注入（AI 极少写，人类极常用）
 *  P2 injectHumanTypos               极低概率错别字（全文 <= 2 处，打字手滑痕迹）
 *  P2 injectDialect 多命中修复       原函数只改第一个命中 → 现多命中上限每词 3 处
 *  P3 FORMULAIC/连接词/LE_VERBS 扩充（配套 humanize-vocab-extra.ts）
 *
 * 2026-08-26 v2 新增（针对论说体「本地 aiScore=0 但官方仍 45%」的语义结构瓶颈）：
 *  P3-1 dismantleExpositionTrilogy      论述"三部曲"语义结构拆毁（去词 + 打乱顺序 + 第一人称经验插叙 + 半否定）
 *  P3-2 hardNumberedEnumerationShuffle  硬编号列举(1./2./3.)倒装打散2.0（删编号 + 插叙括号 + 反问 + 段尾补充）
 *  P3-3 enforceParagraphLeadSentVariance  段首句长强制方差（短/中/长 2:3:5 硬分布）
 *  P3-4 injectFirstPersonAnchorPoints    300字≥1 处第一人称经验锚点（论说专属「人写语义锚」）
 *  + 预检 preDetectHumanFingerprint    纯人写原稿命中则自动降级，修复"H0→H1/H2越去味越差"负收益
 */

import {
  PAD_WORDS,
  SENT_STARTERS,
  MECH_CLICHES,
  MECH_CLICHE_REWRITE,
  splitSentences,
  sentenceStats,
  computeStats,
  findSplitPoint,
  findGuardedCutNear,
  makeRng,
  MIN_BURSTINESS_CV,
  countPadHeads,
  PAD_INJECT_CAP,
  HumanizeOptions,
  RewriteStyle,
  pick,
  isSceneBlockLine,
} from "./humanize-data.ts";

import { EXTRA_SENT_STARTERS, EXTRA_STRIP_CONNECTIVES } from "./humanize-vocab-extra.ts";

// v0.9.1 使役无主句守卫：clampAvgSentencesInBlock 切句前检查后半句能否独立成句
// （「减轻教师的负担，让教师将…」切成「。让教师将…」= 无主病句，scan-bugs v5.2 106 次违规）
import { fragmentCanStand } from "./humanize-vocab.ts";

// P7-extra 引擎级体裁联动（与 classify-genre.ts 存在模块循环，但双方均只在函数体内
// 延迟引用对方导出、无顶层求值依赖，ESM 活绑定可安全解析）
import { classifyGenre } from "./classify-genre.ts";

const ALL_SENT_STARTERS = [...SENT_STARTERS, ...EXTRA_SENT_STARTERS];

/* =========================================================
   标点规则（与 v0.7 保持一致，不重写但保留入口）
   ========================================================= */

function relaxEmDash(text: string, rng: () => number, p: number): string {
  return text.replace(/——/g, () => (rng() < p ? pick(rng, ["，", "。", "——"]) : "——"));
}

function relaxDunhao(text: string, rng: () => number, p: number): string {
  return text.replace(/[^\n，。；！？、]{1,14}(?:、[^\n，。；！？、]{1,14})+/g, (run) => {
    if (rng() >= p) return run;
    const hasConj = /[与和及]/.test(run);
    const verbish = /[推干办做化走抓建拉提打治整修铺]/.test(run);
    const last = run.lastIndexOf("、");
    const joint = hasConj || verbish ? "，" : pick(rng, ["以及", "和", "，"]); // v0.8.5 去掉"跟"：「X拓宽跟搭台子」式连读拗口且命中接跟探针
    return run.slice(0, last) + joint + run.slice(last + 1);
  });
}

function relaxColon(text: string, rng: () => number, p: number): string {
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

function relaxQuotes(text: string, rng: () => number, p: number): string {
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

function splitOnConnectors(text: string, rng: () => number, p: number): string {
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
   节奏增强（burstiness）
   ========================================================= */

function boostBurstiness(
  text: string,
  rng: () => number,
  p: number,
  style: RewriteStyle = "casual",
): string {
  // v0.9-D：含剧本【场景/人物/背景…】块头行的段落跳过节奏注入（块头不得被塞极短语气句）
  const isScenePara = (para: string) => para.split("\n").some((ln) => isSceneBlockLine(ln));
  let result: string;
  if (text.includes("\n")) {
    result = text
      .split(/\n\n+/)
      .map((para) => (isScenePara(para) ? para : boostBurstinessSingle(para, rng, p)))
      .join("\n\n");
  } else {
    result = boostBurstinessSingle(text, rng, p);
  }
  const usedFrags = new Set<string>();
  if (result.includes("\n")) {
    result = result
      .split(/\n\n+/)
      .map((para) => (isScenePara(para) ? para : boostBurstinessFragments(para, usedFrags, style)))
      .join("\n\n");
  } else {
    result = boostBurstinessFragments(result, usedFrags, style);
  }
  return result;
}

function boostBurstinessFragments(
  text: string,
  usedFrags: Set<string>,
  style: RewriteStyle = "casual",
): string {
  if (style !== "casual") return text;
  // v0.9.4 P2 跨轮垫词饱和守卫：文本已有垫词达到上限后不再注入碎片——
  // 串联迭代实测（垫词 12→35）堆积全部来自各注入点无跨轮记忆。
  if (countPadHeads(text) >= PAD_INJECT_CAP) return text;
  const sentences = splitSentences(text);
  const stats = sentenceStats(text);
  if (stats.count < 4) return text;
  if (stats.avg > 0 && stats.cv >= MIN_BURSTINESS_CV) return text;

  const shortFrags = [
    "就这样。",
    "你懂的。",
    "说白了。",
    "差不多得了。",
    "嗯。",
    "哦对。",
    "行吧。",
  ];
  let inserted = 0;
  const gap = Math.ceil(sentences.length / 4);
  for (let i = gap; i < sentences.length && inserted < 3; i += gap) {
    // v0.8.9 P0：逻辑锚点处不插碎片。
    // 把「就这样。」「你懂的。」塞在序号句/因果句与其承接句之间，会在论证链上切出断口，
    // 读感像被人中途插了句不相干的话——碎片只在普通叙述句之间落点。
    // 注意用「顺延到下一个安全位」而非直接放弃：碎片本身是拉高句长方差的主力，
    // 少插会让节奏重新落入 AI 的均匀带（scan-bugs v5.3 会报警）。
    const anchorAt = (k: number) => LOGIC_ANCHOR_HEAD_RE.test((sentences[k] ?? "").trim());
    let slot = i;
    if (anchorAt(i - 1) || anchorAt(i)) {
      slot = -1;
      for (let k = i + 1; k < sentences.length; k++) {
        if (!anchorAt(k - 1) && !anchorAt(k)) {
          slot = k;
          break;
        }
      }
      if (slot === -1) continue;
    }
    let frag = shortFrags[inserted % shortFrags.length];
    let g = 0;
    while ((usedFrags.has(frag) || sentences.some((s) => s === frag)) && g < shortFrags.length) {
      g++;
      frag = shortFrags[(inserted + g) % shortFrags.length];
    }
    usedFrags.add(frag);
    sentences.splice(slot, 0, frag);
    inserted++;
    i = slot + 1;
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

/* =========================================================
   P0 结构级去味（朱雀结构特征影响最大的杠杆）
   ========================================================= */

/**
 * v0.8.9 P0 逻辑锚点签名：句首为序号/因果/承接标记的句子，其前后不插入口语碎片，
 * 也不参与句序重排（重排侧见 SEQUENCE_HEAD_RE）。覆盖「一是…」「因为…」「所以…」等
 * 一旦被打断就伤及论证链的句式。
 */
const LOGIC_ANCHOR_HEAD_RE =
  /^(?:一是|二是|三是|四是|其一|其二|其三|第一|第二|第三|首先|其次|再次|最后|末了|因为|由于|之所以|所以|因此|因而|但是|但|不过|然而|总之|综上|综上所述|总而言之|总的来看)/;

/** 承接词黑名单：以这些词开头的句子「必须」等在前句之后，不能参与重排（否则出病句） */
const SEQUENCE_HEAD_RE =
  // v0.8.9 P0 补充：序号锚词（一是/二是/第一/第二）与因果锚词（因为/由于）原本不在黑名单，
  // 实测工作周报的「一是把接口迁到新网关上了，比预想的麻烦」被拆句后互换，
  // 结果句跑到原因句之前，因果链断裂——这类句子一律不参与重排。
  /^(?:其次|最后|另一方面|另外|此外|而且|更重要的是|因此|于是|这样一来|所以|但是|但|不过|然而|总之|总的来看|归根结底|说白了|也就是说|换句话说|话又说回来|不仅如此|进一步说|再者|再看|反过来看|客观来讲|严格来说|真要说起来|往深了说|往实了说|值得注意的是|值得一提的是|尤为关键的是|尤为重要的是|不容忽视的是|因为|由于|之所以|一是|二是|三是|四是|其一|其二|其三|第一|第二|第三|首先|末了|到头来)/;

/** 总结句尾签名：全文/全段最后一句常以这些短语收束 = 典型「总-分-总」的「尾总」骨架 */
const SUMMARY_TAIL_SIGS = [
  "综上所述",
  "总而言之",
  "总的来说",
  "总的来看",
  "说到底",
  "归根结底",
  "一句话",
  "简而言之",
  "由此可见",
  "这么看",
  "照这么说",
  "本质上",
  "根子上",
  "从根本上",
  "展望未来",
  "面向未来",
  "未来可期",
  "任重而道远",
];

/** 判断某一句能否自由移动（不承载序列/因果/承接依赖） */
function sentenceIsFreestanding(s: string): boolean {
  if (SEQUENCE_HEAD_RE.test(s)) return false;
  // v0.9 专家修复 P4 长尾：QA 问句与其答案拆散后各自漂移
  //（「例子呢？」留在原位而「我随便举一个你就懂了。」被换走）——
  // QA 问句头与答案头一律视为非自由句，保持问答绑定
  if (QA_QUESTION_HEAD_RE.test(s) || QA_ANSWER_HEAD_RE.test(s)) return false;
  const plain = s.replace(/^[，。！？!?；；\s]+/, "");
  if (/^(：|——)/.test(plain)) return false;
  return true;
}

/** 自问自答问句头签名（与 injectSelfQA 模板池对齐） */
const QA_QUESTION_HEAD_RE =
  /^(?:为啥这么说|真的假的|你可能会问|不信|例子呢|有人要抬杠了|这话是不是太绝对|凭什么这么说|听着有点绕|这有什么要紧的|为什么呢|这么说有依据吗|是不是只有这一种解释|这意味着什么|这个判断可靠吗|有没有反例)/;
/** v0.9 专家修复 P4 长尾：答案句同样锁定——QA 对被拆到两段（问句留原位、
 *  答案句被换走）等于注入了一个悬空的半截对话，比不复读更刺眼 */
const QA_ANSWER_HEAD_RE =
  /^(?:因为事实就摆在眼前|这事儿还真不是我瞎编|其实不然|那你自己试试就知道了|我随便举一个你就懂了|别急，我慢慢跟你捋|要紧的在后头|往下看就明白了|换个说法就清楚了|原因其实不复杂|有，而且不难验证|未必，但这一种最直接|至少目前的数据支持它|有，但不足以推翻大方向)/;

/* ---------------- P0-1：段内句序安全重排 ---------------- */
export function shuffleSentencesSafe(
  sentences: string[],
  rng: () => number,
  intensity: number,
): string[] {
  if (intensity < 0.55) return sentences;
  if (sentences.length < 4) return sentences;
  const out = sentences.slice();
  // v0.9 专家修复 P1（句序）：原实现允许任意两个"自由句"远距离互换，
  // 实测把「28nm 背景→7nm 转折→3nm 引入」的因果链打乱成不可读乱序。
  // 自由句判定（无承接词头）挡不住"语义依赖但形式自由"的句子。
  // 现改为只允许「相邻句互换」：足以打破句长均匀指纹，论述顺序基本保持。
  const swapBudget = Math.max(1, Math.floor(out.length * 0.2 * intensity));
  let done = 0;
  for (let attempt = 0; attempt < swapBudget * 4 && done < swapBudget; attempt++) {
    const i = 1 + Math.floor(rng() * (out.length - 1));
    const j = rng() < 0.5 ? i - 1 : i + 1;
    if (j < 0 || j >= out.length) continue;
    if (!sentenceIsFreestanding(out[i]) || !sentenceIsFreestanding(out[j])) continue;
    if (rng() < 0.5) continue;
    [out[i], out[j]] = [out[j], out[i]];
    done++;
  }
  return out;
}

/* ---------------- P0-2：列举结构打散 ---------------- */
export function breakEnumerationStructure(
  sentences: string[],
  rng: () => number,
  intensity: number,
  style: RewriteStyle = "casual",
): string[] {
  if (sentences.length < 2) return sentences;
  if (intensity < 0.5) return sentences;
  const enumStart =
    /^(?:首先|第一[点条个]?|一方面|头一件|一来|先说|头一个|一上来|头一条)(?:[，、]|$)/;
  const startIdx = sentences.findIndex((s) => enumStart.test(s));
  if (startIdx === -1) return sentences;
  const memberRe =
    /^(?:其次|再者|此外|另外|而且|并且|最后|末了|收个尾|最后说一句|二来|再说|接着|第二[点条个]?|第三[点条个]?|另一方面|再一头|那头|从另一头|还有)(?:[，、]|$)/;
  const members: number[] = [startIdx];
  for (let i = startIdx + 1; i < sentences.length; i++) {
    if (memberRe.test(sentences[i])) members.push(i);
    else if (sentences[i].trim().length < 3) continue;
    else break;
  }
  if (members.length < 2) return sentences;
  const out = sentences.slice();
  // (a) 去序列标记：显式切片 + 换为非序列承接头
  // v0.9 专家修复 P5：academic 文风禁用口语承接头（哦对了/然后呢），用书面过渡词
  const HEADS_BY_STYLE: Record<RewriteStyle, string[]> = {
    casual: [
      "再说，",
      "还有，",
      "然后呢，",
      "顺带一提，",
      "哦对了，",
      "再补一句，",
      "换个角度，",
      "",
    ],
    plain: ["再者，", "同时，", "此外，", "从另一个角度看，", ""],
    academic: ["此外，", "在此基础上，", "进一步看，", "另一层面，", ""],
  };
  for (const mi of members) {
    for (const pat of [enumStart, memberRe]) {
      const m = out[mi].match(pat);
      if (m && m.index === 0) {
        const cut = m[0].length;
        const rest = out[mi].slice(cut).replace(/^[，、]/, "");
        if (rng() < 0.4 + 0.3 * intensity) {
          const head = pick(rng, HEADS_BY_STYLE[style]);
          out[mi] = head + rest;
        } else {
          out[mi] = rest;
        }
        break;
      }
    }
  }
  // v0.9 专家修复 P1：删除高强度「乱序成员数组」步骤——列举项之间的
  // 顺序承载内容逻辑（如"首先成本、其次良率"），乱序后语义颠倒。
  // 序列标记清除本身已打散"首先/其次/最后"骨架指纹，顺序保持原文。
  return out;
}

/* ---------------- P0-3：总分总骨架拆解 ---------------- */
export function breakSummaryTail(
  sentences: string[],
  rng: () => number,
  intensity: number,
): { sentences: string[]; splitAfter?: number } {
  if (sentences.length < 4) return { sentences };
  if (intensity < 0.5) return { sentences };
  const last = sentences[sentences.length - 1];
  const hasSummarySig = SUMMARY_TAIL_SIGS.some((sig) => last.includes(sig));
  if (!hasSummarySig) return { sentences };
  const out = sentences.slice();
  const summarySentence = out.pop()!;
  const freeSpots: number[] = [];
  for (let i = 1; i < out.length - 1; i++) {
    if (sentenceIsFreestanding(out[i])) freeSpots.push(i);
  }
  if (freeSpots.length === 0) {
    const mid = Math.max(1, Math.floor(out.length * (0.3 + rng() * 0.3)));
    out.splice(mid, 0, summarySentence);
  } else {
    const spot = freeSpots[Math.floor(rng() * freeSpots.length)];
    out.splice(spot + 1, 0, summarySentence);
  }
  if (intensity >= 0.75 && out.length >= 5) {
    const splitAfter = Math.floor(out.length * (0.55 + rng() * 0.2));
    return { sentences: out, splitAfter };
  }
  return { sentences: out };
}

/* ---------------- P0-4：段落重切激进版 ---------------- */
export function resegmentParagraphsAggressive(
  text: string,
  rng: () => number,
  intensity: number,
): string {
  if (intensity < 0.55) return text;
  const raw = text.split(/\n{2,}/).filter((s) => s.trim());
  if (raw.length < 2) return text;
  const statsFn = (p: string) => {
    const s = splitSentences(p);
    return { sentences: s.length, chars: p.replace(/\s/g, "").length };
  };
  const paraStats = raw.map(statsFn);
  const lens = paraStats.map((s) => s.chars);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const std = Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length);
  const cv = avg > 0 ? std / avg : 1;
  const needForce = cv < 0.45; // 段长 CV 严重均匀（人类通常 >0.6） → 强制至少一刀
  const out: string[] = [];
  let i = 0;
  let forceOneDone = false;
  while (i < raw.length) {
    const cur = raw[i];
    const ps = paraStats[i];
    const next = raw[i + 1];
    const ns = paraStats[i + 1];
    // (a) 相邻两段都 AI 典型 → 合并（概率 + 碎碎念桥接）
    if (
      next !== undefined &&
      ps.sentences >= 2 &&
      ps.sentences <= 4 &&
      ps.chars >= 50 &&
      ps.chars <= 180 &&
      ns.sentences >= 2 &&
      ns.sentences <= 4 &&
      ns.chars >= 50 &&
      ns.chars <= 180 &&
      (needForce ? !forceOneDone && rng() < 0.85 : rng() < 0.35 + 0.35 * intensity)
    ) {
      let merged = cur + "\n\n" + next;
      if (rng() < 0.55 + 0.25 * intensity) {
        const bridge = pick(rng, [
          "是这个理。",
          "嗯，对。",
          "你别说。",
          "哈哈。",
          "懂吧。",
          "",
          "",
          "",
        ]);
        if (bridge) merged = cur + "\n\n" + bridge + "\n\n" + next;
      }
      out.push(merged);
      i += 2;
      if (needForce) forceOneDone = true;
      continue;
    }
    // (b) 当前段 AI 典型 → 拆两段
    if (
      ps.chars >= 80 &&
      ps.chars <= 220 &&
      ps.sentences >= 3 &&
      (needForce ? !forceOneDone && rng() < 0.85 : rng() < 0.3 + 0.35 * intensity)
    ) {
      const sents = splitSentences(cur);
      const splitIdx = Math.max(
        1,
        Math.min(sents.length - 2, Math.ceil(sents.length * (0.35 + rng() * 0.3))),
      );
      const first = sents.slice(0, splitIdx).join("");
      const second = sents.slice(splitIdx).join("");
      if (first.trim() && second.trim()) {
        out.push(first, second);
        i++;
        if (needForce) forceOneDone = true;
        continue;
      }
    }
    out.push(cur);
    i++;
  }
  return out.join("\n\n");
}

/* =========================================================
   P1 句式级优化（排比对仗破坏 + 自问自答注入）
   ========================================================= */

/* ---------------- P1-1：排比/对仗结构破坏 ---------------- */
export function deParallelizeStructure(
  sentences: string[],
  rng: () => number,
  intensity: number,
): string[] {
  if (sentences.length < 3) return sentences;
  if (intensity < 0.55) return sentences;
  // 找连续 3+ 句共同开头签名：前 2~5 个 CJK/ASCII 字重复
  const headKey = (s: string) => {
    const clean = s.replace(/^[，。！？!?；;\s]+/, "");
    const m = clean.match(/^[\u4e00-\u9fa5A-Za-z]{2,5}/);
    return m ? m[0] : "";
  };
  const out: string[] = [];
  let runSents: string[] = [];
  let curHead = "";
  for (let idx = 0; idx < sentences.length; idx++) {
    const s = sentences[idx];
    const h = headKey(s);
    if (h && h === curHead) {
      runSents.push(s);
      continue;
    }
    if (runSents.length >= 3) fixParallelRun(out, runSents, rng, intensity);
    else runSents.forEach((rs) => out.push(rs));
    runSents = h ? [s] : [];
    curHead = h;
    if (!h) out.push(s);
  }
  if (runSents.length >= 3) fixParallelRun(out, runSents, rng, intensity);
  else runSents.forEach((rs) => out.push(rs));
  return out;
}

function fixParallelRun(
  out: string[],
  runSents: string[],
  rng: () => number,
  intensity: number,
): void {
  const modified = runSents.slice();
  const changeCount = Math.max(
    1,
    Math.min(2, Math.ceil(modified.length * (0.35 + 0.25 * intensity))),
  );
  const changed = new Set<number>();
  for (let c = 0; c < changeCount; c++) {
    let pickIdx = Math.floor(rng() * modified.length);
    let guard = 0;
    while (changed.has(pickIdx) && guard++ < 5) {
      pickIdx = Math.floor(rng() * modified.length);
    }
    if (changed.has(pickIdx)) continue;
    changed.add(pickIdx);
    const roll = rng();
    // 破坏 1：前加自问自答
    if (roll < 0.3 && intensity >= 0.65) {
      const q = pick(rng, ["为什么这么说？", "真的吗？", "有啥道理？", "这是为啥？", "能信？"]);
      modified[pickIdx] = q + modified[pickIdx];
    } else if (roll < 0.65) {
      // 破坏 2：把该句改成反问句（能安全改的句式）或前插不一致开头
      const s = modified[pickIdx];
      const canFlip = /^(?:能|可以|能够|应该|应当|需要|要|会|将|得)[^。！？!?]{4,30}[。]$/.test(s);
      if (canFlip) {
        modified[pickIdx] = s.slice(0, -1) + pick(rng, ["吗？", "吧？", "不成？"]);
      } else {
        modified[pickIdx] =
          pick(rng, ["哦对了，", "再说，", "你想想，", "等一下，", "我是说，", ""]) + s;
      }
    } else {
      // 破坏 3：前插碎碎念短语
      modified[pickIdx] =
        pick(rng, ["是吧，", "哦对，", "等一下，", "我是说，", "哦不对，", ""]) + modified[pickIdx];
    }
  }
  modified.forEach((m) => out.push(m));
}

/* ---------------- P1-2：自问自答注入（AI 极少写） ---------------- */
export function injectSelfQA(
  sentences: string[],
  rng: () => number,
  intensity: number,
  style: RewriteStyle = "casual",
): string[] {
  if (intensity < 0.65) return sentences;
  if (sentences.length < 5) return sentences;
  // v0.9 专家修复 P4：模板池从 6 条扩到 10 条——池子过小导致同模板跨文本复读，
  // "不信？""例子呢？我随便举一个你就懂了"成了 QuAiWei 的出厂指纹。
  // v0.9 专家修复 P5：plain 用克制型（无表演性碎句），academic 由调用方禁用（本函数兜底也拦）。
  const POOLS: Record<RewriteStyle, [string, string][]> = {
    casual: [
      ["为啥这么说？", "因为事实就摆在眼前。"],
      // v0.9.5 修：原为「这事儿还真不是我瞎编。」——对"自身真实性"做断言，
      // 在技术文档里等于凭空声明可信度（读者会问：你为什么要强调自己没编？），
      // 且与本工具的「严禁编造」定位冲突。改为描述读者感受，不做事实主张。
      ["真的假的？", "我知道这听着反常识。"],
      ["你可能会问——", "这不是理所当然的吗？其实不然。"],
      ["不信？", "那你自己试试就知道了。"],
      ["例子呢？", "我随便举一个你就懂了。"],
      ["有人要抬杠了——", "别急，我慢慢跟你捋。"],
      ["这话是不是太绝对？", "细想一下还真不是。"],
      ["凭什么这么说？", "往下看就明白了。"],
      ["听着有点绕？", "换个说法就清楚了。"],
      ["这有什么要紧的？", "要紧的在后头。"],
    ],
    plain: [
      ["为什么呢？", "原因其实不复杂。"],
      ["这么说有依据吗？", "有，而且不难验证。"],
      ["是不是只有这一种解释？", "未必，但这一种最直接。"],
      ["这意味着什么？", "往下看会更清楚。"],
      ["这个判断可靠吗？", "至少目前的数据支持它。"],
      ["有没有反例？", "有，但不足以推翻大方向。"],
    ],
    academic: [],
  };
  const pool = POOLS[style];
  if (pool.length === 0) return sentences;
  // v0.9 专家修复 P4：0.85+ 档注入 2 次改为全文 1 次——两处自问自答
  // 在短文本里已是"连珠炮"，真人频率远低于此。
  const budget = 1;
  const out = sentences.slice();
  let done = 0;
  for (let attempt = 0; attempt < 6 && done < budget; attempt++) {
    const pos = 1 + Math.floor(rng() * (out.length - 2));
    if (!sentenceIsFreestanding(out[pos])) continue;
    const qa = pick(rng, pool);
    out.splice(pos + 1, 0, qa[0] + qa[1]);
    done++;
  }
  return out;
}

/* =========================================================
   P2 反检测特征增强（错别字 / 方言多命中修复）
   ========================================================= */

/**
 * P2-1：极低概率错别字注入（全文 <= 2 处），模拟人类打字手滑。
 *
 * @deprecated v0.9.8 P0 —— **已停用（全体裁关闭），不再产出任何替换**。
 *
 * 停用理由（代价已量化，scripts/_typo_cost.ts，2026-09-14）：
 *   ① 收益为零：叙事体裁 2/10 seed 命中「得时候」，但 avg aiScore 仍是 **0.0** ——
 *      标尺不检测这类错别字（`typoCount * 30` 抓的是另一类更显眼的拼写错）。
 *      即：让文本出现真实语法错误，换不来任何"更像人写"的评分收益。
 *   ② 代价是真实的：首条规则 `的(?=时候)` → ["地","得"] 会把「的时候」写成「得时候」。
 *      这不是"模拟手滑"（真人打错字不会错成这个），而是"为反检测而故意犯错"。
 *      工具卖点是"更自然"，输出带语法错误会直接砸口碑，买家还得自己修错字。
 *   ③ 设计自证：`humanHand` 体裁早已 `disableTyposAnchor: true` —— 设计者本就认它有害。
 *
 * 为何整体关死而非把概率调更低：只要还注入，就一定会留下错误；而它换不来分数。
 * 属"净负收益设计，删除优于调低概率"（同 injectDialect 的处置逻辑）。
 *
 * 保留函数本体与 TYPO_PAIRS 表以备回滚：**不要重新接回主路径**，
 * 除非标尺新增了对"语法级错别字"的检测项（届时需重新量化收益）。
 */
const TYPO_PAIRS: [RegExp, string[]][] = [
  [/(?<![的地得])的(?=方式|方法|原因|结果|时候|问题|情况)/, ["地", "得"]],
  [/(?<![的地得])地(?=说|看|做|想|跑|走|提升|提高|降低)/, ["的", "得"]],
  [/(?<![在再])在(?=说|看|试|去|来|做一遍|想一想)/, ["再"]],
  [/(?<![做作])做(?=为|品|业|用|法|文)/, ["作"]],
  [/(?<![做作])作(?=事|饭|题|实验|测试|对比)/, ["做"]],
];
const TYPO_MAX_GLOBAL = 2;

/** v0.9.8 P0：错别字注入总开关。置 true 可临时回滚（需重新量化收益）。 */
const TYPO_INJECTION_ENABLED = false;

export function injectHumanTypos(text: string, rng: () => number, intensity: number): string {
  if (!TYPO_INJECTION_ENABLED) return text;
  if (intensity < 0.7) return text;
  // P8 场景块保真：场景行区间不计入命中——错别字单字替换会破坏【场景：…】块头，
  // 同时保留全文级 TYPO_MAX_GLOBAL 预算语义不变
  const sceneRanges: [number, number][] = [];
  {
    let pos = 0;
    for (const ln of text.split("\n")) {
      if (isSceneBlockLine(ln)) sceneRanges.push([pos, pos + ln.length]);
      pos += ln.length + 1;
    }
  }
  const inScene = (idx: number) => sceneRanges.some(([a, b]) => idx >= a && idx <= b);
  let injected = 0;
  let out = text;
  for (const [re, tos] of TYPO_PAIRS) {
    if (injected >= TYPO_MAX_GLOBAL) break;
    const hits: number[] = [];
    const reClone = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = reClone.exec(out)) !== null) {
      if (!inScene(m.index)) hits.push(m.index);
    }
    if (hits.length === 0) continue;
    if (rng() > Math.min(0.55, 0.25 + intensity * 0.35)) continue;
    const targetIdx = hits[Math.floor(rng() * hits.length)];
    // 对应正则最后一段匹配长度一般为 1 字，做单字替换
    out = out.slice(0, targetIdx) + pick(rng, tos) + out.slice(targetIdx + 1);
    injected++;
  }
  return out;
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
function stripCJKEdgeSpaces(text: string, aggressive = false): string {
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

function reframeConcessives(text: string, rng: () => number, p: number): string {
  const _tpl = (_m: string, inner: string) =>
    rng() < p ? "\u4f60\u53ef\u80fd\u89c9\u5f97" + inner + "\uff1f\u5176\u5b9e" : _m;
  return text.replace(/虽然([^，。！？]{2,16})[，,]?但是/g, _tpl);
}

function injectHalfWidth(text: string, rng: () => number, p: number): string {
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

function varyParagraphs(text: string, rng: () => number, p: number): string {
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

function stripAICliches(text: string): string {
  let out = text;
  // 只在**小句起始位**删除：MECH_CLICHES 里混着两类东西——句首脚手架（综上所述，/在当今社会）
  // 和谓语短语（展望未来/按下了快进键/具有里程碑意义）。后者往往是句子里唯一的谓语，
  // 盲删会留下"人工智能技术。"式光杆主语，再被垫词补成"人工智能技术吧。"的废句
  //（实测谓语类 92~100/100 必塌）。判据与 stripLeadingConnectivesHard 同源：
  // 认边界不认内容，宁可留一个扣分项，也不产出读不通的句子。
  for (const c of MECH_CLICHES) {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[。！？；，、\\n])${escaped}`, "g"), "$1");
  }
  // 谓语位不能删的，改用口语等价物顶掉，避免把套话原样留在稿里。
  // 长键先换：否则短键会先命中并打断长键的匹配。
  for (const c of Object.keys(MECH_CLICHE_REWRITE).sort((a, b) => b.length - a.length)) {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), MECH_CLICHE_REWRITE[c]);
  }
  return out;
}

function stripLeadingConnectivesHard(text: string): string {
  let out = text
    .replace(/([。！？!?\n])[ \t]*(然而|因此|此外|与此同时|更重要的是|另外|而且)[，,]?/g, "$1")
    .replace(/^(然而|因此|此外|与此同时|更重要的是)[，,]?/, "");
  for (const w of EXTRA_STRIP_CONNECTIVES) {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re1 = new RegExp("([。！？!?\\n])[ \\t]*" + escaped + "[，,]?", "g");
    const re2 = new RegExp("^" + escaped + "[，,]?");
    out = out.replace(re1, "$1").replace(re2, "");
  }
  return out;
}

/* =========================================================
   结构级段落主入口（被主引擎 + mechanicalShuffle 调用）
   ========================================================= */

/** P7-E：段落内任一行含剧本【场景/人物/背景】块头即视为场景块段落 */
function paraHasSceneBlock(paragraph: string): boolean {
  return paragraph
    .split(/\n/)
    .some((ln) => /【[^】]{0,80}(?:场景|人物|角色|地点|时间|背景|旁白|简介)[^】]{0,80}】/.test(ln));
}
export function structuralShuffleParagraph(
  paragraph: string,
  rng: () => number,
  intensity: number,
  opts: {
    zhuqueMode?: boolean;
    expoForceP3?: boolean;
    skipSceneInject?: boolean;
    skipSelfQA?: boolean; // v0.9.1：narrative/humanHead 跳过全部自问自答
    style?: RewriteStyle;
  } = {},
): string {
  if (intensity < 0.5) return paragraph;
  const sents = splitSentences(paragraph);
  if (sents.length < 3) return paragraph;
  const style = opts.style ?? "plain";
  let working = sents;
  working = breakEnumerationStructure(working, rng, intensity, style);
  const { sentences: afterSummary, splitAfter } = breakSummaryTail(working, rng, intensity);
  working = deParallelizeStructure(afterSummary, rng, intensity);
  // 2026-08-26 v2 P3-1/P3-2：论说结构语义级拆毁（插叙/颠倒顺序/拆编号）
  // P7-B 体裁门控：(zhuqueMode AND expoScore≥0.55) OR (zhuqueMode AND expoForceP3)
  //           → 当 genre==main 且强度≥0.75 时，即使 expo 分略低于 0.55 也拆（覆盖边缘论说文）
  const zhuqueBoost = opts.zhuqueMode ?? false;
  const expoScore = classifyExpositionScore(paragraph);
  const runP3 =
    zhuqueBoost && (expoScore >= 0.55 || (opts.expoForceP3 === true && expoScore >= 0.35));
  if (runP3) {
    working = dismantleExpositionTrilogy(working, rng, intensity);
    working = hardNumberedEnumerationShuffle(working, rng, intensity);
    // P3-3/P3-4 接收的是整段文本（非句数组），需先 join 再继续
    const joined = working.join("");
    const afterVariance = enforceParagraphLeadSentVariance(joined, rng, intensity);
    working = splitSentences(injectFirstPersonAnchorPoints(afterVariance, rng, intensity));
  }
  working = shuffleSentencesSafe(working, rng, intensity);
  // P7-E：剧本【场景/人物/背景】段落跳过自问自答注入 + 错别字注入（由调用者外层也过滤 injectHumanTypos）
  // 按行扫描判定：前置注入可能把多行折叠成单段并污染段首，^ 锚定的整段匹配会失配击穿保护
  // v0.9 专家修复 P5：academic 文风禁用自问自答（「不信？」「例子呢？」是纯口语装置，
  // academic 承诺仅消结构规律与套话，不得引入口语注入）
  // v0.9.1：narrative/humanHand 体裁级跳过全部自问自答（"例子呢？"不属于叙事/人写原稿）
  const sceneBlockPara = (opts.skipSceneInject ?? false) && paraHasSceneBlock(paragraph);
  if (!sceneBlockPara && style !== "academic" && !(opts.skipSelfQA ?? false)) {
    working = injectSelfQA(working, rng, intensity, style);
  }
  if (splitAfter !== undefined && splitAfter > 0 && splitAfter < working.length - 1) {
    const a = working.slice(0, splitAfter + 1).join("");
    const b = working.slice(splitAfter + 1).join("");
    return a + "\n\n" + b;
  }
  return working.join("");
}

/* =========================================================
   v2 P3 论说结构指纹拆毁 & 真人预检（2026-08-26）
   针对：O2(论说0.7) 本地 aiScore=0 但官方=45% → 词级/句长级已"满分像人"，
   但朱雀仍看到「论述三部曲、硬编号列举、段首雷同、冰冷无个人锚点」这些
   本地 breakdown 没有建模的语义结构。
   ========================================================= */

/** P3-1 论述三部曲拆毁：不仅删"首先/其次/最后"字面词，更打乱顺序、
 *  随机挑 1 条改成"第一人称经验插叙"、1 条改成"反事实假设/半否定"、
 *  1 条保留——语义布局从 AI 严格 1→2→3 变为真人跳跃式推演。 */
export function dismantleExpositionTrilogy(
  sentences: string[],
  rng: () => number,
  intensity: number,
): string[] {
  if (intensity < 0.7 || sentences.length < 3) return sentences;
  const TRIGGER =
    /^(?:首先|其次|再次|最后|末了|第一[点条个方面]?|第二[点条个方面]?|第三[点条个方面]?|一方面|另一方面|据此|综上|综上所述|基于此|由此可见|紧接着|接下来|随后|再者|而且|同时|与此同时|进一步)(?:[，、是说]\s*)?/;
  const triggerIdxs: number[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (TRIGGER.test(sentences[i].trim()) && triggerIdxs.length < 5) triggerIdxs.push(i);
  }
  if (triggerIdxs.length < 3) return sentences;

  const out = sentences.slice();
  const picks = triggerIdxs.slice(0, 3);
  const [a, b, c] = picks;
  // v0.9 专家修复 P1（句序）：删除「打乱 3 句顺序」步骤。实测乱序把
  // 论述链（背景→转折→引入）颠倒成不可读文本；套话清除 + 头部改写本身
  // 已足够破坏"首先/其次/最后"的严格三部曲指纹，顺序保持原文。
  const trio = [out[a], out[b], out[c]];
  // (2) 第 1 条：改第一人称经验插叙
  const firstPersonHeads = [
    "其实我自己之前就碰到过类似的情况——",
    "我之前在项目里做过类似的测算，结论是——",
    "我去年还在老东家做过这个行业的调研，大致是——",
    "哦对，我自己读下来觉得——",
    "我身边也有人做过差不多的事情，他们的感受是：",
    "我之前查过一份内部的报告，里面其实也提到——",
  ];
  trio[0] = pick(rng, firstPersonHeads) + trio[0].replace(TRIGGER, "");
  // (3) 第 2 条：改反事实假设 / 半否定开头
  const hedgeHeads = [
    "不过话说回来，其实不一定非要",
    "说真的，不见得必须",
    "老实讲，也未必需要",
    "反过来想，其实没必要",
    "如果换个角度呢？不一定非得",
  ];
  trio[1] = pick(rng, hedgeHeads) + trio[1].replace(TRIGGER, "");
  // (4) 第 3 条：保留内容，加一个"人读累了的过渡短语"在句尾
  const tailPhrases = [
    "，至少我是这么看的。",
    "——起码目前是这样。",
    "，谁知道以后呢。",
    "，大概就是这么个理儿。",
    "，我说的也不一定对哈。",
  ];
  let s3 = trio[2].replace(TRIGGER, "");
  if (/[。！？!?]$/.test(s3) && rng() < 0.8) {
    s3 = s3.slice(0, -1) + pick(rng, tailPhrases);
  }
  out[a] = trio[0];
  out[b] = trio[1];
  out[c] = s3;
  // v0.9 专家修复 P1：删除 0.9+ 档「与句组外自由句互换位置」——
  // 跨句组换位实测造成段内因果链断裂，收益（指纹扰动）远小于代价。
  return out;
}

/** P3-2 硬编号列举 2.0：检测 "1. xxx / (2) xxx / 第三：xxx / ① xxx" 等编号列举，
 *  第 1 条 → 插叙括号化（挪到相邻句尾括号里），第 2 条 → 改反问句，
 *  第 3 条 → 挪到段尾加"补充说明"头，彻底毁掉"条目罗列"的语义视觉布局。 */
export function hardNumberedEnumerationShuffle(
  sentences: string[],
  rng: () => number,
  intensity: number,
): string[] {
  if (intensity < 0.7 || sentences.length < 2) return sentences;
  const NUM = /^[\s(（]*\s*(?:\d+|[①②③④⑤⑥⑦⑧⑨⑩一二三四五六七八九十]+[.、:：)）]\s*)/;
  const hits: number[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (NUM.test(sentences[i].trim())) hits.push(i);
  }
  if (hits.length < 2) return sentences;

  const out = sentences.slice();
  const chosen = hits.slice(0, Math.min(3, hits.length));
  // A. 第一条 → 插叙括号化
  const idx0 = chosen[0];
  let body0 = out[idx0].replace(NUM, "").trim();
  const punct = /[。！？!?]$/.test(body0) ? body0.slice(-1) : "。";
  body0 = body0.replace(/[。！？!?]$/, "");
  if (rng() < 0.7) {
    const parenth = "（顺便提一句——" + body0 + "）" + punct;
    const neighbor =
      idx0 - 1 >= 0 && !hits.includes(idx0 - 1)
        ? idx0 - 1
        : idx0 + 1 < out.length
          ? idx0 + 1
          : idx0;
    out[neighbor] = out[neighbor].replace(/\s*$/, "") + parenth;
    out[idx0] = "";
  }
  // B. 第二条 → 改反问句
  if (chosen[1] !== undefined) {
    const idx1 = chosen[1];
    let s = out[idx1].replace(NUM, "").trim();
    s = s.replace(/[。！？!?]$/, "");
    if (rng() < 0.8) {
      const suffix = pick(rng, [
        "，这难道还不够明显吗？",
        "，这不就是最直接的证据吗？",
        "——你们自己想，是不是这个道理？",
        "，真的能一笔带过吗？",
        "，这事儿恐怕没那么简单吧？",
      ]);
      out[idx1] = s + suffix;
    }
  }
  // C. 第三条 → 挪到段尾加"补充说明"头
  if (chosen[2] !== undefined) {
    const idx2 = chosen[2];
    const s2 = out[idx2].replace(NUM, "").trim();
    out[idx2] = "";
    const head = pick(rng, [
      "最后补充一句，",
      "哦对，差点忘了——",
      "还有个小尾巴：",
      "再多嘴一句哈，",
    ]);
    out.push(head + s2);
  }
  return out.filter((s) => s.length > 0);
}

/** P3-3 段首句长强制方差：段首雷同（相邻段首句长差 ≤ 2 字）时，
 *  50% 概率在段首加 4-8 字独立口语过渡短句，50% 概率把段首句中间切一刀，
 *  强制段首 CV 提升 0.1→0.4+  。 */
export function enforceParagraphLeadSentVariance(
  text: string,
  rng: () => number,
  intensity: number,
): string {
  if (intensity < 0.7) return text;
  const paras = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
  if (paras.length < 2) return text;
  const leadLens = paras.map((p) => {
    const first = splitSentences(p)[0] || "";
    return first.replace(/\s/g, "").length;
  });
  const corrected = paras.slice();
  for (let i = 1; i < corrected.length; i++) {
    const diff = Math.abs(leadLens[i] - leadLens[i - 1]);
    if (diff <= 2) {
      const sents = splitSentences(corrected[i]);
      if (!sents.length) continue;
      const mode = rng() < 0.5 ? "prependShort" : "chopLead";
      if (mode === "prependShort") {
        const head = pick(rng, [
          "先说清楚哈——",
          "别急，听我说。",
          "开门见山，",
          "哦对了，",
          "说句题外话，",
          "这点得承认，",
          "咱们实话说，",
        ]);
        corrected[i] = head + "\n" + corrected[i];
        leadLens[i] = head.length + leadLens[i];
      } else {
        const s0 = sents[0];
        if (s0.length > 12) {
          const cutPos = 6 + Math.floor(rng() * Math.max(1, s0.length - 14));
          const a = s0.slice(0, cutPos);
          const b = s0.slice(cutPos);
          sents[0] = a + "，" + b;
          corrected[i] = sents.join("");
        }
      }
    }
  }
  return corrected.join("\n\n");
}

/* 2026-08-26 v3 P4：N2/D2 低 burstiness + 破折号超标 + VOCAB 保护衍生套话 指纹补药
   v3 P5（抠最后 1~2 分）：A. avgLen 硬约束到 ≤25（独立于 burstiness）B. 放宽极短锚切段阈值（14→10 字）+ 加 1 字更极端锚
   放在 humanize() return 前做"清尾保险"：
   - P4-C replaceGuardedFormulaicDerivs：VOCAB 带 GUARD 后缀保护的合法套话衍生形（如"针对→性"=针对性）保语义整体替换
   - P4-A ensureEmDashCountHardCap：整篇「——」> cap 时，从后往前把多余非自问自答的换成「，」
   - P5-A clampAvgSentenceLenUnder25：若 avgLen>25 → 在最长句中央「，」处切段为两句，降 avgLen（O2/O3 各清 1 分）
   - P4-B boostBurstinessIfLow(v2)：burstiness<0.6 时，在长句尾插入 1~3 字极短独立句锚造双峰 CV（D2 清 2 分） */
export function replaceGuardedFormulaicDerivs(text: string): string {
  // 只替换组合词，不碰原本"针对/系统/有效"单字（避免破坏 guard 语义）
  return text
    .replace(/针对性的(?=[\u4e00-\u9fa5，。！？；：、])/g, "专门的")
    .replace(/针对性地(?=[\u4e00-\u9fa5])/g, "专门地")
    .replace(/针对性(?!词汇|治疗|培训|训练|广告)/g, "专门方向")
    .replace(/系统性的(?=[\u4e00-\u9fa5，。！？；：、])/g, "全盘的")
    .replace(/系统性地(?=[\u4e00-\u9fa5])/g, "从头到脚地")
    .replace(/系统性(?!改革|工程)/g, "完整体系")
    .replace(/有效性/g, "实际效果")
    .replace(/持续性的/g, "长期的")
    .replace(/持续性地/g, "长时间地")
    .replace(/(从根本)上(?=[说讲看解决改变]|，|。)/g, "$1来说");
}

/* P5-A：avgLen（纯句长，去标点）> 25 → 反复切最长句的中央逗号，直到 avgLen ≤ 25 或切无可切。
   注意：切段仅在「，/；/、/：」存在时做，避免斩断语义重的完整分句；最多 maxCuts 次防止过切。
   此函数不关心 burstiness，只为了清掉 aiScore 第三分量 clamp((avgLen-25)/40, 0, 1)*20 的 1 分惩罚（O2=1.33, O3=0.6 → 清为 0）。*/
export function clampAvgSentenceLenUnder25(text: string, targetAvg = 25, maxCuts = 6): string {
  // P7-F 段落感知：splitSentences 的 trim 会剥掉句尾 \n\n，
  // 全文级 splitSentences→join 会悄悄合并段落（与 boostBurstiness 相同的分段模式）
  if (!text.includes("\n\n")) return clampAvgSentencesInBlock(text, targetAvg, maxCuts);
  return text
    .split(/\n\n+/)
    .map((p) => clampAvgSentencesInBlock(p, targetAvg, maxCuts))
    .join("\n\n");
}

function clampAvgSentencesInBlock(text: string, targetAvg: number, maxCuts: number): string {
  if (maxCuts <= 0) return text;
  let working = text;
  for (let c = 0; c < maxCuts; c++) {
    const stats = sentenceStats(working);
    if (stats.avg <= targetAvg) break;
    const sents = splitSentences(working);
    // 找：最长的、内部有逗号/分号（可切段点）的句子
    const rank = sents
      .map((s, i) => {
        const pure = s.replace(/[\s。！？!?…—\-，、；：""''「」（）《》【】]/g, "");
        return { i, s, L: pure.length, hasCut: /[，；、：]/.test(s) };
      })
      .filter((x) => x.hasCut && x.L > targetAvg + 2)
      .sort((a, b) => b.L - a.L);
    if (rank.length === 0) break;
    // v0.9 专家修复 P2/P3：逐候选找切点（原版只试最长一句，守卫否决后整轮放弃，
    // avgLen 压不下去——O3 实测 avgLen 32 卡死）。最多看 4 条长句。
    let t: { i: number; s: string } | null = null;
    let cutIdx = -1;
    for (let k = 0; k < Math.min(4, rank.length); k++) {
      const cand = rank[k];
      const m = findGuardedCutNear(cand.s, Math.floor(cand.s.length / 2));
      if (m !== -1) {
        // v0.9.1 使役无主句守卫：切出的后半句若以"让/使/帮/叫"开头（承接前句宾语），
        // 不能独立成句——跳过该候选，换下一句切（scan-bugs v5.2「使役无主句」106 次违规）
        const rest = cand.s.slice(m + 1).trim();
        if (!fragmentCanStand(rest)) continue;
        t = cand;
        cutIdx = m;
        break;
      }
    }
    if (!t || cutIdx < 0) break;
    const front = t.s.slice(0, cutIdx); // 例如"根据报告显示，今年增长明显"
    const rest = t.s.slice(cutIdx + 1); // "今年增长明显。"
    // 把逗号换成句号；后半首字母大写对中文无所谓
    const newSents = [front + "。", rest];
    // 回写：sents 数组位置 t.i 替换为 2 条
    sents.splice(t.i, 1, ...newSents);
    working = sents.join("");
  }
  return working;
}
export function ensureEmDashCountHardCap(text: string, cap = 1): string {
  if (cap < 0) return text;
  // 先统计：匹配 em-dash 2字节标准写法 ——
  const EM = "——";
  let count = 0;
  for (let i = 0; i < text.length - 1; i++) if (text[i] === "—" && text[i + 1] === "—") count++;
  if (count <= cap) return text;
  let need = count - cap;
  let out = text;
  // 从尾部往前替换：优先保住开头「你可能会问——/有人要抬杠了——」这种自问自答（一般在段首靠前）
  // 保留第 1 个最早出现的，其余从后往前按能替换的换成合适的标点
  while (need > 0) {
    const last = out.lastIndexOf(EM);
    if (last === -1) break;
    const before = last > 0 ? out[last - 1] : "";
    // 如果前一字是「问/说/答/想/杠/啦/呢/吗/哦/哎」→ 自问自答型，不替换，跳过这一处
    const skipChars = "问说答想杠啦呢吗哦哎？！，";
    if (skipChars.includes(before)) {
      // 往前找下一个（跳过此位置）
      // 临时替换为 placeholder 避免反复命中
      out = out.slice(0, last) + "\x00\x00" + out.slice(last + 2);
      continue;
    }
    // 替换策略：前面如果有数字或「的/了/是/在/有」→ 用"，"，否则"，"通吃
    out = out.slice(0, last) + "，" + out.slice(last + 2);
    need--;
  }
  // 还原 placeholder（自问自答那几处保留下来的）
  out = out.split("\x00\x00").join(EM);
  return out;
}

/**
 * v0.8.8 语气词极短句密度上限：管线里多个注入器（boostBurstiness / IfLow 尾挂 /
 * 自问自答等）叠加后，同段可累积出「呣。哦。咳。」三连独立极短句——单个都在
 * 守卫限额内，叠起来仍是"过度人味"的机器指纹（v0.8.6 质检提示词已把它列为
 * FAIL 项，引擎侧也要自守同一条纪律）。确定性收口：每段独立极短语气句 ≤ 2 条，
 * 超出的直接删（它们是独立句，删除不伤语法、不伤语义）。零随机、幂等。
 */
const PARTICLE_SENT_RE = /^(?:对哦|是啊|好吧|[嗯嗨诶咳呵啧呣哦啊行]){1,4}$/;
/** 句尾挂语气词（"好评哦。""韧性好吧。"）：锚点注入器惯用手法——插在句末标点前 */
const PARTICLE_SUFFIX_RE = /(?:对哦|是啊|好吧|[嗯嗨诶咳呵啧呣哦啊行])$/;

export function capParticleSentenceDensity(text: string, maxPerPara = 1, stripSuffix = true): string {
  // v0.9 专家修复 P3：每段独立极短语气句上限 2 → 1。实测 0.9 档输出段尾
  // 「呵。啧。」「行。好吧。呵。」成串——每段 2 条在 3 段短文里就是 6 条，
  // 堆积密度远超真人（真人每段至多 1 条口头语，且不是每段都有）。
  // stripSuffix=false：只收独立语气句、保留句尾挂词（最终收口用，防止把
  // burstiness 兜底刚拉起的句长方差又拍平）。
  return text
    .split(/\n\n+/)
    .map((para) => {
      const sents = splitSentences(para);
      // v0.9 长尾：整段只剩短碎句（重切/桥接把正文抽走后留下「道理是这个道理。行。」
      // 式空段）→ 整段丢弃（全段句子均 ≤8 字即视为无正文残留）
      // v0.9.10 修正：原判据「全段句子均 ≤8 字」会把普通短句段整段清空——
      // 8 字是常见中文句长（「这个功能确实好用。」正好 8 字），不是碎句，
      // 实测该函数直接把这类段落返回成空串，与主流程注释「不动正常短句」相悖。
      // 空壳段的真特征是「语气词残留 + 全段极短」，故收紧为：≥2 句、均 ≤5 字、
      // 且至少含 1 条独立语气句（确有注入器残留痕迹）。
      const bareAll = sents.filter((s) => s.trim());
      const bareOf = (s: string) => s.replace(/[\s。！？!?…，、；：]/g, "");
      if (
        bareAll.length >= 2 &&
        bareAll.every((s) => bareOf(s).length <= 5) &&
        bareAll.some((s) => PARTICLE_SENT_RE.test(bareOf(s)))
      ) {
        return "";
      }
      const out: string[] = [];
      let kept = 0;
      for (const s of sents) {
        const bare = s.replace(/[\s。！？!?…，、；：]/g, "");
        const isStandalone = bare.length > 0 && bare.length <= 4 && PARTICLE_SENT_RE.test(bare);
        // 句尾挂词：只认长句（core>6 字），短句本身就是独立语气句走 isStandalone 分支
        const trimmed = s.trimEnd();
        const core = trimmed.replace(/[。！？!?…]+$/, "");
        const hasSuffix = core.length > 6 && PARTICLE_SUFFIX_RE.test(core);
        if (kept >= maxPerPara) {
          if (isStandalone) continue; // 超额独立语气句：整句丢弃
          if (hasSuffix && stripSuffix) {
            // 超额句尾挂词：剥语气词本体、保句子（"好评哦。"→"好评。"）
            const stripped = core.replace(PARTICLE_SUFFIX_RE, "").replace(/[，、；：,]$/, "。");
            out.push(stripped + trimmed.slice(core.length));
            continue;
          }
          out.push(s);
          continue;
        }
        if (isStandalone || hasSuffix) kept++;
        out.push(s);
      }
      return out.join("");
    })
    .join("\n\n");
}

export function boostBurstinessIfLow(
  text: string,
  rng: () => number,
  targetCv = MIN_BURSTINESS_CV,
  maxCuts = 12,
  style: RewriteStyle = "casual",
): string {
  // v0.9 专家修复 P5：academic 文风禁用极短语气锚（「呵。」「啧。」是纯口语装置）。
  // CV 兜底交给 clampAvgSentenceLenUnder25 的纯切句（不打语气词）。
  if (style === "academic") return text;
  // v0.9-D：含剧本【场景/人物/背景…】块头行的段落跳过极短锚注入（块头不得被塞"啧。呣。"）
  const isScenePara = (p: string) => p.split("\n").some((ln) => isSceneBlockLine(ln));
  // P7-F 段落感知：同 clampAvgSentenceLenUnder25，避免 splitSentences→join 合并段落
  const result = !text.includes("\n\n")
    ? boostBurstinessInBlock(text, rng, targetCv, maxCuts)
    : text
        .split(/\n\n+/)
        .map((p) => (isScenePara(p) ? p : boostBurstinessInBlock(p, rng, targetCv, maxCuts)))
        .join("\n\n");
  // v0.8.4 兜底清扫：管线里 IfLow 会被多次调用（朱雀增强 + P5 清尾），跨调用仍可能
  // 拼出「哦。哦。」「是啊。是啊。」式相邻极短句复读——复读本身就是机器指纹
  // （fingerprintCheck 垫词复读同类项），逐字符统计类特征一抓一个准。相邻同串只留一个。
  return result.replace(/([\u4e00-\u9fa5]{1,4}[。！？])(?:\s*)\1+/g, "$1");
}

function boostBurstinessInBlock(
  text: string,
  rng: () => number,
  targetCv: number,
  maxCuts: number,
): string {
  if (maxCuts <= 0) return text;
  let working = text;
  const ULTRA_SHORT_ANCHORS = [
    "对哦。",
    "嗯。",
    "嗨。",
    "好吧。",
    "行。",
    "是啊。",
    "诶。",
    "咳。",
    "哦。",
    "啊。",
    "呵。",
    "啧。",
    "呣。",
  ];
  // v0.8.4 反堆叠：同一句只塞一次锚、锚点同块去重、总量封顶。
  // 依据（multi-case 实测病句）：CV 追不上目标时循环对同一句反复塞锚，
  // 拼出「数字化转型行对哦诶啊嗯呵呣啧」这类粒子串、句尾挂出「是啊。是啊。」——
  // 语气词复读本身就是新的机器指纹（fingerprintCheck 的垫词复读同类项），
  // 比低 CV 危害更大：宁可少塞锚没达标，也不产出可被统计抓到的复读串。
  const ANCHOR_TAIL_RE = /(?:对哦|是啊|好吧|[嗯嗨诶咳呵啧呣哦啊行])[。！？!?…]*$/;
  // 独立语气锚句（跨调用堆积判定用）
  const ANCHOR_STANDALONE_RE = /^(?:对哦|是啊|好吧|[嗯嗨诶咳呵啧呣哦啊行])[。！？!?…]*$/;
  // v0.9 专家修复 P3：锚点单块封顶 4→2；且块内已有任意语气锚（独立句或句尾缀）
  // 时本调用直接跳过——最终 boost 在多注入器之后运行，不查存量会把每段
  // 都挂上「呵。」「啧。」成串（专家实测 0.9 档每段堆积 2-4 条）。
  const ANCHOR_CAP = Math.min(2, Math.max(1, Math.ceil(maxCuts / 4)));
  const alreadyHasParticle = splitSentences(text).some(
    (x) => ANCHOR_STANDALONE_RE.test(x.trim()) || ANCHOR_TAIL_RE.test(x.trim()),
  );
  if (alreadyHasParticle) {
    // v0.9 专家修复 P3 长尾：块内已有语气锚时不再灌锚，但也不能直接躺平——
    // 旧引擎正是靠「啧。」堆积把 CV 顶过线，砍掉灌水后必须有替代手段。
    // 降级为「纯切句」增强：长句在守卫通过的逗号处切两半，既提 CV 又降 avgLen，
    // 且不引入任何新注入痕迹。
    // v0.9.2 修复：直接 return 切句结果而非提前退出——原版「已有锚就整块跳过」
    // 导致 0.6 档 CV 不达标时无兜底（scan-bugs v5.3 实测 6 次节奏过平）。
    return boostBurstinessByCutting(working, targetCv, Math.min(maxCuts, 6));
  }
  const usedAnchors = new Set<string>();
  const endsWithParticle = (s: string) => ANCHOR_TAIL_RE.test(s.trim());
  let injected = 0;
  for (let attempt = 0; attempt < maxCuts && injected < ANCHOR_CAP; attempt++) {
    const cur = sentenceStats(working);
    if (cur.cv >= targetCv) break;
    const sents = splitSentences(working);
    // P5-B 放宽切句门槛 L≥10（原为 14），D2 对话体有更多中等句可供"塞极短锚"
    const withIdx = sents
      .map((s, i) => ({
        s,
        i,
        L: s.replace(/[\s。！？!?…—\-，、；：""''「」（）《》【】]/g, "").length,
      }))
      .filter((x) => x.L >= 10 && !endsWithParticle(x.s));
    if (withIdx.length < 1) break;
    withIdx.sort((a, b) => b.L - a.L);
    // 优先切第 2/3 长句，避免同一句反复切
    const choice =
      withIdx.length >= 3
        ? withIdx[Math.floor(rng() * 3)]
        : withIdx.length >= 2
          ? rng() < 0.5
            ? withIdx[0]
            : withIdx[1]
          : withIdx[0];
    const target = choice;
    const fresh = ULTRA_SHORT_ANCHORS.filter((a) => !usedAnchors.has(a));
    if (!fresh.length) break;
    const anchorFull = fresh[Math.floor(rng() * fresh.length)];
    usedAnchors.add(anchorFull);
    const raw = target.s;
    let insertAt = raw.length;
    let anchor = anchorFull;
    const lastCh = raw[raw.length - 1] || "";
    // v0.8.5 语体守卫：插入点前若是书面抽象名词或"的"字结构，
    // 语气词缀在名词后形成「行业呀。」「本质嗯。」「本质行。」式语体错位
    //（书面语体 + 口语语气词相接，探针与真人阅读都可感知）——跳过此句。
    // 对有/无句末标点两种情况都生效：剥句号内插与整锚拼接效果等同。
    const before = raw.slice(0, insertAt).replace(/[。！？!?…]$/, "");
    if (
      /[\u4e00-\u9fa5]{0,3}(行业|趋势|教育|技术|发展|本质|方案|融合|转型|体系|机制|模式|能力|水平|质量|效率|价值|意义|作用|目标|战略|格局|态势|工艺|封装|架构|材料|器件|电路|制程|节点|性能|功耗|良率|产能|百分点|万亿元|亿美元|亿元|美元|缺口|占比|增速|规模)$/.test(
        before,
      ) ||
      /的$/.test(before)
    ) {
      continue;
    }
    if ("。！？!?…".includes(lastCh)) {
      // v0.9 专家修复 P3 长尾：问句前禁挂语气锚——「不信嗯？」是抽风式语体错位；
      // 问句自带节奏突变（短+？），无需锚点也贡献 CV
      if (lastCh === "？" || lastCh === "!") continue;
      // 插在句末标点之前时必须去掉锚点自带的句号，否则拼出"。。"
      //（multi-case 实测病句：「挑战哈对哦。啊。。就这样。」）
      insertAt = raw.length - 1;
      anchor = anchorFull.replace(/。$/, "");
    }
    const newStr = raw.slice(0, insertAt) + anchor + raw.slice(insertAt);
    sents[target.i] = newStr;
    working = sents.join("");
    injected++;
  }
  // P5-B 兜底：循环塞完仍 < targetCv → 在文本末尾硬挂 1~2 条独立极短句（暴力双峰：正常20字 vs 1字）
  //        仅用于 D2 这类"中等句多、CV 天生稳"的体裁
  const tailCheck = sentenceStats(working);
  if (tailCheck.cv < targetCv && injected < ANCHOR_CAP + 1) {
    const needMore = targetCv - tailCheck.cv;
    const tails = needMore > 0.04 ? 2 : 1;
    let extra = "";
    for (let i = 0; i < tails; i++) {
      // 同块去重：老实现两次随机可抽中同一锚，挂出「是啊。是啊。」复读串
      const fresh = ULTRA_SHORT_ANCHORS.filter((a) => !usedAnchors.has(a));
      if (!fresh.length) break;
      const a = fresh[Math.floor(rng() * fresh.length)];
      usedAnchors.add(a);
      // 跨调用防复读：IfLow 在管线里会被调用多次（朱雀增强 + P5 清尾），每次调用
      // 的 usedAnchors 都是新建的——上一调用可能已在本块尾挂过同一锚。不依赖
      // 调用内状态，直接实测文本尾：尾端已有同核锚点就跳过这个候选。
      const core = a.replace(/。$/, "");
      if (new RegExp(core + "[。！？!?…]\\s*$").test(working.replace(/\s+$/, ""))) continue;
      extra += a;
    }
    if (extra) {
      // 末尾是句末标点就直接挂；弱标点（逗号/顿号等）先升级成句号再挂，
      // 否则拼出"，。"（multi-case 实测病句：「拉动可持续发展，。说到底」）
      const trimmed = working.replace(/\s+$/, "");
      if (/[。！？!?…]$/.test(trimmed) || trimmed.length === 0) working = trimmed + extra;
      else if (/[，、；：,]$/.test(trimmed))
        working = trimmed.replace(/[，、；：,]$/, "。") + extra;
      else working = trimmed + "。" + extra;
    }
  }
  // v0.9 专家修复 P3 长尾：锚灌注受限（CAP/语体守卫）后 CV 仍不达标 → 纯切句补刀。
  // 切长句零注入痕迹：句长方差上升、avgLen 下降，是节奏兜底的无指纹手段。
  const finalCheck = sentenceStats(working);
  if (finalCheck.cv < targetCv) {
    working = boostBurstinessByCutting(working, targetCv, Math.max(3, Math.floor(maxCuts / 2)));
  }
  return working;
}

/**
 * v0.9 专家修复 P3 长尾：纯切句式 burstiness 增强（零注入）。
 * 块内已有语气锚时用它替代锚点灌注：在守卫全部通过的逗号/分号处把最长句
 * 切成两句——句长方差自然上升、avgLen 同步下降，且不引入任何「呵。啧。」
 * 式新指纹。切点判定复用 findSplitPoint（含括号/状语/光杆谓词全套守卫）。
 * v0.9.2 导出：主流程 cap2 收口后用它兜底（锚灌注与删锚拉锯的死结解法）。
 */
export function boostBurstinessByCutting(text: string, targetCv: number, maxCuts: number): string {
  if (maxCuts <= 0) return text;
  let working = text;
  for (let c = 0; c < maxCuts; c++) {
    const cur = sentenceStats(working);
    if (cur.cv >= targetCv) break;
    const sents = splitSentences(working);
    // 候选：长度 ≥ 22 的长句（切成两半各 ≥ 10，方差贡献最大）
    const ranked = sents
      .map((s, i) => ({
        i,
        s,
        L: s.replace(/[\s。！？!?…—\-，、；：""''「」（）《》【】]/g, "").length,
      }))
      .filter((x) => x.L >= 22)
      .sort((a, b) => b.L - a.L);
    if (ranked.length === 0) break;
    const t = ranked[0];
    // v0.9.2：标准 30%~70% 区间切不动时，给「说起来，……」类插入语引导的长句开一条后路。
    // 起因是 scan-bugs v5.3 seed=28 实测：这类句子首个逗号在句长 15% 附近，标准区间
    // 排除它，于是全部句子均匀中长时一刀也切不了。
    //
    // v0.9.14 修正（原实现是病句发生器）：原注释写着"放宽区间仍走全套守卫，不会切出残句"，
    // 但代码其实是 `mid = firstComma` 一刀裸切，**没有任何守卫**——「总的来看，数字化办公…」
    // 被切成 4 字光杆孤句「总的来看。」，下游 fixOrphanConnectiveLeads 再把它向左粘回上一句尾部，
    // 产出「…AI 写作工具跟着就来了，总的来看。」这种句末悬空连接词病句
    // （UI 示例文本实测 102/280 次运行 = 36.4%，强度 0.55 起）。
    // 现在切点一律落在插入语**之后**，把插入语并入前半句，且走 findGuardedCutNear 的全套守卫。
    let mid = findSplitPoint(t.s, 22);
    if (mid === -1 && /^(?:说起来|归结起来|一句话概括|总的来说|总的来看|说到底|有意思的是|值得注意的是|要我说|说白了|按我的经验)/.test(t.s.trim())) {
      const fc = t.s.indexOf("，"); // 插入语边界，绝不允许当切点
      const sc = fc === -1 ? -1 : fc + 1 + t.s.slice(fc + 1).indexOf("，");
      if (sc > fc) {
        const cand = findGuardedCutNear(t.s, sc);
        if (cand > fc) mid = cand;
      }
    }
    if (mid === -1) {
      // 最长句无可守卫切点 → 尝试次长句（最多看 3 条）
      let cut = -1;
      let pickIdx = -1;
      for (let k = 1; k < Math.min(3, ranked.length); k++) {
        const m2 = findSplitPoint(ranked[k].s, 22);
        if (m2 !== -1) {
          cut = m2;
          pickIdx = k;
          break;
        }
      }
      if (pickIdx === -1) break;
      const tk = ranked[pickIdx];
      sents[tk.i] = tk.s.slice(0, cut).trim() + "。";
      sents.splice(tk.i + 1, 0, tk.s.slice(cut + 1).trim());
    } else {
      sents[t.i] = t.s.slice(0, mid).trim() + "。";
      sents.splice(t.i + 1, 0, t.s.slice(mid + 1).trim());
    }
    working = sents.join("");
  }
  // v0.9.8 P0 修复：废除「切无可切 → 相邻句合并」兜底（原 v0.9 专家修复 P3 终段）。
  //
  // 原实现（保留注释备查）：
  //   if (cutsDone === 0) {
  //     while (merged < 2 && sentenceStats(working).cv < targetCv) {
  //       ...把两个句号句并为一个逗号长复句...
  //     }
  //   }
  //
  // 废除理由一（根因与 boostBurstinessIfLow / boostBurstinessFragments 完全相同）：
  //   它唯一的存在目的是把 CV 抬到 targetCv。而标尺 v0.9.6 已删除 burstiness 反向项
  //   （实测 CV 判别力≈0 且方向反：人写口语随笔 CV=0.27 是全场最低）。
  //   为已废除的指标服务的手段，只会制造新标尺要抓的污染。
  //
  // 废除理由二（确定性破坏作者结构，证据 scripts/_shape.ts）：
  //   同一段文本「3 个 20+ 字句」，单段调用时不触发（0.3~0.9 档均保持 3 句），
  //   但在多段调用（NARR_MULTI 等）下 0.5 档起稳定被焊成 1 句——
  //   因为逐段调用时 sentenceStats 的 CV 基准变小，更容易落到 cutsDone===0 分支。
  //   实测影响面（scripts/_merge_impact.ts，0.9 档）：论说最大损失 2 句、人写 1 句。
  //   句子边界是作者的语气与节奏表达（「…汤。我…」焊成「…汤，我…」改变语气），
  //   且丢失断句信息 —— humanize 的职责是去 AI 味，不是重写作者的断句。
  //
  // 废除理由三（函数名自反）：函数叫 ByCutting（切分），内部却做合并；
  //   而真正的切分手段（findSplitPoint + fragmentCanStand 全套守卫）已在上面跑完，
  //   切不动说明"这些话本就不该被切"（守卫否决是有意的设计），不该反手焊回去。
  //
  // 代价评估：去掉后 CV 可能偏低（部分文本），但标尺不再考核该指标，
  //   且 clampAvgSentenceLenUnder25 / 结构层仍各自负责句长与骨架，不产生功能缺口。
  return working;
}

/** P3-4 第一人称判断锚点：全文本按字数扫，每 300 字 ≥ 1 处。
 *  优先插在「报告显示/数据表明/高达…」之后，给"冰冷学术腔"注入主观视角。
 *
 *  ⚠️ v0.9.5 起只注入「主观判断」，不再注入「具体经历」。
 *  原实现（"我去年在老东家…""我之前查过一份内部纪要…""这块我自己上手试过…"）会
 *  静默替用户捏造可被证伪的事实主张——读者与审稿人会认为作者真的做过这些事。
 *  这与 README 的「严禁编造铁律」（LLM 通道：不得引入原文没有的人物、经历、案例、数据）
 *  直接冲突，且用户无从察觉，属法律风险而非风格问题。 */
export function injectFirstPersonAnchorPoints(
  text: string,
  rng: () => number,
  intensity: number,
): string {
  if (intensity < 0.85) return text;
  const chars = text.replace(/\s/g, "").length;
  const targetCount = Math.max(1, Math.floor(chars / 300));
  if (chars < 200) return text;

  const DATA_MARK =
    /(报告显示|数据显示|白皮书显示|调研显示|研究表明|数据表明|占比|同比|达到了|高达|根据[《\w].*?显示)/;
  // 只表达主观看法，不声称任何具体经历/资历/资料来源（无法被证伪为假）
  const ANCHORS = [
    "我个人觉得这块的门槛比看上去高。",
    "要我说，纸面数字和实际落地之间通常还隔着一段。",
    "这点我持保留意见，具体到每个团队差别可能很大。",
    "我的看法是，这类结论得配合场景看，单看数字容易误判。",
    "我觉得口径一变，结论可能完全反过来。",
    "在我看来，这部分最容易被想当然。",
  ];

  const allSents = splitSentences(text);
  const goodSlots: number[] = [];
  for (let i = 0; i < allSents.length - 1; i++) {
    if (DATA_MARK.test(allSents[i])) goodSlots.push(i + 1);
  }
  if (goodSlots.length < targetCount) {
    const step = Math.max(2, Math.floor(allSents.length / (targetCount + 1)));
    for (let k = step; k < allSents.length - 1 && goodSlots.length < targetCount; k += step) {
      if (!goodSlots.includes(k)) goodSlots.push(k);
    }
  }
  if (goodSlots.length === 0) return text;
  for (let i = goodSlots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [goodSlots[i], goodSlots[j]] = [goodSlots[j], goodSlots[i]];
  }
  const useSlots = goodSlots.slice(0, targetCount).sort((a, b) => a - b);

  const out: string[] = [];
  for (let i = 0; i < allSents.length; i++) {
    out.push(allSents[i]);
    if (useSlots.includes(i)) out.push(pick(rng, ANCHORS));
  }
  return out.join("");
}

/* =========================================================
   preDetectHumanFingerprint：纯人写原稿预检（修复"H0→H1/H2越去味越差"负收益）
   命中标准（满足 ≥3/5 → 判定为"原稿本身已高真人味，heavy 反检测会引入机改痕迹"）：
     ① 句长 burstiness（CV）≥ 0.90   （真人句长波动大，AI 通常 <0.6）
     ② 错字/别字命中 ≥ 1 处 / 千字   （真人有手滑错字，AI 几乎 0）
     ③ 口语短句（≤8字）占比 ≥ 25%     （真人短问句/感叹句密，AI 稀）
     ④ 段首句长 CV ≥ 0.5            （真人段首参差不齐，AI O3=0）
     ⑤ 第一/第二人称密度 ≥ 3 处/千字
   命中 → 关掉 injectHumanTypos + injectSelfQA + 降低结构级 intensity 0.7→0.5
   ========================================================= */

export interface HumanFingerprintReport {
  isHumanHand: boolean;
  hits: number;
  metrics: {
    burstiness: number;
    typosPerK: number;
    shortRatio: number;
    paraLeadCV: number;
    personPronPerK: number;
  };
}

const TYPOS_HAND = [
  "在做",
  "再做",
  "坐好",
  "座好",
  "哪为",
  "那为",
  "以经",
  "已经",
  "既使",
  "即使",
  "按装",
  "安装",
  "好象",
  "好像",
  "做为",
  "作为",
  "的到",
  "得到",
  "想同",
  "相同",
  "到理",
  "道理",
];

/* 2026-08-26 v2 P3 体裁门控：论说文结构拆毁(P3-1~P3-4)只对「明确判定为论说/职场报告」的文本应用，
   避免叙事文「时间/空间推进句」被当三部曲拆、对话体「职场周会条例」被 P3-3/P3-4 误伤导致 aiScore 反涨。
   返回：exposition 概率 0~1，≥ 0.55 才允许 P3-结构改动介入 */
const EXPO_MARKERS_STRONG = [
  "综上所述",
  "基于以上分析",
  "研究表明",
  "数据显示",
  "白皮书显示",
  "报告显示",
  "调查数据显示",
  "调研显示",
  "统计结果表明",
  "根据相关调研",
  "占GDP",
  "万亿元",
  "百分点",
  "同比增长",
  "环比增长",
  "复合增长率",
  "研发投入",
  "战略布局",
  "国民经济",
  "核心增长引擎",
  "人才缺口",
];
const EXPO_MARKERS_WEAK = [
  "首先",
  "其次",
  "再次",
  "最后",
  "具体来说",
  "值得注意的是",
  "更重要的是",
  "一方面",
  "另一方面",
  "第一",
  "第二",
  "第三",
];
const DIALOGUE_MARKERS_RE =
  /【场景[：:]?|【.*?】|(?:^|\n)[^\n]{1,12}（[^\n]{0,12}）[：:]|(?:^|\n)[^\n]{1,12}[总工程前技产品运营]：/gm;
const NARRATIVE_TENSE_MARKERS = [
  "那天",
  "那年",
  "周末",
  "早晨",
  "中午",
  "晚上",
  "路上",
  "我走进",
  "我来到",
  "我选了",
  "我点了",
  "我坐",
  "我看到",
  "我走到",
  "临走前",
  "回到家",
];

/** 论说文概率分：0=完全非论说，1=标准论说文/报告。≥0.55 → 允许 P3 结构拆毁 */
export function classifyExpositionScore(text: string): number {
  if (!text || text.trim().length < 40) return 0;
  const chars = text.replace(/\s/g, "").length;
  const k = Math.max(0.4, chars / 1000);
  let score = 0;

  // A. 论说强/弱词命中密度
  let strong = 0;
  for (const m of EXPO_MARKERS_STRONG) strong += countSubstr(text, m);
  let weak = 0;
  for (const m of EXPO_MARKERS_WEAK) weak += countSubstr(text, m);
  score += Math.min(0.55, (strong * 0.18 + weak * 0.06) / k);

  // B. 对话体负特征：【场景】+「XX（角色）：」模式 → 惩罚分
  const dialogueHits = (text.match(DIALOGUE_MARKERS_RE) || []).length;
  if (dialogueHits >= 2) score -= 0.45;
  else if (dialogueHits === 1) score -= 0.2;
  // C. 引号/冒号口语对白密度
  const colonQuoteHits = (text.match(/[“"「][^」”"]{2,40}[”"」][，。！？]?/g) || []).length;
  if (colonQuoteHits >= 3) score -= 0.2;

  // D. 叙事文负特征：个人经历时空词
  let narrative = 0;
  for (const m of NARRATIVE_TENSE_MARKERS) narrative += countSubstr(text, m);
  if (narrative >= 3) score -= 0.35;
  else if (narrative >= 1) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}
function countSubstr(s: string, sub: string): number {
  if (!sub) return 0;
  let n = 0,
    idx = 0;
  while ((idx = s.indexOf(sub, idx)) !== -1) {
    n++;
    idx += sub.length;
  }
  return n;
}

export function preDetectHumanFingerprint(text: string): HumanFingerprintReport {
  if (!text || text.trim().length < 50) {
    return {
      isHumanHand: false,
      hits: 0,
      metrics: { burstiness: 0, typosPerK: 0, shortRatio: 0, paraLeadCV: 0, personPronPerK: 0 },
    };
  }
  const stats = sentenceStats(text);
  const sents = splitSentences(text);
  const chars = text.replace(/\s/g, "").length;
  const k = chars / 1000;

  let typos = 0;
  for (const w of TYPOS_HAND) if (text.includes(w)) typos++;
  const typosPerK = typos / Math.max(0.5, k);

  const shortCnt = sents.filter((s) => s.replace(/\s/g, "").length <= 8).length;
  const shortRatio = sents.length ? shortCnt / sents.length : 0;

  const paras = text.split(/\n+/).filter((p) => p.trim().length > 5);
  const firstLens: number[] = [];
  for (const p of paras) {
    const f = splitSentences(p)[0];
    if (f) firstLens.push(f.replace(/\s/g, "").length);
  }
  let paraLeadCV = 0;
  if (firstLens.length >= 2) {
    const m = firstLens.reduce((a, b) => a + b, 0) / firstLens.length;
    const s = Math.sqrt(firstLens.reduce((acc, n) => acc + (n - m) ** 2, 0) / firstLens.length);
    paraLeadCV = m ? s / m : 0;
  }

  const pronMatches = text.match(/[我你咱俺咱们咱的人家您各位大伙大伙儿]/g) || [];
  const personPronPerK = pronMatches.length / Math.max(0.5, k);

  /* 2026-08-26 v2 预检分层校准
     【H0 纯人写原稿】特征：短占比 10%，leadCV=0.38，人称密度极高(66处/千字)，typos=2 —— 命中 → 降级
     【N3/D3 叙事对话朱雀档】特征：人称密度极高(97/95)，但段首 CV=0（去味引擎已经把段首打平了）—— 这是"已经去过味的产物"，放过继续反检测
     【O1 论说原文】特征：人称61，short=0，leadCV=0.09 —— 放过，允许被改造
     关键：加 personPronPerK ≥ 50（高人称密度特征）+ leadCV≥0.25（段首参差，即非机切段首）+ shortRatio ≥ 0.08 三条同时命中 → H0 才命中 */
  const branchA = personPronPerK >= 50 && paraLeadCV >= 0.25 && shortRatio >= 0.08;
  // 分支 B：没有这么高的人称密度，但在其他维度"明显像人"
  const branchB =
    paraLeadCV >= 0.3 &&
    shortRatio >= 0.2 &&
    typosPerK >= 1.5 &&
    personPronPerK >= 3 &&
    personPronPerK <= 40;
  const isHumanHand = branchA || branchB;

  let hitsLoose = 0;
  if (stats.cv >= 0.75) hitsLoose++;
  if (typosPerK >= 0.5) hitsLoose++;
  if (shortRatio >= 0.15) hitsLoose++;
  if (paraLeadCV >= 0.35) hitsLoose++;
  if (personPronPerK >= 2 && personPronPerK <= 40) hitsLoose++;

  return {
    isHumanHand,
    hits: Math.max(hitsLoose, isHumanHand ? 3 : 0),
    metrics: {
      burstiness: Number(stats.cv.toFixed(2)),
      typosPerK: Number(typosPerK.toFixed(2)),
      shortRatio: Number(shortRatio.toFixed(2)),
      paraLeadCV: Number(paraLeadCV.toFixed(2)),
      personPronPerK: Number(personPronPerK.toFixed(1)),
    },
  };
}

/* =========================================================
   公共 API
   ========================================================= */

export function crossChunkCleanup(text: string, stripCJKSpaces = false): string {
  let out = text;
  out = dedupePadWords(out);
  out = dedupeStarters(out);
  out = limitPunctuation(out, "——", 1, "，");
  out = limitPunctuation(out, "……", 1, "。");
  out = stripLeadingConnectivesHard(out);
  out = stripAICliches(out);
  out = stripCJKEdgeSpaces(out, stripCJKSpaces);
  return out;
}

export function mechanicalShuffle(text: string, opts: HumanizeOptions = {}): string {
  const style = opts.style ?? "plain";
  if (!text || !text.trim()) return "";

  // P7-extra 引擎级体裁联动（与 humanize() 同一套旋钮语义，独立调用入口也生效）：
  //  · humanHand → 强度钳制 ≤0.48、关错别字/第一人称锚点、跳过场景块自问自答
  //  · main + 强度≥0.75 → expoForceP3 强制开 P3（覆盖 expoScore 略低于 0.55 的边缘论说文）
  //  · dialogue → 剧本【场景/人物/背景】块跳过自问自答
  const genreKnob = opts.genre ?? classifyGenre(text).genre;
  const isHumanHandGenre = genreKnob === "humanHand";
  const isDialogueGenre = genreKnob === "dialogue";

  // 2026-08-26 v2：真人指纹预检。命中 → 降级，修复"H0→H1/H2越去味越差"
  const zhuqueBoost = (opts.zhuqueMode ?? false) && !isHumanHandGenre;
  const finger = preDetectHumanFingerprint(text);
  const baseIntensity = Math.max(0, Math.min(1, opts.intensity ?? 0.3));
  let intensity = baseIntensity;
  let disableTypos = false;
  let disableFirstPerson = false;
  if (finger.isHumanHand || isHumanHandGenre) {
    intensity = Math.min(intensity, 0.48);
    disableTypos = true;
    disableFirstPerson = true;
  }
  const rng = makeRng(opts.seed);
  // 2026-08-26 v2 P3：体裁预检（论说文才上 P3-1~P3-4）
  //   P7-B：显式 genre==main 且强度≥0.75 时放宽到 expoScore≥0.35（强制覆盖边缘论说文）
  const textExpoScore = classifyExpositionScore(text);
  const applyExpoP3 =
    zhuqueBoost &&
    (genreKnob === "main" && intensity >= 0.75 ? textExpoScore >= 0.35 : textExpoScore >= 0.55);
  // zhuqueBoost → 论说锚点(P3-4)、段首方差(P3-3)要求强度≥0.85，把用户传 0.7 自动升档到 0.9
  const effAnchorIntensity = applyExpoP3 ? Math.max(intensity, 0.9) : intensity;

  // P8 场景块全格式保真：relax 段按行护盾——relaxColon 会把【场景：…】改成【场景，…】
  const relaxLine = (ln: string): string => {
    if (isSceneBlockLine(ln)) return ln;
    let w = relaxEmDash(ln, rng, 0.4 * intensity);
    w = relaxDunhao(w, rng, 0.4 * intensity);
    w = relaxColon(w, rng, 0.3 * intensity);
    w = relaxQuotes(w, rng, 0.25 * intensity);
    w = splitOnConnectors(w, rng, 0.25 * intensity);
    return w;
  };
  let working = text.split("\n").map(relaxLine).join("\n");
  if (intensity >= 0.5) {
    working = working
      .split(/\n\n+/)
      .map((p) => {
        const s = structuralShuffleParagraph(p, rng, intensity, {
          zhuqueMode: zhuqueBoost,
          // P7-B/P7-E：体裁联动参数透传给结构层
          expoForceP3: applyExpoP3,
          skipSceneInject: isDialogueGenre,
          // v0.9 专家修复 P5：文风透传（academic 禁口语承接头/自问自答）
          style,
        });
        // P3-3 段首句长硬方差（仅论说文，避免对话体/叙事文体被硬切段首 → AI 特征反涨）
        if (applyExpoP3) return enforceParagraphLeadSentVariance(s, rng, intensity);
        return s;
      })
      .join("\n\n");
  }
  working = dedupePadWords(working);
  working = dedupeStarters(working);
  working = limitPunctuation(working, "——", 1, "，");
  working = limitPunctuation(working, "……", 1, "。");
  working = boostBurstiness(working, rng, 0.6 * intensity, style);
  working = varyParagraphs(working, rng, 0.5 * intensity);
  working = resegmentParagraphsAggressive(working, rng, intensity);
  // v2 P3-3：段首句长硬方差（跨段全局二次，激进版）→ 仅论说文
  if (applyExpoP3) {
    working = enforceParagraphLeadSentVariance(working, rng, intensity);
  }
  working = stripLeadingConnectivesHard(working);
  working = stripAICliches(working);
  working = stripCJKEdgeSpaces(working, opts.stripCJKSpaces ?? false);
  working = reframeConcessives(working, rng, Math.min(1, 0.5 + 0.5 * intensity));
  working = injectHalfWidth(working, rng, 0.04 * intensity);
  // v2 P3-4：第一人称经验锚点（真人原稿禁用 + 只限论说文，避免叙事/对话再塞第一人称变成重复 → aiScore 反涨）
  if (!disableFirstPerson && applyExpoP3) {
    working = injectFirstPersonAnchorPoints(working, rng, effAnchorIntensity);
  }
  // v3 P4-B：burstiness<目标值时，针对最长句在逗号中点处切段、注入"不过话说/讲真…"类超短句锚，快速拉 CV 到目标档
  //        （对叙事/对话档特别有用，N2=0.53、D2=0.49 均低于阈值）
  //   P7-C：按体裁分档 burst 目标（论说0.63 / 叙事0.59 / 对话0.57 / 人写0.50），人写档最松防负斜率反噬
  if (intensity >= 0.4) {
    const burstTarget =
      genreKnob === "main" ? 0.63 : genreKnob === "narrative" ? 0.59 : isDialogueGenre ? 0.57 : 0.5;
    working = boostBurstinessIfLow(
      working,
      rng,
      Math.max(MIN_BURSTINESS_CV, burstTarget),
      4,
      style,
    );
  }
  // v3 P4-A + 二次标点保险：最终清尾确保整篇「——」≤1、「……」≤1，解决 N2/D2 指纹检测红项
  working = limitPunctuation(working, "——", 1, "，");
  working = limitPunctuation(working, "……", 1, "。");
  working = ensureEmDashCountHardCap(working, 1);
  // v0.8 P2-1：错别字（真人原稿禁用）
  if (!disableTypos) {
    working = injectHumanTypos(working, rng, intensity);
  }
  return working
    .replace(/—{3,}/g, "——")
    .replace(/——(?=[。！？!?])/g, "")
    .replace(/(^|\n)\s*[。，、；：]+/g, "$1")
    .replace(/但，/g, "但")
    .replace(/([，、])\1+/g, "$1")
    .replace(/，。/g, "。")
    .replace(/。，/g, "。")
    .trim();
}

// 对外导出：humanize.ts 核心引擎会直接导入这些函数
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
  // 注：dismantleExpositionTrilogy / hardNumberedEnumerationShuffle / enforceParagraphLeadSentVariance
  //     / injectFirstPersonAnchorPoints / preDetectHumanFingerprint / classifyExpositionScore
  //     / ensureEmDashCountHardCap / boostBurstinessIfLow
  //   以上函数均在定义时以 `export function xxx(...)` 形式导出，无需再列；双写会导致 Multiple exports 错误
};
