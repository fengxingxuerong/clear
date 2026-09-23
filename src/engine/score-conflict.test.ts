import { describe, it, expect } from "vitest";
import {
  scoreConflict,
  pickConflict,
  CONFLICT_GAP_MIN,
  CONFLICT_EXTERNAL_AI_MIN,
  SOURCE_ZH,
  type ScoreConflict,
} from "./score-conflict";
import { AI_SCORE_HUMAN_MAX } from "./humanize-metrics";

/**
 * 真值表来自 docs/external-judge-findings.md（2026-09-22 外部席位 step-3.5-flash 复评）
 * 与 CHANGELOG v0.9.14 §22 的深度模式真机重测（闭环评委分）。
 * 这批数是本模块阈值唯一的来源，改阈值必须回来对着这张表重算。
 */
const OBSERVED: { name: string; local: number; external: number; want: "severe" | null }[] = [
  { name: "07-政务报告 r1", local: 2, external: 90, want: "severe" },
  { name: "07-政务报告 r2", local: 2, external: 90, want: "severe" },
  { name: "N1 回退稿", local: 8, external: 85, want: "severe" },
  { name: "O1 交付稿（外评）", local: 13, external: 75, want: "severe" },
  { name: "O1 交付稿（闭环保姆 73）", local: 13, external: 73, want: "severe" },
  // 唯一两把尺一致的一份：它是靠腰斩篇幅达标的，分数本身没分歧
  { name: "D0 交付稿", local: 8, external: 15, want: null },
];

describe("scoreConflict · 2026-09-22 外评实测真值", () => {
  for (const c of OBSERVED) {
    it(`${c.name}：本地 ${c.local} / 外部 ${c.external} → ${c.want ?? "不报"}`, () => {
      const r = scoreConflict(c.local, c.external, "judge");
      expect(r?.level ?? null).toBe(c.want);
    });
  }

  it("分歧稿的 gap 全部落在实测区间内（本地 2~13 → 外部 73~90）", () => {
    for (const c of OBSERVED) {
      const r = scoreConflict(c.local, c.external, "judge");
      if (!r) continue;
      expect(r.gap).toBe(c.external - c.local);
      expect(r.gap).toBeGreaterThanOrEqual(60);
    }
  });
});

describe("scoreConflict · 阈值不是拍脑袋（改了会红）", () => {
  it(`gap 门槛必须低于实测最小分歧 60，且高于一致稿的 7`, () => {
    // 抬到 61 就会漏报 O1 那两例（差 60/62）；压到 7 就会把 D0 那份一致稿误报成分歧
    expect(CONFLICT_GAP_MIN).toBeLessThanOrEqual(60);
    expect(CONFLICT_GAP_MIN).toBeGreaterThan(7);
  });

  it(`外部"判 AI"门槛必须不高于实测最低分歧稿的 73`, () => {
    // 抬到 74 就把 O1-闭环保姆 那条漏掉了
    expect(CONFLICT_EXTERNAL_AI_MIN).toBeLessThanOrEqual(73);
  });

  it("severe 的本地侧判据就是引擎的人写带上界，不另设一套数", () => {
    // 本地 27 = 人写带边界 → severe；28 落在灰区以外一步 → 仍是 severe（27 是 inclusive）
    expect(scoreConflict(AI_SCORE_HUMAN_MAX, 90, "judge")?.level).toBe("severe");
    // 本地 40（明确不在人写带）但外部分歧够大 → 只报 warn，不冒充"本地分在低报"
    expect(scoreConflict(40, 90, "judge")?.level).toBe("warn");
  });
});

describe("scoreConflict · 边界与不报的情形", () => {
  it("gap 恰好等于门槛时报（门槛是 inclusive）", () => {
    expect(scoreConflict(30, 60, "judge")?.level).toBe("warn");
  });

  it("gap 差 1 分不报", () => {
    expect(scoreConflict(31, 60, "judge")).toBeNull();
  });

  it("外部分没到判 AI 线就不报——疑似区不算", () => {
    expect(scoreConflict(2, 59, "detector")).toBeNull();
  });

  it("只报“外部比本地更像 AI”这一个方向；反方向是保守方向的错，不报", () => {
    expect(scoreConflict(90, 20, "judge")).toBeNull();
  });

  it("两侧相等不算分歧", () => {
    expect(scoreConflict(75, 75, "judge")).toBeNull();
  });

  it.each([
    [null, 90],
    [2, null],
    [undefined, undefined],
    [NaN, 90],
    [2, NaN],
    [Infinity, 90],
  ])("缺一侧就不比较（%s / %s）", (l, e) => {
    expect(scoreConflict(l, e, "judge")).toBeNull();
  });
});

describe("scoreConflict · 文案", () => {
  it("必须点名是哪个外部通道说的，不能只写“两把尺分歧”", () => {
    for (const src of ["judge", "detector", "official"] as const) {
      const r = scoreConflict(2, 90, src);
      expect(r?.message).toContain(SOURCE_ZH[src]);
      expect(r?.source).toBe(src);
    }
  });

  it("severe 必须写明“不要用降幅判断”，这是它存在的全部理由", () => {
    const r = scoreConflict(2, 90, "judge");
    expect(r?.message).toContain("降幅");
  });

  it("warn 不冒充 severe：不提本地分在低报", () => {
    const r = scoreConflict(40, 90, "judge");
    expect(r?.message).not.toContain("低报");
  });
});

describe("pickConflict", () => {
  const warn: ScoreConflict = {
    source: "judge",
    local: 40,
    external: 90,
    gap: 50,
    level: "warn",
    message: "",
  };
  const severe: ScoreConflict = {
    source: "official",
    local: 2,
    external: 70,
    gap: 68,
    level: "severe",
    message: "",
  };

  it("severe 优先于 gap 更大的 warn", () => {
    const biggerWarn: ScoreConflict = { ...warn, gap: 90 };
    expect(pickConflict([biggerWarn, severe])).toBe(severe);
  });

  it("同级取分歧更大者", () => {
    const a = { ...warn, gap: 50 };
    const b = { ...warn, gap: 70 };
    expect(pickConflict([a, b])).toBe(b);
  });

  it("空槽位跳过，全空返回 null", () => {
    expect(pickConflict([null, warn, null])).toBe(warn);
    expect(pickConflict([null, null])).toBeNull();
    expect(pickConflict([])).toBeNull();
  });
});
