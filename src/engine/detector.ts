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

/* ----------------------------- 词表 ----------------------------- */

// AI 高频套话（句首引导位最致命，其次全篇密度）
const FORMULAIC = [
  "值得注意的是", "值得一提", "毋庸置疑", "不可否认", "众所周知", "归根结底", "归根到底",
  "综上所述", "总而言之", "总的说来", "总的来说", "简而言之", "一言以蔽之", "由此可见",
  "在当今社会", "随着.*?的发展", "具有重要.*?意义", "发挥着.*?作用", "至关重要", "不可或缺",
  "应运而生", "大势所趋", "势在必行", "任重道远", "日益凸显", "与日俱增", "方兴未艾",
  "不仅.*?而且", "既.*?又.*?也", "一方面.*?另一方面", "赋能", "抓手", "闭环", "落地",
  "层面", "维度", "赛道", "生态", "矩阵", "颗粒度", "打法", "组合拳",
];

// 公文/体制内/互联网黑话套话：与 FORMULAIC 分开统计（真人公文也用这类词，
// 故权重略低），但 AI 生成文本里的密度显著更高
const OFFICIAL = [
  "高位推动", "顶层设计", "压茬推进", "挂图作战", "攻坚克难", "久久为功",
  "锚定", "紧扣", "牛鼻子", "先手棋", "最后一公里", "加速度",
  "夯实", "筑牢", "厚植", "盘活", "补齐", "锻造", "擦亮", "织密", "纾困",
  "注入新动能", "激发新活力", "释放新潜力", "凝聚共识", "形成合力", "拓宽渠道", "搭建平台",
  "新台阶", "新征程", "擘画", "落地", "闭环", "对齐", "颗粒度", "护城河", "飞轮",
  "赋能", "抓手", "维度", "举措", "效能", "路径", "机制", "体系", "格局",
];

// 总分总/提纲骨架词：AI 写议论文的标志性骨架。
// 注意"第一/第二"必须带量词后缀，否则"第二天""第一次"会被误判成提纲（标定实测踩到）
const SKELETON = [
  "首先", "其次", "再次", "其一", "其二", "其三",
  "一方面", "另一方面", "总之", "综上", "总的来说", "简而言之",
  "第[一二三四五六七八九十]+[章节部点条]",
];

// 书面连接词（真人写作也有，但密度显著低于 AI）
const CONNECTIVES = [
  "然而", "因此", "此外", "与此同时", "更重要的是", "不仅如此", "换言之",
  "事实上", "实际上", "从而", "进而", "反之", "尽管如此", "由此可见", "这意味着",
];

// 名物化/书面后缀词：AI 爱用抽象名词堆砌
const NOMINAL_SUFFIX = /(性|化|度|感|力|型|式|机制|体系|格局|举措|效能|路径|维度|层面)$/;

// 第一人称与主观标记（真人显著更高）
const PERSONAL = /(我|我们|咱|你|您|我觉得|个人|身边|记得|那次|当时|小时候|昨天|上周|我家|朋友)/g;

// 具体细节标记：数字、专名、时间、地点、中文数量词（"两百多块""快十年了"都是真人痕迹）
const CONCRETE =
  /([0-9０-９]+[年月日%％元块个次万亿度公里分秒]|[一二三四五六七八九十百千万亿两几]{1,3}[块元个年月天次度岁遍]|[A-Za-z][A-Za-z0-9-]{2,}|第[一二三四五六七八九十]+[章节部])/g;

// 判断句式与情态词密度（AI 写论述文的骨架动词）
const MODAL = /(应该|应当|必须|需要|需要进一步|有助于|意味着|表明|说明|能够|可以|我们要|值得注意的是|不仅|而且|既要|也要)/g;

// 四字格/对仗排比（AI 爱堆）
const IDIOM_LIKE = /[\u4e00-\u9fa5]{4}(?:、[\u4e00-\u9fa5]{4}){1,}/g;

/* ----------------------------- 工具 ----------------------------- */

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？!?；;])/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/[。！？!?；;，,、\s]/g, "").length > 0);
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
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
  const spaceHits = (text.match(/[\u4e00-\u9fa5][ \t]+[A-Za-z0-9]|[A-Za-z0-9][ \t]+[\u4e00-\u9fa5]/g) || []).length;
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

function segmentRisk(sent: string): { risk: number; reason: string } {
  const reasons: string[] = [];
  let risk = 0;

  for (const p of FORMULAIC) {
    if (new RegExp(p).test(sent)) { risk += 34; reasons.push("含AI套话"); break; }
  }
  for (const s of SKELETON) {
    if (new RegExp("^" + s).test(sent.trim())) { risk += 30; reasons.push("提纲骨架开头"); break; }
  }
  if (/^(然而|因此|此外|与此同时|更重要的是|不仅如此)/.test(sent.trim())) { risk += 22; reasons.push("书面连接词开头"); }
  if (/(是.*?的。?$)/.test(sent) && sent.length > 22) { risk += 12; reasons.push("判断句式收尾"); }
  if (/(性|化|度|机制|体系|格局)/.test(sent) && sent.length > 25) { risk += 10; reasons.push("抽象名词"); }
  if (/[\u4e00-\u9fa5][ \t]+[A-Za-z0-9]/.test(sent)) { risk += 14; reasons.push("中英间空格"); }
  if (sent.replace(/\s/g, "").length >= 38) { risk += 12; reasons.push("超长句"); }
  if (/[\u4e00-\u9fa5]{4}(?:、[\u4e00-\u9fa5]{4}){2,}/.test(sent)) { risk += 12; reasons.push("四字排比"); }
  // 真人特征（减风险）
  if (/(我|我们|咱|那次|当时|记得|小时候|朋友)/.test(sent)) { risk -= 18; reasons.push("有主观视角"); }
  if (CONCRETE.test(sent)) { risk -= 12; reasons.push("有具体细节"); }
  if (sent.replace(/\s/g, "").length <= 10) { risk -= 14; reasons.push("短句"); }
  if (/[？?]/.test(sent)) { risk -= 8; reasons.push("疑问句"); }

  return { risk: Math.max(0, Math.min(100, Math.round(risk + 20))), reason: reasons[0] || "无明显痕迹" };
}

/* ----------------------------- 主入口 ----------------------------- */

// 三档阈值：由 scripts/calibrate-detector.ts 在 5 AI + 5 真人样本集上标定得出。
// 实测分布：AI 样本 39~60（均值 52）、真人样本 9~21（均值 12），安全可分区间 (21, 39)。
// 取 48 / 32：典型 AI 论述文落 high（与朱雀对样本 D 的 high 判定对齐），真人全部落 human，
// 公文类灰区落 medium（真人写的公文同样会落这档，属各检测器的共同行为，非误判）。
const TH_HIGH = 48;   // ≥ 判 AI生成
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
    Math.max(0, Math.min(100, features.reduce((a, f) => a + f.value * f.weight, 0) / wSum * 100))
  );

  const level: AiLevel = probability >= TH_HIGH ? "high" : probability >= TH_MEDIUM ? "medium" : "human";
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
