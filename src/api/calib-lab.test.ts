import { describe, it, expect, beforeAll } from "vitest";

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
  labStats,
  loadSamples,
  clearAllSamples,
} from "./calib-lab";
import { applyCalibration } from "../engine/zhuque";

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
