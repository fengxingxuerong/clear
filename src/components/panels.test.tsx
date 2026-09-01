// @vitest-environment happy-dom
/**
 * 三块朱雀系面板的渲染级测试：引擎产出的报告能正确落到 UI，
 * 交互回调（特征展开/语义层重跑/锚点预置/保存）真的接得上。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { LocalDetectPanel } from "./LocalDetectPanel";
import { ZhuquePanel } from "./ZhuquePanel";
import { CalibLabModal } from "./CalibLabModal";
import { detectAI } from "../engine/detector";
import { detectZhuque } from "../engine/zhuque";

const AI_TEXT = `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。`;

const HUMAN_TEXT = `我家楼下那家早餐店开了快十年了。老板娘记得我不吃香菜，每次都是提前给我挑出来。有次我出差一个月没去，回来她问我："上哪儿发财去了？"我说出差，她笑："还以为你搬走了。"`;

afterEach(() => cleanup());

describe("LocalDetectPanel（本地 14 特征检测）", () => {
  const detectIn = detectAI(AI_TEXT);
  const detectOut = detectAI(HUMAN_TEXT);

  it("渲染原文/去味稿双徽章与降档对照", () => {
    const { getByText } = render(
      <LocalDetectPanel
        detectIn={detectIn}
        detectOut={detectOut}
        showFeatures={false}
        onToggleFeatures={() => {}}
      />,
    );
    expect(getByText("原文")).toBeTruthy();
    expect(getByText("去味稿")).toBeTruthy();
    expect(getByText("降幅")).toBeTruthy();
    expect(getByText("AI生成", { exact: false })).toBeTruthy();
  });

  it("展开特征明细时显示 14 维特征条", () => {
    const { getByText } = render(
      <LocalDetectPanel
        detectIn={detectIn}
        detectOut={detectOut}
        showFeatures={true}
        onToggleFeatures={() => {}}
      />,
    );
    expect(getByText(/14 维特征/)).toBeTruthy();
    expect(getByText(/AI 套话密度/)).toBeTruthy();
  });

  it("「看特征明细」按钮触发回调", () => {
    const onToggle = vi.fn();
    const { getByText } = render(
      <LocalDetectPanel
        detectIn={detectIn}
        detectOut={detectOut}
        showFeatures={false}
        onToggleFeatures={onToggle}
      />,
    );
    fireEvent.click(getByText("看特征明细"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("低于 350 字给出门槛警告（警告挂检测对象上）", () => {
    const { getByText } = render(
      <LocalDetectPanel
        detectIn={detectAI("很短的句子。就这样。")}
        detectOut={detectAI("另一个很短的句子。也没别的了。")}
        showFeatures={false}
        onToggleFeatures={() => {}}
      />,
    );
    expect(getByText(/350/)).toBeTruthy();
  });
});

describe("ZhuquePanel（朱雀检测本地近似）", () => {
  type ZhuquePanelProps = Parameters<typeof ZhuquePanel>[0];
  function panelProps(overrides: Partial<ZhuquePanelProps> = {}): ZhuquePanelProps {
    return {
      text: AI_TEXT,
      rep: detectZhuque(AI_TEXT),
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
    };
  }

  it("渲染标题、三档占比与体裁线预测", () => {
    const { getByText } = render(<ZhuquePanel {...panelProps()} />);
    expect(getByText(/朱雀检测（本地近似/)).toBeTruthy();
    expect(getByText(/🔴 AI特征/, { exact: false })).toBeTruthy();
    expect(getByText(/体裁线预测/)).toBeTruthy();
    expect(getByText(/88.3%/)).toBeTruthy();
  });

  it("AI 文本应落 AI特征 档并给出官方口径提示", () => {
    const { container } = render(<ZhuquePanel {...panelProps()} />);
    expect(container.textContent).toContain("官方口径");
    const big = container.querySelector(".zq-big")!.textContent!;
    expect(parseFloat(big)).toBeGreaterThanOrEqual(40);
  });

  it("未启用 API 时语义层按钮提示并禁用", () => {
    const { getByText } = render(<ZhuquePanel {...panelProps()} />);
    expect(getByText(/未启用 API：语义层不可用/)).toBeTruthy();
  });

  it("校准输入框变化触发 onPaste；保存按钮在无解析结果时禁用", () => {
    const onPaste = vi.fn();
    const { container, getByText } = render(<ZhuquePanel {...panelProps({ onPaste })} />);
    const input = container.querySelector('input[placeholder*="官方结果"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "AI生成 99.99%" } });
    expect(onPaste).toHaveBeenCalledWith("AI生成 99.99%");
    const save = getByText("记为校准点").closest("button")!;
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it("打开校准实验室与官网按钮触发对应回调", () => {
    const onOpenLab = vi.fn();
    const onOpenOfficial = vi.fn();
    const { getByText } = render(<ZhuquePanel {...panelProps({ onOpenLab, onOpenOfficial })} />);
    fireEvent.click(getByText(/校准实验室（攒真值）/));
    fireEvent.click(getByText("打开朱雀官网"));
    expect(onOpenLab).toHaveBeenCalledTimes(1);
    expect(onOpenOfficial).toHaveBeenCalledTimes(1);
  });
});

describe("CalibLabModal（校准实验室）", () => {
  type CalibLabModalProps = Parameters<typeof CalibLabModal>[0];
  function modalProps(overrides: Partial<CalibLabModalProps> = {}): CalibLabModalProps {
    return {
      samples: [],
      text: "",
      msg: "",
      pasteMap: {},
      onText: vi.fn(),
      onPaste: vi.fn(),
      onClose: vi.fn(),
      onGenerate: vi.fn(),
      onFill: vi.fn(),
      onCopy: vi.fn(),
      onDelete: vi.fn(),
      onClear: vi.fn(),
      onApplyWeight: vi.fn(),
      onSeed: vi.fn(),
      ...overrides,
    };
  }

  it("渲染标题、样本统计与真值锚点预置按钮", () => {
    const { getByText } = render(<CalibLabModal {...modalProps()} />);
    expect(getByText(/校准实验室 · 攒真值/)).toBeTruthy();
    expect(getByText(/预置真值锚点/)).toBeTruthy();
    expect(getByText(/样本 0/)).toBeTruthy();
  });

  it("点击预置锚点触发 onSeed；点击完成触发 onClose", () => {
    const onSeed = vi.fn();
    const onClose = vi.fn();
    const { getByText } = render(<CalibLabModal {...modalProps({ onSeed, onClose })} />);
    fireEvent.click(getByText(/预置真值锚点/));
    fireEvent.click(getByText("完成"));
    expect(onSeed).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("有样本时渲染本地分与官方回填状态", () => {
    const { getByText } = render(
      <CalibLabModal
        {...modalProps({
          samples: [
            {
              id: "t1",
              name: "真值锚点·样本D 原文（AI 议论文）",
              text: "x",
              source: "manual" as const,
              surface: 60.22,
              semantic: null,
              official: 99.99,
              officialLabel: "ai" as const,
              ts: Date.now(),
            },
          ],
        })}
      />,
    );
    expect(getByText(/本地 60.22/)).toBeTruthy();
    expect(getByText(/官方 99.99%/)).toBeTruthy();
  });
});
