/**
 * 趣AI味 · 本地 AI 文本检测器（朱雀风格三档判定）
 *
 * 说明（重要）：这不是朱雀，也不可能复刻朱雀——朱雀是腾讯混元大模型驱动的服务，
 * 模型权重与线上策略都不公开。本模块做的是**公开研究已验证的 AI 文本统计特征**的
 * 工程实现：不需要模型、不需要联网、在浏览器里毫秒级出结果。
 *
 * 检测依据的 14 个特征（中文 AI 文本检测文献 + 本项目实测归纳）：
 *  - 词汇层：套话密度、TTR 词汇多样性、名物化后缀（性/化/度）、"的"字密度
 *  - 句法层：句长变异系数、平均句长、无标点长句占比
 *  - 结构层：段落长度均匀度、句首词重复率、总分总骨架词（首先/其次/综上所述）
 *  - 衔接层：连接词密度、四字格/排比密度
 *  - 人文层：第一人称与具体细节密度（真人显著更高）
 *  - 格式层：中英数字间空格、标点多样性
 *
 * 输出沿用朱雀的三档语义，便于用户对号入座：
 *   human  = 人工特征
 *   medium = 疑似AI辅助
 *   high   = AI生成（"易被多平台检测为AI生成"）
 *
 * 诚实边界：这是启发式代理分，与朱雀官方分不是同一把尺子。README 有标定记录说明误差。
 */

// v0.8.5：四套词表收拢至 ./zhuque-lexicon.ts 共享（与 engine/zhuque.ts 同一把词汇尺）
// v0.9.21：5 条特征正则同样收拢（此前两份硬编码且 MODAL 已漂移）
import {
  FORMULAIC,
  OFFICIAL,
  SKELETON,
  CONNECTIVES,
  NOMINAL_SUFFIX,
  rePersonal,
  reConcrete,
  reModalDetector,
  reIdiomLike,
} from "./zhuque-lexicon";
import { guardFor } from "./text-shield";

/* ----------------------------- 类型 ----------------------------- */

export type AiLevel = "human" | "medium" | "high";

export interface FeatureItem {
  /** 特征名 */
  name: string;
  /** 该特征实测值（已归一化到 0~1，越高越像 AI） */
  value: number;
  /** 权重 */
  weight: number;
  /** 人话解释 */
  hint: string;
}

export interface SegmentRisk {
  /** 片段原文（按句切分） */
  text: string;
  /** 该句风险 0~100 */
  risk: number;
  /** 主要命中原因 */
  reason: string;
}

export interface DetectReport {
  /** 综合 AI 概率 0~100（本地代理分，非官方） */
  probability: number;
  /** 三档判定 */
  level: AiLevel;
  /** 档位中文名，直接给 UI 用 */
  levelText: string;
  /** 置信度 0~100：离档位边界越远越自信 */
  confidence: number;
  /** 各特征明细 */
  features: FeatureItem[];
  /** 风险最高的若干句（用于分段高亮，最多 8 条） */
  topSegments: SegmentRisk[];
  /** 统计摘要 */
  stats: {
    chars: number;
    sentences: number;
    paragraphs: number;
    /** 词汇多样性 TTR */
    ttr: number;
    /** 句长变异系数 */
    sentenceCV: number;
  };
  /** 提示：字数过少时可信度下降（朱雀要求 ≥350 字，本检测器给出软提示） */
  warnings: string[];
}

/* ----------------------------- 特征正则 -----------------------------
 * v0.9.21：5 条特征正则收拢至 ./zhuque-lexicon.ts（单一事实源）。
 *
 * ⚠️ 关键：这些正则带 `g` 标志，**有状态**。
 *   - `String.prototype.match(g)` 会忽略并重置 lastIndex → 计次用法安全；
 *   - `RegExp.prototype.test()` **读写 lastIndex** → 连续调用会交替返回
 *     true/false。此前 segmentRisk 里逐句 `CONCRETE.test(sent)` 就踩了这个坑：
 *     同一「有具体细节」的判据被吞掉一半句子（少减 12 分风险）。
 *   ⇒ 布尔判定一律用 `.search(...) >= 0`（不读也不写 lastIndex），不要用 `.test()`。
 */
const PERSONAL = rePersonal();
const CONCRETE = reConcrete();
const MODAL = reModalDetector();
const IDIOM_LIKE = reIdiomLike();

/* ----------------------------- 工具 ----------------------------- */

function splitSentences(text: string): string[] {
  // v0.9.25：与 humanize-text.ts 同一份「切点不得落在 URL/邮箱内部」的判据。
  // 此前这里按 `(?<=[。！？!?；;])` 直接切，URL 里的 `?` 会造出一个假句
  // ⇒ 句数虚高、句长分布被歪曲（实测样本1：5 句 → 4 句）。
  //
  // ⚠️ **端到端收益如实登记**：修复后 detectAI 该样本 17 → 16，仅 1 分——
  // 因为切句只喂句长类特征。探针表里「原样 vs 把 URL 整体删掉」的 17 vs 23
  // 主要来自 URL 字符本身（文本变短），**不是**切句贡献。
  // 纯中文语料修复前后完全一致（对照 24 = 24）⇒ 不会顶红漂移棘轮。
  const flat = text.replace(/\s+/g, " ");
  const guard = guardFor(flat);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < flat.length; i++) {
    if (!guard(i) && "。！？!?；;".includes(flat[i])) {
      out.push(flat.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < flat.length) out.push(flat.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.replace(/[。！？!?；;，,、\s]/g, "").length > 0);
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** 中文二元切词（够用且零依赖：中文不分词也能算 TTR，用 bigram 近似词汇丰富度） */
function bigrams(s: string): string[] {
  const t = s.replace(/[\s\p{P}]/gu, "");
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 线性映射并截断，用于把实测值归一化到 0~1（越高越像 AI） */
function norm(v: number, lo: number, hi: number, invert = false): number {
  const r = clamp01((v - lo) / (hi - lo || 1));
  return invert ? 1 - r : r;
}

function cv(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (m === 0) return 0;
  const varr = nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length;
  return Math.sqrt(varr) / m;
}

/* ----------------------------- 特征计算 ----------------------------- */

interface Raw {
  chars: number;
  sentences: string[];
  paragraphs: string[];
  lens: number[];
  avgLen: number;
  sentenceCV: number;
}

function rawStats(text: string): Raw {
  const sentences = splitSentences(text);
  const paragraphs = splitParagraphs(text);
  const lens = sentences.map((s) => s.replace(/\s/g, "").length);
  const avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  return {
    chars: text.replace(/\s/g, "").length,
    sentences,
    paragraphs,
    lens,
    avgLen,
    sentenceCV: cv(lens),
  };
}

function featureList(text: string, r: Raw, chars: number): FeatureItem[] {
  const f: FeatureItem[] = [];
  const per = (n: number) => (chars > 0 ? (n * 100) / chars : 0);

  // 1. 套话密度（每百字命中数）
  let formulaHits = 0;
  for (const p of FORMULAIC) {
    const m = text.match(new RegExp(p, "g"));
    if (m) formulaHits += m.length;
  }
  // 范围按标定实测收紧：AI 样本每百字 1.0~2.5 处，真人接近 0
  f.push({
    name: "AI 套话密度",
    value: norm(per(formulaHits), 0, 1.0),
    weight: 2.0,
    hint: `每百字命中 ${per(formulaHits).toFixed(2)} 处（值得注意的是/综上所述/赋能 等）`,
  });

  // 1b. 公文/黑话套话密度（与上面分开：真人公文也用，权重略低）
  let offHits = 0;
  for (const p of OFFICIAL) {
    const m = text.match(new RegExp(p, "g"));
    if (m) offHits += m.length;
  }
  f.push({
    name: "公文/黑话套话密度",
    value: norm(per(offHits), 0, 2.0),
    weight: 1.4,
    hint: `每百字 ${per(offHits).toFixed(2)} 处（顶层设计/赋能/抓手/护城河 等）`,
  });

  // 2. 句长变异系数（AI 句长均匀，CV 低）
  f.push({
    name: "句长节奏过平",
    value: norm(r.sentenceCV, 0.28, 0.62, true),
    weight: 1.2,
    hint: `句长 CV ${r.sentenceCV.toFixed(2)}（真人随笔常 0.35~0.7）`,
  });

  // 3. 平均句长（AI 偏长且稳定）
  f.push({
    name: "平均句长偏长",
    value: norm(r.avgLen, 16, 42),
    weight: 0.7,
    hint: `均长 ${r.avgLen.toFixed(1)} 字`,
  });

  // 4. 词汇多样性（bigram TTR，AI 偏低）
  const bg = bigrams(text);
  const ttr = bg.length ? new Set(bg).size / bg.length : 0;
  f.push({
    name: "用词重复（TTR 偏低）",
    value: norm(ttr, 0.82, 0.98, true),
    weight: 0.4,
    hint: `bigram TTR ${(ttr * 100).toFixed(1)}%`,
  });

  // 5. 段落长度均匀度
  const pLens = r.paragraphs.map((p) => p.replace(/\s/g, "").length);
  const paraCV = cv(pLens);
  f.push({
    name: "段落长度均匀",
    value: r.paragraphs.length >= 2 ? norm(paraCV, 0.15, 0.7, true) : 0,
    weight: 0.6,
    hint: r.paragraphs.length >= 2 ? `段长 CV ${paraCV.toFixed(2)}` : "单段，不参与判定",
  });

  // 6. 句首词重复率（AI 爱用同一套句式开头）
  const heads = r.sentences.map((s) => s.replace(/[\s\p{P}]/gu, "").slice(0, 2)).filter(Boolean);
  const headRep = heads.length ? 1 - new Set(heads).size / heads.length : 0;
  f.push({
    name: "句首用词重复",
    value: norm(headRep, 0.1, 0.55),
    weight: 0.9,
    hint: `重复率 ${(headRep * 100).toFixed(0)}%`,
  });

  // 7. 连接词密度
  let connHits = 0;
  for (const c of CONNECTIVES) {
    const m = text.match(new RegExp(c, "g"));
    if (m) connHits += m.length;
  }
  f.push({
    name: "书面连接词密集",
    value: norm(per(connHits), 0, 2.2),
    weight: 1.0,
    hint: `每百字 ${per(connHits).toFixed(2)} 个（然而/因此/此外/与此同时）`,
  });

  // 8. 骨架词（首先/其次/综上所述）
  let skelHits = 0;
  for (const s of SKELETON) {
    const m = text.match(new RegExp(s, "g"));
    if (m) skelHits += m.length;
  }
  f.push({
    name: "提纲骨架词",
    value: norm(per(skelHits), 0, 0.5),
    weight: 1.8,
    hint: `每百字 ${per(skelHits).toFixed(2)} 个（首先/其次/综上所述）`,
  });

  // 9. 第一人称与主观标记（真人高 → 反向）
  const personalHits = (text.match(PERSONAL) || []).length;
  f.push({
    name: "缺少第一人称/主观视角",
    value: norm(per(personalHits), 0.15, 1.2, true),
    weight: 1.6,
    hint: `每百字 ${per(personalHits).toFixed(2)} 处（我/我们/那次/我家）`,
  });

  // 10. 具体细节密度（真人高 → 反向）
  const concreteHits = (text.match(CONCRETE) || []).length;
  f.push({
    name: "缺少具体细节",
    value: norm(per(concreteHits), 0.2, 1.8, true),
    weight: 1.3,
    hint: `每百字 ${per(concreteHits).toFixed(2)} 处（数字/专名/时间地点）`,
  });

  // 11. 四字格排比（AI 爱堆）
  const idiomHits = (text.match(IDIOM_LIKE) || []).length;
  f.push({
    name: "四字格/排比堆砌",
    value: norm(per(idiomHits), 0, 1.2),
    weight: 0.7,
    hint: `每百字 ${per(idiomHits).toFixed(2)} 组`,
  });

  // 12. 名物化后缀密度（性/化/度/机制/体系…）
  let nominal = 0;
  for (const w of text.split(/[\s\p{P}]/gu)) {
    if (w.length >= 2 && NOMINAL_SUFFIX.test(w)) nominal++;
  }
  f.push({
    name: "抽象名词堆砌",
    value: norm(per(nominal), 0.5, 4.0),
    weight: 0.8,
    hint: `每百字 ${per(nominal).toFixed(2)} 个（性/化/度/机制/体系）`,
  });

  // 13. 中英数字间空格（AI 训练语料指纹）
  const spaceHits = (
    text.match(/[\u4e00-\u9fa5][ \t]+[A-Za-z0-9]|[A-Za-z0-9][ \t]+[\u4e00-\u9fa5]/g) || []
  ).length;
  f.push({
    name: "中英数字间空格",
    value: norm(per(spaceHits), 0, 0.6),
    weight: 1.2,
    hint: `${spaceHits} 处（AI 语料爱留空格；部分人打字也带，故仅作参考）`,
  });

  // 14. 判断句式/情态词密度（AI 论述文的骨架动词）
  const modalHits = (text.match(MODAL) || []).length;
  f.push({
    name: "判断句式/情态词密集",
    value: norm(per(modalHits), 0.3, 2.6),
    weight: 1.2,
    hint: `每百字 ${per(modalHits).toFixed(2)} 个（应该/能够/有助于/意味着/既要…也要）`,
  });

  // 14. 标点多样性（AI 标点规整：逗号句号占比过高）
  const puncts = text.match(/[，。！？；：、…—]/g) || [];
  const variety = puncts.length ? new Set(puncts).size : 0;
  f.push({
    name: "标点过于规整",
    value: norm(variety, 2, 7, true),
    weight: 0.3,
    hint: `用到 ${variety} 种标点（真人常混用问号/破折号/省略号）`,
  });

  return f;
}

/* ----------------------------- 分段风险（句子级） ----------------------------- */

/**
 * v0.9.23 性能：`FORMULAIC`（42 条）与 `SKELETON`（14 条）都是静态表，
 * 而 `segmentRisk` 是**逐句**调用的 —— 原来每句都要现场 `new RegExp` 56 次
 * （532 句 → 3 万次构造）。预编译到模块级：非 `g` 标志，`test()` 不读写 lastIndex，
 * 行为与逐次构造**完全等价**（已由全量用例 + 12 样本回归覆盖）。
 * 实测：FORMULAIC 2.2 → 0.9 ms、SKELETON 1.35 → 0.27 ms（532 句），合计省 ≈2.5 ms，
 * 约占 `detectAI` 单次耗时的 26%。
 */
const FORMULAIC_RES: RegExp[] = FORMULAIC.map((p) => new RegExp(p));
const SKELETON_RES: RegExp[] = SKELETON.map((s) => new RegExp("^" + s));

function segmentRisk(sent: string): { risk: number; reason: string } {
  const reasons: string[] = [];
  let risk = 0;

  for (const re of FORMULAIC_RES) {
    if (re.test(sent)) {
      risk += 34;
      reasons.push("含AI套话");
      break;
    }
  }
  const trimmed = sent.trim();
  for (const re of SKELETON_RES) {
    if (re.test(trimmed)) {
      risk += 30;
      reasons.push("提纲骨架开头");
      break;
    }
  }
  if (/^(然而|因此|此外|与此同时|更重要的是|不仅如此)/.test(sent.trim())) {
    risk += 22;
    reasons.push("书面连接词开头");
  }
  if (/(是.*?的。?$)/.test(sent) && sent.length > 22) {
    risk += 12;
    reasons.push("判断句式收尾");
  }
  if (/(性|化|度|机制|体系|格局)/.test(sent) && sent.length > 25) {
    risk += 10;
    reasons.push("抽象名词");
  }
  if (/[\u4e00-\u9fa5][ \t]+[A-Za-z0-9]/.test(sent)) {
    risk += 14;
    reasons.push("中英间空格");
  }
  if (sent.replace(/\s/g, "").length >= 38) {
    risk += 12;
    reasons.push("超长句");
  }
  if (/[\u4e00-\u9fa5]{4}(?:、[\u4e00-\u9fa5]{4}){2,}/.test(sent)) {
    risk += 12;
    reasons.push("四字排比");
  }
  // 真人特征（减风险）
  if (/(我|我们|咱|那次|当时|记得|小时候|朋友)/.test(sent)) {
    risk -= 18;
    reasons.push("有主观视角");
  }
  // v0.9.21：此处原为 CONCRETE.test(sent)，而 CONCRETE 带 g 标志 → lastIndex 残留导致
  // 逐句调用交替命中/落空（一半"有具体细节"的句子被吞，少减 12 分）。改用 sent.search(CONCRETE)，
  // 不读也不写 lastIndex，语义为"该句是否含具体细节"，与原先意图一致。
  if (sent.search(CONCRETE) >= 0) {
    risk -= 12;
    reasons.push("有具体细节");
  }
  if (sent.replace(/\s/g, "").length <= 10) {
    risk -= 14;
    reasons.push("短句");
  }
  if (/[？?]/.test(sent)) {
    risk -= 8;
    reasons.push("疑问句");
  }

  return {
    risk: Math.max(0, Math.min(100, Math.round(risk + 20))),
    reason: reasons[0] || "无明显痕迹",
  };
}

/* ----------------------------- 主入口 ----------------------------- */

// 三档阈值：由 scripts/calibrate-detector.ts 在 5 AI + 5 真人样本集上标定得出。
// 实测分布：AI 样本 39~60（均值 52）、真人样本 9~21（均值 12），安全可分区间 (21, 39)。
// 取 48 / 32：典型 AI 论述文落 high（与朱雀对样本 D 的 high 判定对齐），真人全部落 human，
// 公文类灰区落 medium（真人写的公文同样会落这档，属各检测器的共同行为，非误判）。
const TH_HIGH = 48; // ≥ 判 AI生成
const TH_MEDIUM = 32; // ≥ 判 疑似AI辅助，否则 人工特征

export function detectAI(raw: string): DetectReport {
  const text = (raw || "").trim();
  const r = rawStats(text);
  const chars = Math.max(1, r.chars);
  const warnings: string[] = [];

  if (r.chars < 350) {
    warnings.push(`字数 ${r.chars}，低于朱雀的 350 字门槛；短文本特征不稳，判定仅供参考`);
  }
  if (r.sentences.length < 4) {
    warnings.push("句子太少，节奏类特征不可靠");
  }

  const features = featureList(text, r, chars);

  // 加权求和 → 0~100
  const wSum = features.reduce((a, f) => a + f.weight, 0) || 1;
  const probability = Math.round(
    Math.max(0, Math.min(100, (features.reduce((a, f) => a + f.value * f.weight, 0) / wSum) * 100)),
  );

  const level: AiLevel =
    probability >= TH_HIGH ? "high" : probability >= TH_MEDIUM ? "medium" : "human";
  const levelText = level === "high" ? "AI生成" : level === "medium" ? "疑似AI辅助" : "人工特征";

  // 置信度：离档位边界越远越自信（边界 ±12 分内视为摇摆）
  const boundaries = [TH_MEDIUM, TH_HIGH];
  const dist = Math.min(...boundaries.map((b) => Math.abs(probability - b)));
  const confidence = Math.round(Math.max(45, Math.min(99, 50 + dist * 1.4)));

  // 分段风险：只取最像 AI 的几句
  const segs = r.sentences
    .map((s) => ({ text: s, ...segmentRisk(s) }))
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 8);

  const bg = bigrams(text);
  return {
    probability,
    level,
    levelText,
    confidence,
    features,
    topSegments: segs,
    stats: {
      chars: r.chars,
      sentences: r.sentences.length,
      paragraphs: r.paragraphs.length,
      ttr: bg.length ? Number((new Set(bg).size / bg.length).toFixed(3)) : 0,
      sentenceCV: Number(r.sentenceCV.toFixed(3)),
    },
    warnings,
  };
}

/** 快速判定（只要档位时用） */
export function detectLevel(text: string): AiLevel {
  return detectAI(text).level;
}

/**
 * v0.9.28 P0：注入效果回滚判据——**加噪必须换来 detectAI 下降，否则撤回**。
 *
 * 起因（v0.9.27 修完"叠加双份"后剩下的那一半，artifacts/_probe-qa-double.ts）：
 *   自问自答注入在部分样本上是**净负收益**——C 样本 0.6 档（0 处注入）detectAI=26，
 *   0.7 档（1 处注入）反而 **28**。塞进一整句模板，本地检测概率还涨了 2。
 *   v0.9.27 只把"塞几处"从 2 降到 1，没有回答"该不该塞"。
 *
 * 判据：注入后 detectAI 的 probability 必须**严格小于**注入前，否则返回注入前的文本。
 *   不是"降够 X 分才留"——那需要标定 X，而本地 detector 是整数分、
 *   1 分就是它自己的最小可分辨单位，再定阈值是自造精度。
 *
 * ⚠️ 边界（必须如实登记，别把它说成"官方也验证过"）：
 *   判据是**本地 detector**，不是官方朱雀。自问自答当初的依据是"AI 极少写自问自答"
 *   （朱雀口径），而本地 detector 未必建模了这一条 ⇒ 存在"朱雀有收益、本地判无收益"
 *   的样本被误撤的可能。要证伪只能靠真送检，而 18 个校准点目前 **0/18 认证**。
 *   在拿到认证数据前，以本地可复核的指标为准——它至少是"能当场验"的。
 *
 * 开销：detectAI 实测 16k 字约 5.8ms（artifacts/_probe-detectai-cost.ts），
 *   本函数最多两次调用，且只在"确实注入了"时才比较（after===before 直接短路）。
 */
export function keepOnlyIfDetectDrops(before: string, after: string): string {
  if (after === before) return before;
  return detectAI(after).probability < detectAI(before).probability ? after : before;
}
