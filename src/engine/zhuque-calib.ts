/**
 * 趣AI味 · 朱雀官方分校准线（v3 四体裁分层 18 点 OLS，2026-08-26）
 *
 * 从 BenchmarkPanel 抽出的共享数据层：本地 aiScore → 官方朱雀% 的线性映射。
 * 18 个真实官方送检点（送官网新检 6 + v2 归档 12）按体裁分层拟合，
 * R²：论说 0.98 / 叙事 0.99 / 对话 1.00 / 人写 0.77（docs/fingerprint-and-zhuque-calibration.md §3）。
 * 供对标评分面板与朱雀检测面板共用——两处必须看到同一把尺子。
 */

/** v3 四体裁线（18 点 OLS） + 兼容 v1 副线 */
export type CalibTrack = "main" | "concat" | "narrative" | "dialogue" | "human";

export interface CalibEntry {
  /** 下拉显示标签 */
  label: string;
  /** 朱雀% = clamp(a × aiScore + b, 0, 100) */
  a: number;
  b: number;
  /** 拟合说明（n, R², 饱和度, 备注） */
  note: string;
  /** 饱和下界 aiScore ≥ x → 预测 100%（显示饱和提示）；负数或 Infinity 代表不适用（斜率为负） */
  satX: number;
  /** 过人线反推：官方朱雀 ≤40% 所需 aiScore；负数代表"天然已过（如纯人写无处理 H0=15% 直接过）" */
  x40: number;
  /** docs §3.7 过人线提示用的短名，如 "论说线 10.4" */
  x40Tag: string;
  /** 若启用：显示人写警示横幅 */
  humanWarn?: boolean;
  /** 若启用：显示为"高级选项"分隔（副线） */
  advanced?: boolean;
  /** 分组名：「体裁(v3)」「高级(副线)」 */
  group: "体裁(v3)" | "高级(副线)";
}

export const CALIB: Record<CalibTrack, CalibEntry> = {
  // ============ v3 四体裁分层（默认显示在「体裁(v3)」分组）—— 18 点 OLS 2026-08-26 ============
  main: {
    label: "默认 · 论说/公告/学术",
    a: 2.014,
    b: 19.06,
    note: "v3 论说线 · n=5 · R²=0.98 · 最大残差 5.8pp · 适用：结构化/总分总/职场/学术作业；P3 结构拆解可额外再降官% 5~6pp",
    satX: 40.2,
    x40: 10.4,
    x40Tag: "论说过人线 aiScore ≤ 10.4",
    group: "体裁(v3)",
  },
  narrative: {
    label: "叙事 · 散文/游记/小说",
    a: 1.716,
    b: 18.33,
    note: "v3 叙事线 · n=4 · R²=0.99 · 最大残差 3.7pp · 适用：故事/游记/散文/随笔",
    satX: 47.6,
    x40: 12.6,
    x40Tag: "叙事过人线 aiScore ≤ 12.6（v2 基础上放宽 0.7）",
    group: "体裁(v3)",
  },
  dialogue: {
    label: "对话 · 剧本/访谈/聊天记录",
    a: 0.957,
    b: 20.43,
    note: "v3 对话线 · n=5 · R²=1.00 · 最大残差 2.1pp · 斜率仅 0.96≈论说的一半：门槛放宽近一倍",
    satX: 83.1,
    x40: 20.5,
    x40Tag: "对话过人线 aiScore ≤ 20.5（论说的两倍）",
    group: "体裁(v3)",
  },
  human: {
    label: "纯人写稿对照（无 AI）",
    a: -0.3,
    b: 18.0,
    note: "v3 人写线 · n=4 · R²=0.77 · 斜率为负：越去味反而越像 AI！H0=15% 天然过线（docs §3.5.3）；本轮 H2 新检=18% 再次验证",
    satX: Number.POSITIVE_INFINITY, // 斜率为负 → x 越大越安全，不存在饱和
    x40: -1,                        // 负值 → 代表无论如何都天然过 40% 线
    x40Tag: "纯人写天然过人：H0官=15%",
    humanWarn: true,
    group: "体裁(v3)",
  },
  // ============ v1 双轨副线（「高级(副线)」分组，收起或末尾）============
  concat: {
    label: "【副线·不对外】拼接送检专用",
    a: 0.471,
    b: 57.441,
    note: "n=3 · R²=0.919 · 仅用于带桥接段（约100字口语过渡）的拼接送检加工件 · 截距偏倚≈+38% · 不可反推单篇阈值",
    satX: 90.4,
    x40: (40 - 57.441) / 0.471, // 负值：副线即使 aiScore=0 预测也 > 40%，代表不可用于过人线推算
    x40Tag: "副线不用于推算过人线",
    advanced: true,
    group: "高级(副线)",
  },
};

export const TRACK_ORDER: CalibTrack[] = ["main", "narrative", "dialogue", "human", "concat"];

/** 引擎体裁 → 校准轨道映射（humanHand 是引擎侧"纯人写稿"的叫法） */
export function trackForGenre(
  g: "main" | "narrative" | "dialogue" | "humanHand" | null | undefined,
): CalibTrack {
  if (g === "narrative") return "narrative";
  if (g === "dialogue") return "dialogue";
  if (g === "humanHand") return "human";
  return "main";
}

/** 本地 aiScore → 官方朱雀% 预测（截断 0~100） */
export function predictOfficialPct(aiScore: number, track: CalibTrack): number {
  const cur = CALIB[track];
  return Math.max(0, Math.min(100, cur.a * aiScore + cur.b));
}
