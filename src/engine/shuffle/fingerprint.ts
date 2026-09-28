/**
 * 机械扰动层 · 真人指纹预检 + 论说文体裁分（自 humanize-shuffle.ts 拆出，逐字搬移）。
 * 导入面兼容由 ../humanize-shuffle.ts 门面统一 re-export。
 */
import { splitSentences, sentenceStats } from "../humanize-data.ts";

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
