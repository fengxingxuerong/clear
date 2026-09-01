/**
 * 朱雀校准实验室（攒真值工具）
 *
 * 目标：把「本地分 ↔ 官方分」校准点从"手动一条条记"变成流水线——
 *   1. 【样本生成】贴一篇原文 → 自动产出 4 条样本（原文 / 本地引擎强度 0.3/0.6/0.9），
 *      每条预计算本地朱雀综合分，零成本零联网；
 *   2. 【送检】逐条复制去官方网页（每日约 20 次配额，4 条一批正好）；
 *   3. 【回填】在行内粘官方结果（复用 parseOfficialResult 自动解析）→ 存为样本；
 *   4. 【拟合】official 非空的样本自动成为校准点：surface→official 线性映射（最小二乘）；
 *      有语义层分的点再网格搜索最优语义权重 w*；n≥8 时做留出验证（1/4 留出算 MAE）。
 *
 * 数据模型（localStorage）：
 *   quaiwei.zhuque.samples  — 样本库（含官方回填结果）
 *   quaiwei.zhuque.calib    — 旧版校准点（兼容读取，新写入统一走样本库派生）
 */

import {
  fitCalibration, fuseLayers, DEFAULT_SEMANTIC_WEIGHT,
  type CalibPoint, type Calibration, type ZhuqueLabel,
} from "../engine/zhuque.ts";
import { humanizeWithScore } from "../engine/humanize.ts";
import { detectZhuque } from "../engine/zhuque.ts";
import { parseOfficialResult } from "./zhuque.ts";

const K_SAMPLES = "quaiwei.zhuque.samples";
const K_CALIB_LEGACY = "quaiwei.zhuque.calib";

/* ----------------------------- 数据模型 ----------------------------- */

export type SampleSource = "original" | "local-0.3" | "local-0.6" | "local-0.9" | "llm" | "manual";

export interface CalibSample {
  id: string;
  name: string;
  text: string;
  source: SampleSource;
  /** 本地朱雀综合分（送检前算好存下来，回填时不再依赖现场重测） */
  surface: number;
  /** 语义层分（有 LLM 实测时记录，参与 w* 拟合） */
  semantic: number | null;
  /** 官方回填结果 */
  official: number | null;
  officialLabel: ZhuqueLabel | null;
  ts: number;
}

export function loadSamples(): CalibSample[] {
  try {
    const raw = localStorage.getItem(K_SAMPLES);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => s && typeof s.text === "string" && isFinite(Number(s.surface)))
      .map((s) => ({
        id: String(s.id ?? genId()),
        name: String(s.name ?? "未命名样本"),
        text: s.text,
        source: (s.source ?? "manual") as SampleSource,
        surface: Number(s.surface),
        semantic: s.semantic == null ? null : Number(s.semantic),
        official: s.official == null ? null : Number(s.official),
        officialLabel: s.officialLabel ?? null,
        ts: Number(s.ts) || Date.now(),
      }));
  } catch {
    return [];
  }
}

export function saveSamples(samples: CalibSample[]): void {
  try {
    // 只保留最近 200 条，防止 localStorage 膨胀
    localStorage.setItem(K_SAMPLES, JSON.stringify(samples.slice(-200)));
  } catch {
    /* 存储不可用则忽略 */
  }
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ----------------------------- 样本生成 ----------------------------- */

/** 一篇原文 → 4 条样本（原文 + 本地引擎三档强度），全部预计算本地综合分，直接入库 */
export function generateBatch(raw: string): CalibSample[] {
  const text = (raw || "").trim();
  if (!text) return [];
  const ts = Date.now();
  const base = text.slice(0, 12).replace(/\s/g, "");
  const mk = (source: SampleSource, name: string, body: string): CalibSample => ({
    id: genId(),
    name: `${base}… · ${name}`,
    text: body,
    source,
    surface: detectZhuque(body).composite,
    semantic: null,
    official: null,
    officialLabel: null,
    ts,
  });
  const out = [mk("original", "原文", text)];
  for (const it of [0.3, 0.6, 0.9] as const) {
    out.push(mk(`local-${it}` as SampleSource, `本地强度${it}`, humanizeWithScore(text, { intensity: it, seed: 7 }).text));
  }
  const all = [...loadSamples(), ...out];
  saveSamples(all);
  return out;
}

/** 手工补录一条（比如 LLM 去味稿或别的来源） */
export function addManualSample(text: string, name: string, semantic: number | null): CalibSample {
  const s: CalibSample = {
    id: genId(),
    name: name || text.slice(0, 12).replace(/\s/g, "") + "… · 手工",
    text: text.trim(),
    source: "manual",
    surface: detectZhuque(text.trim()).composite,
    semantic,
    official: null,
    officialLabel: null,
    ts: Date.now(),
  };
  const all = loadSamples();
  all.push(s);
  saveSamples(all);
  return s;
}

/* ----------------------------- 回填 ----------------------------- */

/** 给样本回填官方结果：粘贴官方整行文本自动解析，或直接给数字 */
export function fillOfficial(
  sampleId: string,
  input: string
): { ok: boolean; note: string; sample?: CalibSample } {
  const all = loadSamples();
  const idx = all.findIndex((s) => s.id === sampleId);
  if (idx < 0) return { ok: false, note: "样本不存在（可能已被清空）" };
  const parsed = parseOfficialResult(input);
  if (!parsed.ok || parsed.probability === null) return { ok: false, note: parsed.note };
  all[idx].official = parsed.probability;
  all[idx].officialLabel = parsed.label;
  saveSamples(all);
  return {
    ok: true,
    note: `已记录：本地 ${all[idx].surface} → 官方 ${parsed.probability}%（${parsed.labelText}）`,
    sample: all[idx],
  };
}

export function deleteSample(sampleId: string): void {
  saveSamples(loadSamples().filter((s) => s.id !== sampleId));
}

export function clearAllSamples(): void {
  try {
    localStorage.removeItem(K_SAMPLES);
    localStorage.removeItem(K_CALIB_LEGACY);
  } catch {
    /* noop */
  }
}

/** 只清样本的官方回填字段（样本文本保留，可重新送检回填） */
export function clearOfficialResults(): void {
  saveSamples(loadSamples().map((s) => ({ ...s, official: null, officialLabel: null })));
}

/* ----------------------------- 官方真值锚点 -----------------------------
 * 样本 D 两点是本项目已有的朱雀官方实测真值（2026-08-30 游客模式实测，
 * 记录见 src/engine/zhique-calibration.txt / scripts/zhuque-truthcheck.ts）。
 * official 是不变的真值；surface 用当前引擎现场重算——引擎会迭代，
 * 锚点的 local 值必须跟得上当前版本，否则校准映射会拿旧引擎的分去拟合。
 * 诚实提醒（同 truthcheck）：这两点参与拟合属于「自证」，真评估要靠后续留出样本。
 */

export const TRUTH_ANCHORS: Array<{
  name: string;
  text: string;
  official: number;
  officialLabel: ZhuqueLabel;
}> = [
  {
    name: "真值锚点·样本D 原文（AI 议论文）",
    official: 99.99,
    officialLabel: "ai",
    text: `随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。值得注意的是，数字化阅读不仅改变了人们获取知识的方式，还显著提升了阅读的便捷性。然而，数字化阅读也面临着一系列挑战，诸如注意力分散、深度思考能力下降等问题。因此，我们需要在享受技术便利的同时，保持对阅读质量的关注。\n首先，数字化阅读让知识的获取变得更加高效。读者可以随时随地通过移动设备访问海量资源，检索与标注也变得前所未有的便捷。其次，数字化阅读有助于降低阅读门槛，让更多人能够接触到优质的内容。此外，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。\n与此同时，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。纸质阅读所具有的沉浸感与仪式感，依然是数字媒介难以替代的。阅读的核心在于思考，这是任何技术手段都无法完全实现的。\n综上所述，数字化阅读与传统阅读并非对立关系，而是互为补充的两种方式。我们既要积极拥抱技术进步，也要坚守阅读的本质，唯有如此，才能真正实现阅读的价值。`,
  },
  {
    name: "真值锚点·样本D 去味稿（强度0.9）",
    official: 98.47,
    officialLabel: "suspected",
    text: `数字化阅读逐渐走进人们的日常生活。数字化阅读不只是改变了人们获取知识的方式，还明显提高了阅读的便捷性。可是，数字化阅读也面对一堆挑战。像是注意力分散。深度思考能力下降等问题。于是，我们需要在享受技术便利的同时，保持对阅读质量的关注。\n一来，数字化阅读让知识的获取变得更加高效。读者可以随时随地用移动设备访问海量资源。检索与标注也变得前所未有的便捷。再说，数字化阅读利于降低阅读门槛，让更多人能够接触到优质的内容，还有，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。\n这期间，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。说句掏心窝的，纸质阅读所具有的沉浸感与仪式感，依然是数字媒介很难替代的。阅读的核心在于思考。这是任何技术手段都无法完全弄成的。\n往实了说，数字化阅读与传统阅读倒不是对立关系，是互为补充的两种方式。我们主动拥抱技术进步，也要坚守阅读的本质，只有这样，才能真正实现阅读的意义。`,
  },
];

/** 一键预置真值锚点（幂等：同名锚点已存在则跳过） */
export function seedTruthAnchors(): { added: number; total: number } {
  const all = loadSamples();
  const ts = Date.now();
  let added = 0;
  for (const a of TRUTH_ANCHORS) {
    if (all.some((s) => s.name === a.name)) continue;
    all.push({
      id: genId(),
      name: a.name,
      text: a.text,
      source: "manual",
      surface: detectZhuque(a.text).composite,
      semantic: null,
      official: a.official,
      officialLabel: a.officialLabel,
      ts,
    });
    added++;
  }
  if (added) saveSamples(all);
  return { added, total: loadSamples().length };
}

/* ----------------------------- 拟合与验证 ----------------------------- */

export interface LabStats {
  /** 样本总数 / 已回填数 */
  total: number;
  filled: number;
  /** surface→official 线性映射（含旧版兼容点） */
  calibration: Calibration;
  /** 最优语义层权重（有 semantic 的点 ≥2 才给出，否则 null） */
  bestWeight: number | null;
  /** 留出验证：n≥8 时随机留 1/4 算 MAE（绝对误差均值），否则 null */
  holdoutMAE: number | null;
  /** 参与验证的条数 */
  holdoutN: number;
  /** 给人看的进度提示 */
  progress: string;
}

/** 汇总所有校准点（样本库派生 + 旧版 key 兼容），去重（同一 local/official 对） */
export function collectPoints(): CalibPoint[] {
  const fromSamples = loadSamples()
    .filter((s) => s.official !== null)
    .map((s) => ({ local: s.surface, official: s.official as number, ts: s.ts }));
  let legacy: CalibPoint[] = [];
  try {
    const raw = localStorage.getItem(K_CALIB_LEGACY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        legacy = arr
          .filter((p) => p && isFinite(Number(p.local)) && isFinite(Number(p.official)))
          .map((p) => ({ local: Number(p.local), official: Number(p.official), ts: Number(p.ts) || 0 }));
      }
    }
  } catch {
    /* noop */
  }
  const seen = new Set<string>();
  return [...fromSamples, ...legacy].filter((p) => {
    const k = `${p.local}|${p.official}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 网格搜索最优语义层权重：让 fuseLayers(surface, sem, w) 最贴近官方分 */
function fitBestWeight(pointsWithSem: Array<{ surface: number; semantic: number; official: number }>): number | null {
  if (pointsWithSem.length < 2) return null;
  let best = DEFAULT_SEMANTIC_WEIGHT;
  let bestErr = Infinity;
  for (let w = 0; w <= 1.0001; w += 0.05) {
    let err = 0;
    for (const p of pointsWithSem) {
      const f = fuseLayers(p.surface, { score: p.semantic, critique: [], source: "" }, w);
      if (!f) continue;
      err += (f.composite - p.official) ** 2;
    }
    if (err < bestErr) { bestErr = err; best = Math.round(w * 100) / 100; }
  }
  return best;
}

/** 固定种子的简单洗牌（可复现的留出划分） */
function seededShuffle<T>(arr: T[], seed = 42): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function labStats(): LabStats {
  const samples = loadSamples();
  const filled = samples.filter((s) => s.official !== null);
  const points = collectPoints();
  const calibration = fitCalibration(points);

  const withSem = filled
    .filter((s) => s.semantic !== null)
    .map((s) => ({ surface: s.surface, semantic: s.semantic as number, official: s.official as number }));
  const bestWeight = fitBestWeight(withSem);

  // 留出验证：≥8 条时留 1/4（至少 2 条），其余拟合、留出算 MAE
  let holdoutMAE: number | null = null;
  let holdoutN = 0;
  if (points.length >= 8) {
    const shuffled = seededShuffle(points);
    const nHold = Math.max(2, Math.round(points.length / 4));
    const hold = shuffled.slice(0, nHold);
    const train = shuffled.slice(nHold);
    const cal = fitCalibration(train);
    if (cal.n > 0) {
      const errs = hold.map((p) => Math.abs(cal.a * p.local + cal.b - p.official));
      holdoutMAE = Math.round((errs.reduce((a, b) => a + b, 0) / errs.length) * 100) / 100;
      holdoutN = hold.length;
    }
  }

  const progress =
    points.length === 0
      ? "还没有校准点：生成样本 → 送检 → 回填，第一步先攒 2 条"
      : points.length < 4
        ? `${points.length}/20 条（官方每日约 20 次配额）——继续攒，4 条起做首版拟合，15 条后做留出验证`
        : points.length < 8
          ? `${points.length} 条已可拟合，建议攒到 8 条启用留出验证`
          : `${points.length} 条，留出验证已启用（每次回填自动重算）`;

  return {
    total: samples.length,
    filled: filled.length,
    calibration,
    bestWeight,
    holdoutMAE,
    holdoutN,
    progress,
  };
}
