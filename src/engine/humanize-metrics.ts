/**
 * 趣AI味 · 指标层：AI 味评分 / 指纹体检 / 本地忠实度校验
 *
 * 从 humanize.ts 拆出的独立领域，只依赖 humanize-data.ts 的共享原语，
 * 不依赖核心替换引擎（避免循环依赖）。零第三方依赖。
 */

import {
  VOCAB,
  FORMULAIC,
  SCORING_EXCLUDE,
  PAD_WORDS,
  splitSentences,
  sentenceStats,
  MIN_BURSTINESS_CV,
} from "./humanize-data.ts";
import type { PplFeature } from "../ppl/scorer-core.ts";

/* ----------------------------- AI 味评分（本地启发式代理） ----------------------------- */

export interface ScoreBreakdown {
  /** 0~100，越高越像 AI 写的 */
  score: number;
  /** 套话/书面腔词命中数 */
  formulaicHits: number;
  /** 句子数 */
  sentenceCount: number;
  /** 句长变异系数（越大越自然） */
  burstiness: number;
  /** 平均句长 */
  avgLen: number;
}

export function aiScore(text: string): ScoreBreakdown {
  const stats = sentenceStats(text);
  const n = stats.count;
  if (n === 0) {
    return { score: 0, formulaicHits: 0, sentenceCount: 0, burstiness: 0, avgLen: 0 };
  }

  // 套话命中
  let hits = 0;
  const haystack = text;
  for (const phrase of FORMULAIC) {
    if (!(phrase in VOCAB) && haystack.includes(phrase)) hits++;
  }
  for (const from of Object.keys(VOCAB)) {
    if (SCORING_EXCLUDE.has(from)) continue;
    if (haystack.includes(from)) hits++;
  }

  // 句长统计（复用入口处的 stats，避免重复切句）
  const avgLen = stats.avg;
  const burstiness = stats.cv;

  // 综合：套话命中数（每命中 6 分，上限 60） + 低 burstiness + 长且均匀的句子
  let ai = Math.min(60, hits * 6);
  ai += (1 - Math.min(1, burstiness / 0.6)) * 30;
  ai += Math.max(0, Math.min(1, (avgLen - 25) / 40)) * 20;

  return {
    score: Math.round(Math.max(0, Math.min(100, ai))),
    formulaicHits: hits,
    sentenceCount: n,
    burstiness: Number(burstiness.toFixed(2)),
    avgLen: Number(avgLen.toFixed(1)),
  };
}

/* ----------------------------- 指纹体检 ----------------------------- */

export interface FingerprintIssue {
  name: string;
  count: number;
  hint: string;
}
export interface FingerprintReport {
  pass: boolean;
  issues: FingerprintIssue[];
  sentenceCV: number;
  /** 句长标准差（朱雀官方口径参考：AI 文本常落在 5~8 区间） */
  sentenceStd?: number;
}

/** 对任意文本做确定性指纹自检：把内部回归套件变成用户功能。
 *  送检朱雀前先跑一遍，红项就是会被抓的把柄。 */
export function fingerprintCheck(text: string): FingerprintReport {
  const issues: FingerprintIssue[] = [];
  // 1) 中英数字间空格
  const spaceHits =
    (text.match(/[\u4e00-\u9fa5，。；：、][ \t]+[A-Za-z0-9]/g) || []).length +
    (text.match(/[A-Za-z0-9%）)\]][ \t]+[\u4e00-\u9fa5]/g) || []).length;
  if (spaceHits > 0) {
    issues.push({
      name: "中英数字间空格",
      count: spaceHits,
      hint: 'AI 训练语料爱留空格（"共 100 次"），人打字不留',
    });
  }
  // 2) 垫词复读
  for (const w of PAD_WORDS) {
    const c = text.split(w + "，").length - 1;
    if (c > 1) {
      issues.push({ name: `垫词复读「${w}」`, count: c, hint: "同一口头禅出现多次，机器复读特征" });
    }
  }
  // 3) 破折号/省略号超标
  const dash = text.split("——").length - 1;
  if (dash > 1) issues.push({ name: "破折号超标", count: dash, hint: "整篇最多 1 个，AI 爱滥用" });
  const ell = text.split("……").length - 1;
  if (ell > 1) issues.push({ name: "省略号超标", count: ell, hint: "整篇最多 1 个" });
  // 4) 段首过渡词残留
  const transRe =
    /(?:^|[。！？!?\n]\s*)(然而|因此|此外|与此同时|综上所述|总而言之|值得注意的是)[，,]?/g;
  const trans = (text.match(transRe) || []).length;
  if (trans > 0) {
    issues.push({
      name: "段首过渡词残留",
      count: trans,
      hint: "然而/因此/综上所述等，AI 骨架特征，直删或口语化",
    });
  }
  // 5) AI 套话
  let formulaic = 0;
  for (const p of FORMULAIC) if (text.includes(p)) formulaic++;
  for (const w of ["值得注意的是", "毋庸置疑", "应运而生", "至关重要"]) {
    if (text.includes(w) && !FORMULAIC.includes(w)) formulaic++;
  }
  if (formulaic > 0) {
    issues.push({
      name: "AI 套话残留",
      count: formulaic,
      hint: "值得注意的是/毋庸置疑 这类词是检测器一票抓的特征",
    });
  }
  // 6) 节奏过平（突发性双通道：CV 相对判据 + 句长标准差绝对判据，后者为朱雀官方口径）
  const stats = sentenceStats(text);
  const cv = Number(stats.cv.toFixed(2));
  const std = Number(stats.std.toFixed(1));
  if (stats.count >= 4 && cv < MIN_BURSTINESS_CV) {
    issues.push({
      name: "句长节奏过平",
      count: 1,
      hint: `句长变异系数 ${cv}（建议 >0.45），AI 句子长度均匀`,
    });
  }
  if (stats.count >= 6 && std >= 4.5 && std <= 8.5) {
    issues.push({
      name: "句长标准差落入 AI 特征带",
      count: 1,
      hint: `句长标准差 ${std}（实测 AI 文本多在 5~8 区间），长短句交错可拉开`,
    });
  }
// 7) 半角逗号过多（反向检查：过度混入也是新指纹）
  // 阈值 15%：人类手打文本偶尔有 5-15% 半角逗号（输入法切换失误），
  // 注入层控制在 ≤5%，15% 足够安全且不误报短文本
  const halfC = (text.match(/,/g) || []).length;
  const fullC = (text.match(/，/g) || []).length;
  if (halfC > 0 && fullC + halfC > 0 && halfC / (fullC + halfC) > 0.15) {
    issues.push({
      name: "半角逗号过多",
      count: halfC,
      hint: "模拟手滑要克制，超过 15% 反而是新指纹",
    });
  }
  return { pass: issues.length === 0, issues, sentenceCV: cv, sentenceStd: std };
}

/* ------------------- 第 8 项：困惑度特征判定（评分由宿主层注入） ------------------- */
// 朱雀官方点名的困惑度指标，本地用 ONNX MLM 伪困惑度近似（Salazar 打分法）。
// 阈值来自 scripts/ppl-calibrate.ts 本地标定：分组掩码 K=5 下人工组 meanNll∈[0.98,1.35]、
// AI 组∈[0.18,0.42]，完全线性可分，取间隔中点 0.70。随朱雀回传数据迭代（见
// docs/fingerprint-and-zhuque-calibration.md §5）。本函数是纯函数，不感知模型与宿主的存在。

/** 全文平均 NLL 低于此值报「困惑度异常低」（单位 nat；标定间隔中点，见 §5） */
export const PPL_MIN_MEAN_NLL = 0.7;
/** 窗间 NLL 样本标准差低于此值报「困惑度曲线过平」（标定两组 max 均 ≈0.10） */
export const PPL_MAX_WIN_STD = 0.12;
/** 参与打分字数下限：短文的困惑度不可靠，不判定 */
export const PPL_MIN_CHARS = 60;
/** 平坦通道最少窗口数：窗口太少谈不了"起伏" */
export const PPL_MIN_WINDOWS = 3;

export function pplIssues(feature: PplFeature): FingerprintIssue[] {
  const issues: FingerprintIssue[] = [];
  if (feature.scoredChars < PPL_MIN_CHARS) return issues;
  if (feature.meanNll < PPL_MIN_MEAN_NLL) {
    issues.push({
      name: "困惑度异常低",
      count: 1,
      hint: `字均NLL ${feature.meanNll.toFixed(2)} nat（<${PPL_MIN_MEAN_NLL}）：对语言模型过于可预测，AI 生成特征`,
    });
  }
  if (feature.windows.length >= PPL_MIN_WINDOWS && feature.winStd < PPL_MAX_WIN_STD) {
    issues.push({
      name: "困惑度曲线过平",
      count: 1,
      hint: `窗间NLL标准差 ${feature.winStd.toFixed(2)}（<${PPL_MAX_WIN_STD}）：全文置信度缺乏起伏，生成式特征`,
    });
  }
  return issues;
}

/* ----------------------------- 本地忠实度校验 ----------------------------- */

export interface FidelityReport {
  pass: boolean;
  /** 数字/英文专名的增删改明细 */
  problems: string[];
}

/** 本地零成本忠实度校验：比对原文与改写稿的数字、英文专名集合。
 *  LLM 质检会漏看、会挂（限流/空回复），但"23% 变 32%""AI 变人工智能导致术语丢失"
 *  这类最危险的偏义，用确定性抽取比对一抓一个准。 */
export function checkFidelityLocal(original: string, rewritten: string): FidelityReport {
  const problems: string[] = [];
  const nums = (t: string) => t.match(/\d+(?:\.\d+)?/g) || [];
  const a = nums(original),
    b = nums(rewritten);
  const count = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
    return m;
  };
  const ca = count(a),
    cb = count(b);
  for (const [num, n] of ca) {
    const m = cb.get(num) || 0;
    if (m < n) problems.push(`数字 ${num} 出现次数减少（${n}→${m}）`);
  }
  for (const [num, n] of cb) {
    const m = ca.get(num) || 0;
    if (n > m && !ca.has(num)) problems.push(`改写新增了原文没有的数字 ${num}`);
  }
  // 英文专名/术语：纯字母+连字符，不含数字——否则 "GDP42%" 会被提取为 "GDP42"
  // 导致与原文 "GDP" 集合比对失败误报"丢失"。数字由上面的 nums() 单独提取。
  const en = (t: string) =>
    new Set((t.match(/[A-Za-z][A-Za-z-]*/g) || []).map((w) => w.toUpperCase()));
  const ea = en(original),
    eb = en(rewritten);
  for (const w of ea) {
    if (!eb.has(w)) problems.push(`英文术语 ${w} 在改写中丢失`);
  }
  return { pass: problems.length === 0, problems: problems.slice(0, 8) };
}

// splitSentences 在此保留引用以维持导出面（部分调用方可能直接用它做切句校验）
export { splitSentences };
