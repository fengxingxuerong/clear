import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// calib-lab 只在函数调用时触碰 localStorage（import 时不碰），
// node 环境下先打桩再调用即可
const store = new Map<string, string>();
beforeAll(() => {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

import {
  seedTruthAnchors,
  collectPoints,
  readLegacyPoints,
  labStats,
  loadSamples,
  saveSamples,
  clearAllSamples,
  clearOfficialResults,
  generateBatch,
  addManualSample,
  fillOfficial,
  deleteSample,
  type CalibSample,
} from "./calib-lab";
import { applyCalibration } from "../engine/zhuque";

const K_SAMPLES = "quaiwei.zhuque.samples";
const K_LEGACY = "quaiwei.zhuque.calib";

/** 造一条合法样本（surface/official 可被覆盖成脏值，用来测容错） */
function mkSample(p: Partial<CalibSample> & { id: string }): Record<string, unknown> {
  return {
    name: "样本",
    text: "这是一段用于测试的样本文本内容。",
    source: "manual",
    surface: 50,
    semantic: null,
    official: null,
    officialLabel: null,
    ts: 1,
    ...p,
  };
}

beforeEach(() => {
  store.clear();
});

describe("seedTruthAnchors（样本D 官方真值锚点）", () => {
  it("首次预置 2 条，重复执行幂等", () => {
    clearAllSamples();
    const r1 = seedTruthAnchors();
    expect(r1.added).toBe(2);
    expect(r1.total).toBe(2);
    const r2 = seedTruthAnchors();
    expect(r2.added).toBe(0);
    expect(r2.total).toBe(2);
  });

  it("锚点自带官方回填值并计入校准点", () => {
    clearAllSamples();
    seedTruthAnchors();
    const pts = collectPoints();
    expect(pts).toHaveLength(2);
    const officials = pts.map((p) => p.official).sort((a, b) => a - b);
    expect(officials).toEqual([98.47, 99.99]);
    expect(labStats().calibration.n).toBe(2);
  });

  it("锚点 surface 为当前引擎现场重算（合法 0~100 且与文本对应）", () => {
    clearAllSamples();
    seedTruthAnchors();
    const samples = loadSamples();
    const original = samples.find((s) => s.name.includes("原文"));
    const humanized = samples.find((s) => s.name.includes("去味稿"));
    expect(original!.surface).toBeGreaterThan(0);
    expect(original!.surface).toBeLessThanOrEqual(100);
    // 原文是典型 AI 文，表层综合分必须显著高于深度去味稿
    expect(original!.surface).toBeGreaterThan(humanized!.surface);
  });

  it("两点锚点拟合出的映射可用于估分（显示门槛 n≥4 由 UI 层把关）", () => {
    clearAllSamples();
    seedTruthAnchors();
    const cal = labStats().calibration;
    const est = applyCalibration(cal.a * 60 + cal.b, cal);
    expect(est).toBeGreaterThanOrEqual(0);
    expect(est).toBeLessThanOrEqual(100);
  });
});

/* ---------------------- 存储容错（空值不得塌缩成 0） ---------------------- */

describe("loadSamples 脏数据容错", () => {
  it("surface 为 null / 空串的样本被拒绝，而不是读成 0", () => {
    // 回归锁定：Number(null) === 0，旧写法会让半损坏样本伪装成 surface=0，
    // 变成 (local=0, official=99) 的观测点把拟合线往下拽
    for (const bad of [null, "", undefined]) {
      store.clear();
      store.set(K_SAMPLES, JSON.stringify([mkSample({ id: "a", surface: bad as unknown as number, official: 99 })]));
      expect(loadSamples()).toHaveLength(0);
    }
  });

  it("surface 为非数字字符串同样被拒绝", () => {
    store.set(K_SAMPLES, JSON.stringify([mkSample({ id: "a", surface: "abc" as unknown as number })]));
    expect(loadSamples()).toHaveLength(0);
  });

  it("official 为空串时保持 null，不得读成「官方 0 分」", () => {
    store.set(K_SAMPLES, JSON.stringify([mkSample({ id: "a", surface: 80, official: "" as unknown as number })]));
    const s = loadSamples();
    expect(s).toHaveLength(1);
    expect(s[0].official).toBeNull();
    expect(collectPoints()).toHaveLength(0);
  });

  it("official 为 null 时不产出校准点", () => {
    store.set(K_SAMPLES, JSON.stringify([mkSample({ id: "a", surface: 80, official: null })]));
    expect(collectPoints()).toHaveLength(0);
  });

  it("official 正常为 0 时必须保留（0 是合法的官方分）", () => {
    store.set(K_SAMPLES, JSON.stringify([mkSample({ id: "a", surface: 5, official: 0 })]));
    expect(collectPoints()).toEqual([{ local: 5, official: 0, ts: 1 }]);
  });

  it("非数组 / 坏 JSON 返回空数组而不是抛错", () => {
    store.set(K_SAMPLES, "{ 不是数组");
    expect(loadSamples()).toEqual([]);
    store.set(K_SAMPLES, JSON.stringify({ a: 1 }));
    expect(loadSamples()).toEqual([]);
  });

  it("缺 text 的条目被拒绝", () => {
    store.set(K_SAMPLES, JSON.stringify([{ id: "x", surface: 50 }]));
    expect(loadSamples()).toHaveLength(0);
  });
});

describe("saveSamples", () => {
  it("只保留最近 200 条", () => {
    const many = Array.from({ length: 230 }, (_, i) => mkSample({ id: `s${i}`, surface: i }));
    saveSamples(many as unknown as CalibSample[]);
    const s = loadSamples();
    expect(s).toHaveLength(200);
    expect(s[199].surface).toBe(229); // 末尾（最近）那批
  });
});

describe("readLegacyPoints（全局唯一实现）", () => {
  it("读取旧版校准点并剔除空值脏点", () => {
    store.set(
      K_LEGACY,
      JSON.stringify([{ local: null, official: 99, ts: 1 }, { local: 40, official: 55, ts: 2 }]),
    );
    expect(readLegacyPoints()).toEqual([{ local: 40, official: 55, ts: 2 }]);
  });

  it("非数组 / 坏 JSON 返回空数组而不是抛错", () => {
    store.set(K_LEGACY, "{ 坏 json");
    expect(readLegacyPoints()).toEqual([]);
    store.set(K_LEGACY, JSON.stringify({ a: 1 }));
    expect(readLegacyPoints()).toEqual([]);
  });

  it("缺 ts 时补 0（不崩）", () => {
    store.set(K_LEGACY, JSON.stringify([{ local: 10, official: 20 }]));
    expect(readLegacyPoints()).toEqual([{ local: 10, official: 20, ts: 0 }]);
  });
});

describe("collectPoints（旧版 key 兼容）", () => {
  it("legacy 里 local 为空值的脏点被过滤，不塌缩成 0", () => {
    store.set(K_LEGACY, JSON.stringify([{ local: null, official: 99, ts: 1 }, { local: 40, official: 55, ts: 2 }]));
    expect(collectPoints()).toEqual([{ local: 40, official: 55, ts: 2 }]);
  });

  it("样本库派生点与 legacy 点合并，并按 local|official 去重", () => {
    store.set(K_SAMPLES, JSON.stringify([mkSample({ id: "a", surface: 40, official: 55 })]));
    store.set(K_LEGACY, JSON.stringify([{ local: 40, official: 55, ts: 9 }, { local: 70, official: 80, ts: 3 }]));
    const pts = collectPoints();
    expect(pts).toHaveLength(2);
    expect(pts.map((p) => p.local).sort((a, b) => a - b)).toEqual([40, 70]);
  });
});

/* ---------------------- 样本生成与回填 ---------------------- */

describe("generateBatch", () => {
  it("空输入返回空数组且不写库", () => {
    expect(generateBatch("   ")).toEqual([]);
    expect(loadSamples()).toEqual([]);
  });

  it("一篇原文产出 4 条样本（原文 + 三档强度）并入库", () => {
    const out = generateBatch("这是一段足够长的测试原文，用于验证批量样本生成的行为。它需要包含若干句子。");
    expect(out).toHaveLength(4);
    expect(out.map((s) => s.source)).toEqual(["original", "local-0.3", "local-0.6", "local-0.9"]);
    expect(loadSamples()).toHaveLength(4);
  });

  it("每条都预计算 surface，且尚未回填官方分", () => {
    const out = generateBatch("这是一段足够长的测试原文，用于验证批量样本生成的行为。它需要包含若干句子。");
    for (const s of out) {
      expect(s.surface).toBeGreaterThanOrEqual(0);
      expect(s.surface).toBeLessThanOrEqual(100);
      expect(s.official).toBeNull();
    }
  });

  it("样本 id 互不重复（同毫秒生成也不能撞）", () => {
    const out = generateBatch("这是一段足够长的测试原文，用于验证批量样本生成的行为。它需要包含若干句子。");
    expect(new Set(out.map((s) => s.id)).size).toBe(4);
  });
});

describe("addManualSample", () => {
  it("未给名字时用文本前缀自动命名", () => {
    const s = addManualSample("手工录入的文本内容", "", null);
    expect(s.name).toContain("手工");
    expect(s.source).toBe("manual");
    expect(loadSamples()).toHaveLength(1);
  });

  it("保留传入的语义分（参与 w* 拟合）", () => {
    const s = addManualSample("手工录入的文本内容", "自定义名", 66);
    expect(s.semantic).toBe(66);
  });
});

describe("fillOfficial", () => {
  it("粘贴官方结果成功回填并给出人话提示", () => {
    const s = addManualSample("待回填的样本正文。", "测试样本", null);
    const r = fillOfficial(s.id, "AI生成 99.99%");
    expect(r.ok).toBe(true);
    expect(r.note).toContain("99.99");
    expect(r.sample?.official).toBe(99.99);
    expect(r.sample?.officialLabel).toBe("ai");
  });

  it("样本 id 不存在时返回失败而不是抛错", () => {
    const r = fillOfficial("不存在的id", "AI生成 50%");
    expect(r.ok).toBe(false);
    expect(r.note).toContain("样本不存在");
  });

  it("官方文本解析不出来时透传解析提示，且不写脏值", () => {
    const s = addManualSample("待回填的样本正文。", "测试样本", null);
    const r = fillOfficial(s.id, "看不懂的一段话");
    expect(r.ok).toBe(false);
    expect(loadSamples()[0].official).toBeNull();
  });

  it("回填后该样本立即成为校准点", () => {
    const s = addManualSample("待回填的样本正文。", "测试样本", null);
    expect(collectPoints()).toHaveLength(0);
    fillOfficial(s.id, "AI生成 80%");
    expect(collectPoints()).toHaveLength(1);
  });
});

describe("删除与清空", () => {
  it("deleteSample 只删指定样本", () => {
    const a = addManualSample("第一条样本正文。", "A", null);
    addManualSample("第二条样本正文。", "B", null);
    deleteSample(a.id);
    const left = loadSamples();
    expect(left).toHaveLength(1);
    expect(left[0].name).toBe("B");
  });

  it("clearOfficialResults 保留样本文本、只清官方字段", () => {
    const s = addManualSample("待回填的样本正文。", "测试样本", null);
    fillOfficial(s.id, "AI生成 80%");
    clearOfficialResults();
    const left = loadSamples();
    expect(left).toHaveLength(1);
    expect(left[0].text).toContain("待回填");
    expect(left[0].official).toBeNull();
    expect(collectPoints()).toHaveLength(0);
  });

  it("clearAllSamples 连 legacy 校准点一起清掉", () => {
    store.set(K_LEGACY, JSON.stringify([{ local: 40, official: 55, ts: 1 }]));
    addManualSample("样本正文。", "A", null);
    clearAllSamples();
    expect(loadSamples()).toEqual([]);
    expect(collectPoints()).toEqual([]);
  });
});

/* ---------------------- 拟合与留出验证 ---------------------- */

describe("labStats", () => {
  it("空库时进度文案给出第一步指引", () => {
    const st = labStats();
    expect(st.total).toBe(0);
    expect(st.filled).toBe(0);
    expect(st.progress).toContain("还没有校准点");
    expect(st.calibration.n).toBe(0);
  });

  it("不足 4 条时提示继续攒并给出配额背景", () => {
    store.set(K_SAMPLES, JSON.stringify([mkSample({ id: "a", surface: 40, official: 55 })]));
    expect(labStats().progress).toContain("继续攒");
  });

  it("4~7 条时提示可拟合、建议攒到 8 条", () => {
    const pts = Array.from({ length: 5 }, (_, i) => mkSample({ id: `s${i}`, surface: 10 * (i + 1), official: 12 * (i + 1) }));
    store.set(K_SAMPLES, JSON.stringify(pts));
    const st = labStats();
    expect(st.filled).toBe(5);
    expect(st.progress).toContain("已可拟合");
    expect(st.holdoutMAE).toBeNull(); // 未到 8 条不启用留出
  });

  it("≥8 条时启用留出验证，完全线性数据 MAE 应为 0", () => {
    const pts = Array.from({ length: 8 }, (_, i) => mkSample({ id: `s${i}`, surface: 10 * (i + 1), official: 20 * (i + 1) }));
    store.set(K_SAMPLES, JSON.stringify(pts));
    const st = labStats();
    expect(st.progress).toContain("留出验证已启用");
    expect(st.holdoutMAE).toBe(0);
    expect(st.holdoutN).toBeGreaterThanOrEqual(2);
  });

  it("留出划分可复现（同数据两次调用结果一致）", () => {
    const pts = Array.from({ length: 9 }, (_, i) => mkSample({ id: `s${i}`, surface: 10 * (i + 1), official: 10 * (i + 1) + (i % 3) }));
    store.set(K_SAMPLES, JSON.stringify(pts));
    expect(labStats().holdoutMAE).toBe(labStats().holdoutMAE);
  });

  it("语义点不足 2 条时不给 w*", () => {
    store.set(
      K_SAMPLES,
      JSON.stringify([
        mkSample({ id: "a", surface: 40, official: 55, semantic: 60 }),
        mkSample({ id: "b", surface: 70, official: 80, semantic: null }),
      ]),
    );
    expect(labStats().bestWeight).toBeNull();
  });

  it("官方分贴近表层分时，w* 收敛到 0（纯表层最好）", () => {
    const pts = [0, 1, 2].map((i) => mkSample({ id: `s${i}`, surface: 30 + i * 20, official: 30 + i * 20, semantic: 90 }));
    store.set(K_SAMPLES, JSON.stringify(pts));
    expect(labStats().bestWeight).toBe(0);
  });

  it("官方分贴近语义分时，w* 收敛到 1（纯语义最好）", () => {
    const pts = [0, 1, 2].map((i) => mkSample({ id: `s${i}`, surface: 30, official: 85 + i, semantic: 85 + i }));
    store.set(K_SAMPLES, JSON.stringify(pts));
    expect(labStats().bestWeight).toBe(1);
  });

  it("total 统计全部样本，filled 只统计已回填", () => {
    store.set(
      K_SAMPLES,
      JSON.stringify([
        mkSample({ id: "a", surface: 40, official: 55 }),
        mkSample({ id: "b", surface: 50, official: null }),
      ]),
    );
    const st = labStats();
    expect(st.total).toBe(2);
    expect(st.filled).toBe(1);
  });
});
