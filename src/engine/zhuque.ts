/**
 * 趣AI味 · 朱雀检测（本地近似实现，非官方）
 *
 * 说明（务必先读）：这是**照着腾讯朱雀大模型检测（matrix.tencent.com/ai-detect）对外表现形态**
 * 做的一个本地近似器，不是朱雀本体，也不可能复刻——朱雀是混元大模型驱动的服务，
 * 模型权重与线上策略均不公开。本模块零联网、零依赖、浏览器里毫秒级出结果。
 *
 * 对齐官方的 6 个口径：
 *  1. 三档占比：人工特征（绿）/ 疑似AI（黄）/ AI特征（红），按字符数统计占比；
 *  2. 官方核心指标是「AI 特征占比」（百分比，两位小数），>60% 高风险、<20~30% 相对安全；
 *  3. 段落/句级红色高亮标注可疑位置（官方红=AI特征，本实现黄=疑似AI一并标出）；
 *  4. 门槛：文本 ≥350 字（低于此官方不可靠/拒检），单次建议 ≤2000 汉字；
 *  5. 通俗提示语（"AI味有点重" / "未检测到AI生成痕迹" 等）；
 *  6. 官方宣称从 12 个维度提取特征（词汇分布、句法结构、语义连贯性与隐层特征等），
 *     本实现给出 12 个可解释的统计维度（隐层特征无法复现，故为近似）。
 *
 * 诚实边界：占比与官方分不是同一把尺子。官方结果可通过 UI 回填，
 * 由 calibration 做「本地分 → 官方分」的线性校准，样本越多越贴近。
 */

import {
  PPL_MIN_MEAN_NLL,
  PPL_MAX_WIN_STD,
  PPL_MIN_CHARS,
  PPL_MIN_WINDOWS,
} from "./humanize-metrics";
// v0.8.5：四套词表收拢到 zhuque-lexicon.ts 共享（与 detector.ts 同一把词汇尺，防漂移）
import { FORMULAIC, OFFICIAL, SKELETON, CONNECTIVES } from "./zhuque-lexicon";

/* ----------------------------- 类型 ----------------------------- */

/** 三档标签，与官方语义对齐 */
export type ZhuqueLabel = "human" | "suspected" | "ai";

export const LABEL_TEXT: Record<ZhuqueLabel, string> = {
  human: "人工特征",
  suspected: "疑似AI",
  ai: "AI特征",
};

/** 高亮片段（句级或连续同档句合并） */
export interface ZhuqueSpan {
  /** 在原文中的字符起止（用于高亮） */
  start: number;
  end: number;
  text: string;
  /** 该片段 AI 风险 0~100 */
  risk: number;
  label: ZhuqueLabel;
  /** 命中原因（人话） */
  reasons: string[];
}

export interface ZhuqueRatios {
  /** 人工特征占比 % */
  human: number;
  /** 疑似AI 占比 % */
  suspected: number;
  /** AI特征 占比 %（官方核心指标） */
  ai: number;
}

export interface ZhuqueFeature {
  name: string;
  /** 归一化 0~1，越高越像 AI */
  value: number;
  hint: string;
}

export interface ZhuqueReport {
  /** 三档占比（和为 100） */
  ratios: ZhuqueRatios;
  /** AI 特征占比（官方核心指标），两位小数 */
  probability: number;
  /** 综合 AI 度 = AI占比 + 0.5×疑似占比，用于定档；传入困惑度层时按 PPL_FUSE_WEIGHT 融合 */
  composite: number;
  label: ZhuqueLabel;
  labelText: string;
  /** 官方风格通俗提示语 */
  verdict: string;
  /** 置信度 0~100：字数达标且档位集中时更高 */
  confidence: number;
  /** 困惑度层结果（opts.ppl 未传/字数不足时为 null） */
  pplLayer: PplLayer | null;
  /** 全部标注片段（按原文顺序） */
  spans: ZhuqueSpan[];
  /** 风险最高的片段（最多 8 条） */
  topSpans: ZhuqueSpan[];
  /** 12 维特征 */
  features: ZhuqueFeature[];
  stats: {
    chars: number;
    sentences: number;
    aiChars: number;
    suspectedChars: number;
    aiSentences: number;
    avgLen: number;
  };
  warnings: string[];
  /** 是否满足官方送检门槛（≥350 字） */
  eligible: boolean;
  /** 已校准时给出的官方分估计（null=未校准，只有本地分） */
  officialEstimate: number | null;
}

/** 校准点：一次官方实测的「本地分 vs 官方分」 */
export interface CalibPoint {
  local: number;
  official: number;
  ts: number;
}

/** 线性校准 official ≈ a × local + b */
export interface Calibration {
  a: number;
  b: number;
  n: number;
  points: CalibPoint[];
}

/* ----------------------------- 常量：官方口径 ----------------------------- */

/** 官方最低字数门槛 */
export const ZHUQUE_MIN_CHARS = 350;
/** 官方单次建议上限（实测 2000 汉字以内最稳，超长走文档上传） */
export const ZHUQUE_SUGGEST_MAX = 2000;
/** 官方入口 */
export const ZHUQUE_URL = "https://matrix.tencent.com/ai-detect/";

/** 句级定档阈值：≥62 判 AI特征，≥38 判 疑似AI，否则人工特征。
 *  由 scripts/zhuque-smoke.ts 的 AI/真人对照样本标定：AI 论述文 AI特征占比应 >50%，
 *  口语真人稿应 <10%（朱雀官方对同类样本分别给 99.99% / 30% 上下）。 */
const TH_AI = 62;
const TH_SUSPECTED = 38;

/* ----------------------------- 词表 -----------------------------
 * 已收拢至 ./zhuque-lexicon.ts（FORMULAIC/OFFICIAL/SKELETON/CONNECTIVES 共享）。
 */

// 泛指主语（AI 爱写"我们/人们/大家"，真人常写"我/你+具体情境"）
const VAGUE_SUBJECT =
  /(我们每个人|我们应当|我们要|人们|大家|每个人|一个人|任何人都|双方均|各方应)/g;
const PERSONAL = /(我|我们|咱|你|您|我觉得|个人|身边|记得|那次|当时|小时候|昨天|上周|我家|朋友)/g;
const CONCRETE =
  /([0-9０-９]+[年月日%％元块个次万亿度公里分秒]|[一二三四五六七八九十百千万亿两几]{1,3}[块元个年月天次度岁遍]|[A-Za-z][A-Za-z0-9-]{2,}|第[一二三四五六七八九十]+[章节部])/g;
const NOMINAL_SUFFIX = /(性|化|度|感|力|型|式|机制|体系|格局|举措|效能|路径|维度|层面)$/;
const MODAL = /(应该|应当|必须|需要|有助于|意味着|表明|说明|能够|可以|我们要|既要|也要|不仅|而且)/g;
const IDIOM_LIKE = /[\u4e00-\u9fa5]{4}(?:、[\u4e00-\u9fa5]{4}){1,}/g;
// 真人痕迹：语气词、口癖、破折号省略号、口语短词
const COLLOQUIAL =
  /(吧|啊|呢|嘛|呗|啦|呗儿|说实话|其实|反正|倒是|压根|就这么|怎么说|那会儿|挺|贼|忒)/g;

/* ----------------------------- 工具 ----------------------------- */

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function norm(v: number, lo: number, hi: number, invert = false): number {
  const r = clamp01((v - lo) / (hi - lo || 1));
  return invert ? 1 - r : r;
}

function countHits(text: string, pats: string[]): number {
  let n = 0;
  for (const p of pats) {
    const m = text.match(new RegExp(p, "g"));
    if (m) n += m.length;
  }
  return n;
}

function countRe(text: string, re: RegExp): number {
  return (text.match(new RegExp(re.source, re.flags.replace("g", "") + "g")) || []).length;
}

interface Sent {
  text: string;
  start: number;
  end: number;
}

/** 切句并保留原文偏移，供高亮用 */
function splitSentences(text: string): Sent[] {
  const out: Sent[] = [];
  const re = /[。！？!?；;]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const seg = text.slice(last, m.index + 1);
    if (seg.replace(/[\s。！？!?；;，,、]/g, ""))
      out.push({ text: seg, start: last, end: m.index + 1 });
    last = m.index + 1;
  }
  const tail = text.slice(last);
  if (tail.trim()) out.push({ text: tail, start: last, end: text.length });
  return out;
}

function visibleLen(s: string): number {
  return s.replace(/\s/g, "").length;
}

/* ----------------------------- 句级打分（12 维） ----------------------------- */

interface SentenceScore {
  risk: number;
  reasons: string[];
}

function scoreSentence(s: string): SentenceScore {
  const reasons: string[] = [];
  let risk = 0;

  // 1. 套话/模板
  for (const p of FORMULAIC) {
    if (new RegExp(p).test(s)) {
      risk += 30;
      reasons.push("AI 套话/模板句");
      break;
    }
  }
  // 2. 公文黑话
  for (const p of OFFICIAL) {
    if (new RegExp(p).test(s)) {
      risk += 16;
      reasons.push("公文/黑话用词");
      break;
    }
  }
  // 3. 提纲骨架开头
  for (const p of SKELETON) {
    if (new RegExp("^\\s*" + p).test(s)) {
      risk += 28;
      reasons.push("提纲骨架开头");
      break;
    }
  }
  // 4. 书面连接词开头
  if (/^\s*(然而|因此|此外|与此同时|更重要的是|不仅如此|换言之|事实上|实际上)/.test(s)) {
    risk += 18;
    reasons.push("书面连接词开头");
  }
  // 5. 抽象名词/名物化
  if (/(性|化|度|机制|体系|格局)/.test(s) && visibleLen(s) > 22) {
    risk += 12;
    reasons.push("抽象名词堆砌");
  }
  // 6. 超长句
  const len = visibleLen(s);
  if (len >= 38) {
    risk += 14;
    reasons.push(`超长句（${len} 字）`);
  } else if (len >= 28) {
    risk += 6;
    reasons.push("偏长句");
  }
  // 7. 四字排比
  if (/[\u4e00-\u9fa5]{4}(?:、[\u4e00-\u9fa5]{4}){2,}/.test(s)) {
    risk += 14;
    reasons.push("四字排比");
  }
  // 8. 中英数字间空格（AI 语料指纹）
  if (/[\u4e00-\u9fa5][ \t]+[A-Za-z0-9]|[A-Za-z0-9][ \t]+[\u4e00-\u9fa5]/.test(s)) {
    risk += 12;
    reasons.push("中英间空格");
  }
  // 9. 判断句式收尾（是……的）
  if (/(是.*?的)[。！？!?；;]?\s*$/.test(s) && len > 20) {
    risk += 10;
    reasons.push("判断句式收尾");
  }
  // 10. 三段并列（既要…也要…）
  if (/(既要.{2,12}也要|不仅.{2,12}而且.{2,12}还|一方面.{2,12}另一方面)/.test(s)) {
    risk += 14;
    reasons.push("三段并列句式");
  }
  // 11. 泛指主语
  if (countRe(s, VAGUE_SUBJECT) > 0) {
    risk += 10;
    reasons.push("泛指主语（我们/人们）");
  }
  // 12. 情态词密集
  const modalHits = countRe(s, MODAL);
  if (modalHits >= 2) {
    risk += 8;
    reasons.push("情态词密集");
  }

  // —— 真人痕迹（减风险）——
  // 注意：泛指主语（我们要/人们/大家…）不算主观视角，AI 论述文里最常见，
  // 若这里减分会把典型 AI 句误判成真人句（实测踩到，故先判泛指再加减分）
  const vague = countRe(s, VAGUE_SUBJECT) > 0;
  if (!vague && countRe(s, PERSONAL) > 0) {
    risk -= 20;
    reasons.push("有第一人称/主观视角");
  }
  if (countRe(s, CONCRETE) > 0) {
    risk -= 12;
    reasons.push("有具体细节/数字");
  }
  if (countRe(s, COLLOQUIAL) > 0) {
    risk -= 10;
    reasons.push("有口语语气词");
  }
  if (len <= 12) {
    risk -= 16;
    reasons.push("短句（真人节奏）");
  }
  if (/[？?]/.test(s)) {
    risk -= 8;
    reasons.push("疑问句");
  }
  if (/[…—]/.test(s)) {
    risk -= 6;
    reasons.push("省略号/破折号");
  }

  return { risk: Math.max(0, Math.min(100, Math.round(risk + 22))), reasons };
}

function labelOfRisk(risk: number): ZhuqueLabel {
  return risk >= TH_AI ? "ai" : risk >= TH_SUSPECTED ? "suspected" : "human";
}

/* ----------------------------- 全文 12 维特征 ----------------------------- */

function featureList(text: string, sents: Sent[], chars: number): ZhuqueFeature[] {
  const per = (n: number) => (chars > 0 ? (n * 100) / chars : 0);
  const f: ZhuqueFeature[] = [];
  const push = (name: string, value: number, hint: string) =>
    f.push({ name, value: clamp01(value), hint });

  push(
    "词汇分布·套话密度",
    norm(per(countHits(text, FORMULAIC)), 0, 1.0),
    `每百字 ${per(countHits(text, FORMULAIC)).toFixed(2)} 处（值得注意的是/综上所述/赋能）`,
  );
  push(
    "词汇分布·公文黑话",
    norm(per(countHits(text, OFFICIAL)), 0, 2.0),
    `每百字 ${per(countHits(text, OFFICIAL)).toFixed(2)} 处（顶层设计/抓手/护城河）`,
  );
  // 句长节奏（v0.8.3 双判据）：CV 相对判据 + 句长标准差绝对判据（朱雀官方口径：
  // 实测 AI 文本句长标准差多落在 5~8 区间，humanize-metrics.fingerprintCheck 同款阈值）。
  // std 命中特征带时即使 CV 达标也按疑似 AI 计——CV 低≠安全，句长集中才是本质。
  const lens = sents.map((s) => visibleLen(s.text));
  const std = stdOf(lens);
  const cvVal = norm(cvOf(lens), 0.28, 0.62, true);
  const stdInBand = sents.length >= 6 && std >= 4.5 && std <= 8.5;
  push(
    "句法结构·句长节奏",
    stdInBand ? Math.max(cvVal, 0.75) : cvVal,
    `句长 CV ${cvOf(lens).toFixed(2)}（真人随笔常 0.35~0.7）` +
      (sents.length >= 6
        ? `，标准差 ${std.toFixed(1)}${stdInBand ? "（落入 AI 特征带 4.5~8.5）" : ""}`
        : ""),
  );
  push(
    "句法结构·长句占比",
    norm(
      sents.length ? sents.filter((s) => visibleLen(s.text) >= 38).length / sents.length : 0,
      0.05,
      0.45,
    ),
    `${sents.filter((s) => visibleLen(s.text) >= 38).length}/${sents.length} 句超 38 字`,
  );
  push(
    "语义连贯·骨架词",
    norm(per(countHits(text, SKELETON)), 0, 0.5),
    `每百字 ${per(countHits(text, SKELETON)).toFixed(2)} 个（首先/其次/综上所述）`,
  );
  push(
    "语义连贯·连接词",
    norm(per(countHits(text, CONNECTIVES)), 0, 2.2),
    `每百字 ${per(countHits(text, CONNECTIVES)).toFixed(2)} 个（然而/因此/与此同时）`,
  );
  push(
    "句法结构·抽象名词",
    norm(per(nominalCount(text)), 0.5, 4.0),
    `每百字 ${per(nominalCount(text)).toFixed(2)} 个（性/化/度/机制/体系）`,
  );
  push(
    "句法结构·三段并列",
    norm(
      per(countRe(text, /(既要.{2,12}也要|不仅.{2,12}而且.{2,12}还|一方面.{2,12}另一方面)/g)),
      0,
      0.6,
    ),
    `每百字 ${per(countRe(text, /(既要.{2,12}也要|不仅.{2,12}而且.{2,12}还|一方面.{2,12}另一方面)/g)).toFixed(2)} 组`,
  );
  push(
    "人文特征·缺主观视角",
    norm(per(countRe(text, PERSONAL)), 0.15, 1.2, true),
    `每百字 ${per(countRe(text, PERSONAL)).toFixed(2)} 处（我/那次/我家）`,
  );
  push(
    "人文特征·缺具体细节",
    norm(per(countRe(text, CONCRETE)), 0.2, 1.8, true),
    `每百字 ${per(countRe(text, CONCRETE)).toFixed(2)} 处（数字/专名/时间地点）`,
  );
  push(
    "格式指纹·中英空格",
    norm(
      per(countRe(text, /[\u4e00-\u9fa5][ \t]+[A-Za-z0-9]|[A-Za-z0-9][ \t]+[\u4e00-\u9fa5]/g)),
      0,
      0.6,
    ),
    `${countRe(text, /[\u4e00-\u9fa5][ \t]+[A-Za-z0-9]|[A-Za-z0-9][ \t]+[\u4e00-\u9fa5]/g)} 处`,
  );
  push(
    "格式指纹·四字排比",
    norm(per(countRe(text, IDIOM_LIKE)), 0, 1.2),
    `每百字 ${per(countRe(text, IDIOM_LIKE)).toFixed(2)} 组`,
  );

  return f.slice(0, 12);
}

function cvOf(nums: number[]): number {
  const m = nums.reduce((a, b) => a + b, 0);
  if (m === 0 || nums.length < 2) return 0;
  return stdOf(nums) / (m / nums.length);
}

/** 样本标准差（朱雀官方句长标准差口径用；单句/空数组返回 0） */
function stdOf(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = nums.reduce((a, b) => a + b, 0) / nums.length;
  const varr = nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(varr);
}

function nominalCount(text: string): number {
  let n = 0;
  for (const w of text.split(/[\s\p{P}]/gu)) {
    if (w.length >= 2 && NOMINAL_SUFFIX.test(w)) n++;
  }
  return n;
}

/* ----------------------------- 主入口 ----------------------------- */

export interface ZhuqueOptions {
  /** 本地→官方的线性校准；传入后报告给出 officialEstimate */
  calibration?: Calibration | null;
  /** 困惑度层（本地 ONNX MLM 伪困惑度，朱雀官方点名的「困惑度」指标的公开近似）。
   *  就绪时按 PPL_FUSE_WEIGHT 权重并入综合分——这是本地唯一能碰到"隐层特征"的通道。 */
  ppl?: PplLayerInput | null;
}

/* ----------------------------- 困惑度层（第 13 维：隐层特征近似） -----------------------------
 * 朱雀是混元大模型驱动的服务，隐层特征无法复现；困惑度是公开文献里最接近的代理信号。
 * 阈值沿用 scripts/ppl-calibrate.ts 本地标定（docs §5）：人工组 meanNll∈[0.98,1.35]、
 * AI 组∈[0.18,0.42]，线性可分。归一化：meanNll 越低越像 AI（主信号 0.7）+
 * 窗间曲线越平越像生成式（次信号 0.3）。诚实声明：这是近似，权重刻意压低。
 */

export interface PplLayerInput {
  /** 全文平均 NLL（nat） */
  meanNll: number;
  /** 窗间 NLL 样本标准差 */
  winStd: number;
  /** 参与打分字数 */
  scoredChars: number;
  /** 窗口数 */
  windowCount: number;
}

export interface PplLayer {
  /** 困惑度层 AI 度 0~100（越高越像 AI） */
  score: number;
  /** 人话说明（UI 直接展示） */
  note: string;
}

/** 困惑度层权重：综合分 = 表层 × (1−w) + 困惑度 × w。刻意保守，待真值攒够后重拟。 */
export const PPL_FUSE_WEIGHT = 0.15;

export function pplLayerScore(p: PplLayerInput): PplLayer | null {
  if (p.scoredChars < PPL_MIN_CHARS) return null;
  // meanNll：0.42（AI 组上界）→1 分，0.98（人工组下界）→0 分，区间外饱和
  const normMean = clamp01((0.98 - p.meanNll) / (0.98 - 0.42));
  // 曲线平坦度：winStd 0→1 分（完全平坦），≥PPL_MAX_WIN_STD→0 分；窗口太少不参与
  const normFlat =
    p.windowCount >= PPL_MIN_WINDOWS ? clamp01((PPL_MAX_WIN_STD - p.winStd) / PPL_MAX_WIN_STD) : 0;
  const score = round2((normMean * 0.7 + normFlat * 0.3) * 100);
  const parts: string[] = [];
  if (p.meanNll < PPL_MIN_MEAN_NLL) parts.push("困惑度异常低");
  if (p.windowCount >= PPL_MIN_WINDOWS && p.winStd < PPL_MAX_WIN_STD) parts.push("曲线过平");
  const note = parts.length
    ? `${parts.join(" + ")}（字均NLL ${p.meanNll.toFixed(2)} nat）→ 困惑度层 ${score} 分`
    : `困惑度 ${p.meanNll.toFixed(2)} nat / 窗间波动 ${p.winStd.toFixed(2)} 在人写区间 → 困惑度层 ${score} 分`;
  return { score, note };
}

export function detectZhuque(raw: string, opts: ZhuqueOptions = {}): ZhuqueReport {
  const text = (raw || "").trim();
  const sents = splitSentences(text);
  const chars = visibleLen(text);
  const warnings: string[] = [];

  const eligible = chars >= ZHUQUE_MIN_CHARS;
  if (!eligible) {
    warnings.push(`当前 ${chars} 字，朱雀官方要求不少于 ${ZHUQUE_MIN_CHARS} 字，占比仅供参考`);
  }
  if (chars > ZHUQUE_SUGGEST_MAX) {
    warnings.push(
      `当前 ${chars} 字，超过官方建议的单次 ${ZHUQUE_SUGGEST_MAX} 字，送检建议分批或上传文档`,
    );
  }
  if (sents.length < 4) {
    warnings.push("句子太少，节奏类特征不可靠");
  }

  // 句级打分 → 定档
  const scored = sents.map((s) => {
    const r = scoreSentence(s.text);
    return { ...s, risk: r.risk, reasons: r.reasons, label: labelOfRisk(r.risk) };
  });

  // 三占比按可见字符数统计（官方是占比圆环，按字符长度加权最贴近体感）
  let aiChars = 0,
    susChars = 0,
    humChars = 0,
    aiSentences = 0;
  const total = scored.reduce((a, s) => a + Math.max(1, visibleLen(s.text)), 0) || 1;
  for (const s of scored) {
    const w = Math.max(1, visibleLen(s.text));
    if (s.label === "ai") {
      aiChars += w;
      aiSentences++;
    } else if (s.label === "suspected") susChars += w;
    else humChars += w;
  }
  const rawAi = (aiChars / total) * 100;
  const rawSus = (susChars / total) * 100;
  const rawHum = (humChars / total) * 100;

  // 归一到和 100（两位小数，官方风格）
  const sum = rawAi + rawSus + rawHum || 1;
  const ratios: ZhuqueRatios = {
    ai: round2((rawAi / sum) * 100),
    suspected: round2((rawSus / sum) * 100),
    human: round2((rawHum / sum) * 100),
  };

  // 定档：综合分 ≥40 判 AI特征，≥20 判 疑似AI（与官方"AI特征占比 >60% 高风险、
  // <20~30% 相对安全"的口径同向，刻度比官方保守——官方对典型 AI 文常给到 90%+）
  const surfaceComposite = round2(ratios.ai + 0.5 * ratios.suspected);
  // 困惑度层融合：就绪时按 PPL_FUSE_WEIGHT 并入（表层为主、隐层近似为辅）
  const pplL = opts.ppl ? pplLayerScore(opts.ppl) : null;
  const composite = pplL
    ? round2(surfaceComposite * (1 - PPL_FUSE_WEIGHT) + pplL.score * PPL_FUSE_WEIGHT)
    : surfaceComposite;
  const label: ZhuqueLabel = composite >= 40 ? "ai" : composite >= 20 ? "suspected" : "human";

  const verdict =
    label === "ai"
      ? "AI 味有点重，红色片段建议逐句改写"
      : label === "suspected"
        ? "部分内容疑似 AI 辅助，黄色片段再打磨一下"
        : "未检测到 AI 生成痕迹";

  // 置信度：字数越达标、档位越集中越自信
  const charFactor = clamp01((chars - 100) / (ZHUQUE_MIN_CHARS - 100));
  const concentration = Math.max(ratios.ai, ratios.suspected, ratios.human) / 100;
  const confidence = Math.round(
    Math.max(40, Math.min(97, 45 + charFactor * 30 + concentration * 22)) * (eligible ? 1 : 0.85),
  );

  // 片段：连续同档句合并成一段（红/黄），人工档不标
  const spans: ZhuqueSpan[] = [];
  let buf: typeof scored = [];
  const flush = () => {
    if (!buf.length) return;
    const first = buf[0],
      last = buf[buf.length - 1];
    const lbl = first.label;
    if (lbl !== "human") {
      const allReasons = Array.from(new Set(buf.flatMap((b) => b.reasons))).slice(0, 3);
      spans.push({
        start: first.start,
        end: last.end,
        text: text.slice(first.start, last.end).trim(),
        risk: Math.round(buf.reduce((a, b) => a + b.risk, 0) / buf.length),
        label: lbl,
        reasons: allReasons,
      });
    }
    buf = [];
  };
  for (const s of scored) {
    if (buf.length && buf[0].label !== s.label) flush();
    buf.push(s);
  }
  flush();

  const topSpans = [...spans].sort((a, b) => b.risk - a.risk).slice(0, 8);

  const cal = opts.calibration ?? null;
  // 校准点为 0 时不给估计值（否则显示"估官方分=本地分"误导用户，实测踩到）；
  // <4 点时拟合外推失控（实测两点拟合出 -66×local+2418 的荒谬映射），同样不显示
  const officialEstimate = cal && cal.n >= 4 ? round2(applyCalibration(composite, cal)) : null;

  return {
    ratios,
    probability: ratios.ai,
    composite,
    label,
    labelText: LABEL_TEXT[label],
    verdict,
    confidence,
    pplLayer: pplL,
    spans,
    topSpans,
    features: featureList(text, scored, Math.max(1, chars)),
    stats: {
      chars,
      sentences: sents.length,
      aiChars,
      suspectedChars: susChars,
      aiSentences,
      avgLen: sents.length ? Number((chars / sents.length).toFixed(1)) : 0,
    },
    warnings,
    eligible,
    officialEstimate,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ----------------------------- 语义层（LLM）融合 ----------------------------- */

/**
 * 语义层：本地启发式只能看到表层特征（词汇/句法/格式），而朱雀主要看语义与篇章规律
 * （本项目 2026-08-30 官方实测结论）。补上这一层的可行办法是让 LLM 当"检测员"——
 * 它能读到指代链、因果推进、论点骨架这些本地读不到的东西。
 *
 * 诚实边界：LLM 不是朱雀，它只是另一个视角的评判员；实测同一文本不同模型评分
 * 会在 20~80 之间漂移，故只作为"第二层证据"参与融合，不单独定档。
 */
export interface SemanticLayer {
  /** LLM 语义层 AI 度 0~100（越高越像 AI） */
  score: number;
  /** 检测员指出的语义/篇章层痕迹 */
  critique: string[];
  /** 来源说明（主模型 / 交叉模型） */
  source: string;
}

export interface FusedResult {
  /** 融合后的 AI 度 0~100 */
  composite: number;
  label: ZhuqueLabel;
  labelText: string;
  verdict: string;
  /** 两层各贡献多少分，便于看清是谁把分拉上去的 */
  contributions: { surface: number; semantic: number };
  /** 两层分歧度 0~100：越大说明两层看法越不一致，结论越不可信 */
  divergence: number;
  confidence: number;
}

/**
 * 默认语义层权重 0.8。依据（scripts/zhuque-semantic-live.ts，2026-09-01 实测，
 * sensenova-6.8-flash-lite 单模型 3 次中位数）：
 *   样本D原文：表层 60.22 / 语义 95 / 官方真值 99.99 —— 误差 39.77 → 4.99
 *   样本D去味稿：表层 24.69 / 语义 80 / 官方真值 98.47 —— 误差 73.78 → 18.47
 *   口语真人稿：表层 6.94 / 语义 5（方向一致）
 * 两真值点的最小二乘最优权重 >1（语义层单用最准，表层是拖累项），但 LLM 评分
 * 会漂移、真值只有两条，不敢给满权重，取 0.8 折中。**仍属经验值，攒够真值后重拟。**
 */
export const DEFAULT_SEMANTIC_WEIGHT = 0.8;

/** 表层（本地启发式）× 语义层（LLM）加权融合 */
export function fuseLayers(
  surface: number,
  sem: SemanticLayer | null,
  wSemantic: number = DEFAULT_SEMANTIC_WEIGHT,
): FusedResult | null {
  if (!sem) return null;
  const w = Math.max(0, Math.min(1, wSemantic));
  const surfacePart = (1 - w) * surface;
  const semanticPart = w * sem.score;
  const composite = round2(surfacePart + semanticPart);
  const label: ZhuqueLabel = composite >= 40 ? "ai" : composite >= 20 ? "suspected" : "human";
  const divergence = Math.round(Math.abs(surface - sem.score));
  // 分歧越大越不可信：满分歧（100）时置信度压到 40
  const confidence = Math.round(Math.max(40, Math.min(97, 92 - divergence * 0.52)));
  const verdict =
    label === "ai"
      ? "AI 味有点重，红色片段建议逐句改写"
      : label === "suspected"
        ? "部分内容疑似 AI 辅助，黄色片段再打磨一下"
        : "未检测到 AI 生成痕迹";
  return {
    composite,
    label,
    labelText: LABEL_TEXT[label],
    verdict,
    contributions: { surface: round2(surfacePart), semantic: round2(semanticPart) },
    divergence,
    confidence,
  };
}

/* ----------------------------- 校准：本地分 → 官方分 ----------------------------- */

/**
 * 数值字段的容错读取：空值必须保持"缺失"，不能塌缩成 0。
 *
 * 0 在评分域里是一个**真实的值**（0 分 = 完全人类 / 官方判定无 AI 痕迹），
 * 而 `Number(null) === 0`、`Number("") === 0` —— 用 `isFinite(Number(x))` 做过滤时，
 * "从没填过"会被读成"填了 0"，于是一条半损坏的存储记录会凭空变成
 * (local=0, official=99) 或 (local=80, official=0) 的观测点，把最小二乘拟合线拽歪。
 * 这个坑在本项目里先后在 detector / calib-lab / api-zhuque 三处独立踩到，
 * 故收敛为全局唯一实现（见 SOUL：结论要给证据路径，同类缺陷不留第二次机会）。
 */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  // 只认 number 与数字串。若写成 `Number(v)` 一把梭，还会踩到 `Number([]) === 0`
  // （JSON 损坏时数字字段变成数组是常见形态）和 `Number(true) === 1`——
  // 同样是"非数字的值被静默当成 0/1"，与我们要根除的缺陷同源。
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 最小二乘拟合 official ≈ a×local + b；样本 <2 时退化为纯偏移 */
export function fitCalibration(points: CalibPoint[]): Calibration {
  // 这里 points 已被类型约束为 number，但调用方可能来自未校验的存储读取，
  // 再用 numOrNull 兜一层：NaN/空值不得进入求和（求和里一个 NaN 会让整条线变 NaN）
  const pts = points.filter((p) => numOrNull(p.local) !== null && numOrNull(p.official) !== null);
  if (pts.length === 0) return { a: 1, b: 0, n: 0, points: [] };
  if (pts.length === 1) return { a: 1, b: pts[0].official - pts[0].local, n: 1, points: pts };

  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.local, 0) / n;
  const my = pts.reduce((a, p) => a + p.official, 0) / n;
  let num = 0,
    den = 0;
  for (const p of pts) {
    num += (p.local - mx) * (p.official - my);
    den += (p.local - mx) ** 2;
  }
  const a = den === 0 ? 1 : num / den;
  const b = my - a * mx;
  return { a: round4(a), b: round4(b), n, points: pts };
}

export function applyCalibration(localScore: number, cal: Calibration): number {
  const v = cal.a * localScore + cal.b;
  return Math.max(0, Math.min(100, v));
}

/** 把校准后的综合分翻译成官方三档文案 */
export function officialLabelOf(score: number): { label: ZhuqueLabel; text: string } {
  if (score >= 60) return { label: "ai", text: "AI生成" };
  if (score >= 30) return { label: "suspected", text: "疑似AI辅助" };
  return { label: "human", text: "人工特征" };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
