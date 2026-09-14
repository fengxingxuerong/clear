// @vitest-environment happy-dom
/**
 * BenchmarkPanel 渲染级测试：对标评分面板的双通道按钮、v3 体裁轨道联动
 * （自动识别 / 手动 override / 回到自动 / 引擎上抛）、朱雀送检回填行。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { BenchmarkPanel } from "./BenchmarkPanel";
import { DEFAULT_API } from "../api/llm-config";
import { DEFAULT_DETECTOR } from "../api/detector";
import { CALIB } from "../engine/zhuque-calib";
import type { ScoreBreakdown } from "../engine/humanize";

afterEach(() => cleanup());

const EXPO_TEXT =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。";

const after: ScoreBreakdown = {
  score: 20,
  formulaicHits: 2,
  burstiness: 0.4,
  avgLen: 20,
  sentenceCount: 5,
};

function base(overrides: Partial<Parameters<typeof BenchmarkPanel>[0]> = {}) {
  return {
    output: EXPO_TEXT,
    after,
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
    ...overrides,
  };
}

describe("BenchmarkPanel（对标评分面板）", () => {
  it("output 为空时整块不渲染", () => {
    const { container } = render(<BenchmarkPanel {...base({ output: "" })} />);
    expect(container.textContent).toBe("");
  });

  it("渲染标题与本地代理分；双通道按钮在未配置时禁用", () => {
    const { getByText } = render(<BenchmarkPanel {...base()} />);
    expect(getByText("对标评分（真实通道，非本地代理分）")).toBeTruthy();
    expect(getByText("20")).toBeTruthy();
    const judge = getByText("用 LLM 评判").closest("button") as HTMLButtonElement;
    const detect = getByText("用外部检测器").closest("button") as HTMLButtonElement;
    expect(judge.disabled).toBe(true);
    expect(detect.disabled).toBe(true);
  });

  it("API/检测器配置后按钮可用并触发回调；结果分显示", () => {
    const onJudge = vi.fn();
    const onDetect = vi.fn();
    const p = base({
      api: { ...DEFAULT_API, enabled: true, apiKey: "sk-x" },
      detector: { ...DEFAULT_DETECTOR, enabled: true, url: "https://d/api" },
      judgeScore: 35,
      judgeCritique: ["口语对仗"],
      detectorScore: 60,
      onJudge,
      onDetect,
    });
    const { getByText } = render(<BenchmarkPanel {...p} />);
    fireEvent.click(getByText("用 LLM 评判"));
    fireEvent.click(getByText("用外部检测器"));
    expect(onJudge).toHaveBeenCalledTimes(1);
    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(getByText("LLM 评判：35")).toBeTruthy();
    expect(getByText("检测器：60")).toBeTruthy();
    expect(getByText(/残留痕迹：口语对仗/)).toBeTruthy();
  });

  it("深度轮次分渲染（含失败轮显示「失败」与目标分）", () => {
    const { getByText } = render(<BenchmarkPanel {...base({ roundScores: [60, -1, 25] })} />);
    expect(getByText(/60 → 失败 → 25/)).toBeTruthy();
    expect(getByText(/目标 ≤10/)).toBeTruthy();
  });

  it("v3 预测区：显示官方朱雀%预测、过人线徽章与建议行动卡", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    expect(container.textContent).toContain("官方朱雀%预测");
    // main 线：2.014 × 20 + 19.06 ≈ 59.3% → 离 40% 过人线还差
    expect(container.textContent).toContain("离过人线还差");
    expect(container.textContent).toContain("💡 建议行动");
  });

  it("自动识别徽章显示体裁（论说文）且默认轨道为 main", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    expect(container.textContent).toContain("🤖 自动识别");
    expect(container.textContent).toContain("论说文");
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("main");
  });

  it("手动切到对话线：轨道上抛引擎、显示「手动轨道」与「回到自动」", () => {
    const onGenreChange = vi.fn();
    const { container } = render(<BenchmarkPanel {...base({ onGenreChange })} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    expect(onGenreChange).toHaveBeenCalledWith("dialogue");
    expect(container.textContent).toContain("⚙️ 手动轨道");
    const reset = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("回到自动"),
    ) as HTMLButtonElement;
    expect(reset).toBeTruthy();
  });

  it("预测值随体裁轨道切换重算（对话线截距不同）", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    const before = container.querySelector(".zq-big, .bench")!.textContent!;
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    // 对话线：0.8827 × 20 + 26.5 ≈ 44.2%；与 main 的 59.3% 不同
    const pct = CALIB.dialogue.a * 20 + CALIB.dialogue.b;
    expect(container.textContent).toContain(pct.toFixed(1) + "%");
    expect(before).toBeTruthy();
  });

  it("人写线：切换后触发引擎上抛 humanHand；纯人写稿文案触发警示横幅", () => {
    const onGenreChange = vi.fn();
    const { container } = render(<BenchmarkPanel {...base({ onGenreChange })} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "human" } });
    expect(onGenreChange).toHaveBeenCalledWith("humanHand");
    // 副线 concat 属高级分组：直接切换也应上抛 null
    fireEvent.change(select, { target: { value: "concat" } });
    expect(onGenreChange).toHaveBeenCalledWith(null);
  });

  it("朱雀送检行：手动分数上抛；回填 <30 显示 ✅、≥30 显示 ❌", () => {
    const onManualScore = vi.fn();
    const p = base({ onManualScore });
    const { container, rerender } = render(<BenchmarkPanel {...p} />);
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "28" } });
    expect(onManualScore).toHaveBeenCalledWith("28");
    rerender(<BenchmarkPanel {...base({ onManualScore, zhuqueManualScore: "28" })} />);
    expect(container.textContent).toContain("朱雀：28 ✅");
    rerender(<BenchmarkPanel {...base({ onManualScore, zhuqueManualScore: "65" })} />);
    expect(container.textContent).toContain("朱雀：65 ❌");
  });

  it("API 与检测器都未启用时显示免费路径提示", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    expect(container.textContent).toContain("对标检测两条路径");
  });
});
