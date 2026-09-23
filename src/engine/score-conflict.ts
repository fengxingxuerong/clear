/**
 * 本地代理分 vs 外部通道分：分歧判据
 * =================================
 * 起因（2026-09-22，docs/external-judge-findings.md）：拿一个**与本项目模型谱系不同**的
 * 外部席位（StepFun step-3.5-flash）复评深度模式留下的 5 份交付稿，结果：
 *
 * | 稿件        | 本地 aiScore | 外部席位 | 差  |
 * |-------------|--------------|----------|-----|
 * | 07 政务 r1  | 2            | 90       | 88  |
 * | 07 政务 r2  | 2            | 90       | 88  |
 * | N1 回退稿   | 8            | 85~90    | 77+ |
 * | O1 交付稿   | 13           | 75~80    | 62+ |
 * | D0 交付稿   | 8            | 15       | 7   |
 *
 * 5 份里 4 份本地分 ≤13 而外部 ≥75，唯一一致的 D0 差 7 分。闭环保姆那把尺也印证：
 * O1 本地 13 / 评委 73（差 60）。所以界面上只显示本地分与降幅是不够的——
 * 用户看到「2 分，降了 40 分」会以为稳了，而外面看是 90。
 *
 * 阈值怎么定的（不拍脑袋，全部留出实测余量）
 * ------------------------------------------
 * - `CONFLICT_EXTERNAL_AI_MIN = 60`：外部通道多少分算"说是 AI 写的"。
 *   实测分歧稿的外部席位**最低是 75**、闭环保姆 73，取 60 留 13pp 余量；
 *   再往下取会把「疑似 AI」区（官方口径 30~60）也算进来，那是误报。
 * - `CONFLICT_GAP_MIN = 30`：两把尺差多少才叫分歧。实测最小的一次分歧是 60，
 *   而一致的那份只差 7 —— 取 30 落在两者中间，离两边都远。
 *
 * 两个级别不是同一件事，别合并
 * ----------------------------
 * - `severe`：**本地分在说谎**。本地分进了人写带（≤ `AI_SCORE_HUMAN_MAX`），
 *   外部却判成 AI —— 界面上那个「已经很像人」的数字在这篇上不成立。
 * - `warn`：两把尺差得远，但本地分本来也没说自己干净，只是分歧需要看见。
 *
 * 边界（刻意不做的事）
 * --------------------
 * 本模块**只报分歧，不改分、不否决交付**。它不知道外部通道准不准（LLM 当检测器本身有偏差），
 * 也没有任何权限替用户决定该信谁。文案一律指向"以外部通道为准"，而不是"本地分错了"。
 */
import { AI_SCORE_HUMAN_MAX } from "./humanize-metrics";

/** 外部通道判成"AI 味"的门槛（实测最低分歧稿 75，留 13pp 余量） */
export const CONFLICT_EXTERNAL_AI_MIN = 60;

/** 两把尺的最小分歧（实测：一致稿差 7，分歧稿最小差 60） */
export const CONFLICT_GAP_MIN = 30;

/** 外部通道身份：不同通道的置信度不同，文案要指名道姓 */
export type ConflictSource = "judge" | "detector" | "official";

export const SOURCE_ZH: Record<ConflictSource, string> = {
  judge: "LLM 评判",
  detector: "外部检测器",
  official: "朱雀官方分",
};

export interface ScoreConflict {
  source: ConflictSource;
  /** 本地 aiScore（0~100，越高越像 AI） */
  local: number;
  /** 外部通道分（0~100，同向） */
  external: number;
  /** external - local（正数 = 外部比本地看得更"AI"） */
  gap: number;
  level: "warn" | "severe";
  message: string;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 比较本地代理分与一个外部通道分。
 * 任一侧缺失/非有限值 → 返回 null（不做比较就没有分歧可报，
 * 这是刻意的：拿不到外部分时补一条"未送检"的警告属于另一个功能）。
 */
export function scoreConflict(
  local: number | null | undefined,
  external: number | null | undefined,
  source: ConflictSource,
): ScoreConflict | null {
  const l = num(local);
  const e = num(external);
  if (l === null || e === null) return null;

  const gap = e - l;
  // 只关心"外部比本地更像 AI"这一个方向。反方向（本地 80 / 外部 20）说明本地偏严，
  // 那是保守方向的错，不会让用户误以为安全，所以这里不报。
  if (gap < CONFLICT_GAP_MIN || e < CONFLICT_EXTERNAL_AI_MIN) return null;

  const name = SOURCE_ZH[source];
  const severe = l <= AI_SCORE_HUMAN_MAX;
  const message = severe
    ? `⚠️ 本地代理分 ${l}（人写带）与${name} ${e} 差 ${gap} 分——2026-09-22 外部席位复评发现` +
      `本地分在书面体上系统性低报（政务报告 本地 2 / 外部 90）。这一篇请以${name}为准，` +
      `不要用上面的降幅判断安全性。`
    : `两把尺分歧 ${gap} 分（本地 ${l} / ${name} ${e}）——本地代理分与真实检测器无标定关系，` +
      `判断请以${name}为准。`;

  return { source, local: l, external: e, gap, level: severe ? "severe" : "warn", message };
}

/**
 * 多个外部通道同时有分时，挑最该提示的那条：severe 优先，其次分歧最大。
 * 全为 null → null。
 */
export function pickConflict(list: (ScoreConflict | null)[]): ScoreConflict | null {
  let best: ScoreConflict | null = null;
  for (const c of list) {
    if (!c) continue;
    if (!best) {
      best = c;
      continue;
    }
    if (c.level === "severe" && best.level !== "severe") best = c;
    else if (c.level === best.level && c.gap > best.gap) best = c;
  }
  return best;
}
