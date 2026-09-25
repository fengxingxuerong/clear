// @vitest-environment happy-dom
/**
 * BenchmarkPanel 分档建议文案与 ZhuquePanel 语义权重滑块（v0.9.16 长尾清扫）。
 *  建议文案按官方预测分分五档，用不同 score 的 ScoreBreakdown 驱动各档渲染。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { BenchmarkPanel } from "./BenchmarkPanel";
import { ZhuquePanel } from "./ZhuquePanel";
import { DEFAULT_API } from "../api/llm-config";
import { DEFAULT_DETECTOR } from "../api/detector";
import { detectZhuque } from "../engine/zhuque";
import type { ScoreBreakdown } from "../engine/humanize";

afterEach(() => cleanup());

const EXPO_TEXT =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。";

function bd(score: number): ScoreBreakdown {
  return { score, formulaicHits: 1, burstiness: 0.5, avgLen: 20, sentenceCount: 5 };
}

function benchProps(score: number) {
  return {
    output: EXPO_TEXT,
    after: bd(score),
    roundScores: [] as number[],
    judging: false,
    detecting: false,
    api: { ...DEFAULT_API },
    detector: { ...DEFAULT_DETECTOR },
    judgeScore: null,
    judgeCritique: [] as string[],
    detectorScore: null,
    zhuqueManualScore: "",
    onJudge: vi.fn(),
    onDetect: vi.fn(),
    onManualScore: vi.fn(),
    onGenreChange: vi.fn(),
    onNote: vi.fn(),
  };
}

describe("BenchmarkPanel 分档建议文案", () => {
  it("高 AI 味产出：渲染高危/饱和区建议（结构级处理指引）", () => {
    const { container, getByText } = render(<BenchmarkPanel {...benchProps(95)} />);
    expect(getByText(/对标评分/)).toBeTruthy();
    const t = container.textContent ?? "";
    expect(/饱和|重点处理结构|清套话/.test(t)).toBe(true);
  });

  it("中段产出：渲染过渡档建议（补边际/再跑一轮）", () => {
    const { container } = render(<BenchmarkPanel {...benchProps(45)} />);
    const t = container.textContent ?? "";
    expect(/已过|继续|再跑|稳/.test(t)).toBe(true);
  });

  it("低分产出：渲染已稳过档建议", () => {
    const { container } = render(<BenchmarkPanel {...benchProps(3)} />);
    const t = container.textContent ?? "";
    expect(/已稳过|低风险|已过/.test(t)).toBe(true);
  });
});

describe("ZhuquePanel 语义权重滑块", () => {
  function zqProps(overrides: Partial<Parameters<typeof ZhuquePanel>[0]> = {}) {
    return {
      text: EXPO_TEXT,
      rep: detectZhuque(EXPO_TEXT),
      calib: { a: 1, b: 0, n: 0, points: [] },
      paste: "",
      msg: "",
      showFeatures: false,
      sem: null,
      semLoading: false,
      weight: 0.8,
      canRunSemantic: false,
      genreEstimate: { pct: 88.3, tag: "论说过人线 aiScore ≤ 10.4" },
      onPaste: vi.fn(),
      onSaveCalib: vi.fn(),
      onClearCalib: vi.fn(),
      onCopySubmit: vi.fn(),
      onOpenOfficial: vi.fn(),
      onOpenLab: vi.fn(),
      onToggleFeatures: vi.fn(),
      onRunSemantic: vi.fn(),
      onWeight: vi.fn(),
      ...overrides,
    } as Parameters<typeof ZhuquePanel>[0];
  }

  it("拖动语义权重滑块触发 onWeight 回调", () => {
    const onWeight = vi.fn();
    const { container } = render(<ZhuquePanel {...zqProps({ onWeight })} />);
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).toBeTruthy();
    fireEvent.change(slider, { target: { value: "0.5" } });
    expect(onWeight).toHaveBeenCalledWith(0.5);
  });

  it("权重滑块回显当前值", () => {
    const { container } = render(<ZhuquePanel {...zqProps({ weight: 0.8 })} />);
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider.value).toBe("0.8");
  });
});
