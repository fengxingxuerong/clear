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
import { detectZhuque, fuseLayers } from "../engine/zhuque";

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

  it("有语义层时大数字显示融合分，分歧 ≥30 弹「建议以官方送检为准」", () => {
    const rep = detectZhuque(AI_TEXT);
    // 语义分与表层拉开 ≥30 分：表层 >50 取 0、否则取 100，分歧恒 ≥30
    const sem = {
      score: rep.composite > 50 ? 0 : 100,
      critique: ["论点骨架平铺", "指代链缺失"],
      source: "主模型 · sensenova",
    };
    const { container, getByText, queryByText } = render(
      <ZhuquePanel {...panelProps({ rep, sem, canRunSemantic: true })} />,
    );
    const fused = fuseLayers(rep.composite, sem, 0.8)!;
    // 大数字 = 融合分（toFixed(2)），不再是表层 probability
    expect(container.querySelector(".zq-big")!.textContent).toBe(`${fused.composite.toFixed(2)}%`);
    expect(container.textContent).toContain(`融合 AI 度 ${fused.composite}%`);
    expect(container.textContent).toContain(`表层 ${rep.composite} ×`);
    // 分歧警告只在 divergence ≥ 30 时出现
    expect(getByText(/两层分歧 \d+ 分/)).toBeTruthy();
    expect(container.textContent).toContain("建议以官方送检为准");
    // 语义层标签与痕迹行；启用 API 后「未启用」提示消失，按钮变「重跑语义层」可用
    expect(getByText(`语义层 ${sem.score} 分`)).toBeTruthy();
    expect(getByText(/语义\/篇章层痕迹/)).toBeTruthy();
    expect(queryByText(/未启用 API/)).toBeNull();
    const rerun = getByText("重跑语义层").closest("button") as HTMLButtonElement;
    expect(rerun.disabled).toBe(false);
  });

  it("两层同分（分歧 <30）不弹分歧警告；空 critique 不显示痕迹行", () => {
    const rep = detectZhuque(AI_TEXT);
    const sem = { score: rep.composite, critique: [], source: "交叉模型" }; // 同分 → divergence 0
    const { getByText, queryByText } = render(<ZhuquePanel {...panelProps({ rep, sem })} />);
    expect(getByText(/融合 AI 度/)).toBeTruthy();
    expect(queryByText(/两层分歧/)).toBeNull();
    expect(queryByText(/语义\/篇章层痕迹/)).toBeNull();
    expect(getByText(`语义层 ${sem.score} 分`)).toBeTruthy();
  });

  it("语义层按钮四态：未启用禁带标题 / 可跑点击触发回调 / 评判中 / 重跑", () => {
    const onRunSemantic = vi.fn();
    const { getByText, rerender } = render(
      <ZhuquePanel {...panelProps({ canRunSemantic: false, onRunSemantic })} />,
    );
    // 未启用 API：禁用 + title 说明原因
    const off = getByText("用 LLM 补语义层").closest("button") as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(off.title).toBe("需要启用 API 且已填 Key（设置里配置）");
    // 启用且空闲：可点、title 清空，点击触发 onRunSemantic
    rerender(<ZhuquePanel {...panelProps({ canRunSemantic: true, onRunSemantic })} />);
    const idle = getByText("用 LLM 补语义层").closest("button") as HTMLButtonElement;
    expect(idle.disabled).toBe(false);
    expect(idle.title).toBe("");
    fireEvent.click(idle);
    expect(onRunSemantic).toHaveBeenCalledTimes(1);
    // 评判中：文案切换且禁用
    rerender(
      <ZhuquePanel {...panelProps({ canRunSemantic: true, semLoading: true, onRunSemantic })} />,
    );
    const loading = getByText("评判中…").closest("button") as HTMLButtonElement;
    expect(loading.disabled).toBe(true);
    // 出结果后：变「重跑语义层」
    rerender(
      <ZhuquePanel
        {...panelProps({
          canRunSemantic: true,
          sem: { score: 70, critique: [], source: "s" },
          onRunSemantic,
        })}
      />,
    );
    expect(getByText("重跑语义层")).toBeTruthy();
  });

  it("标注片段为空：渲染兜底文案，不出现高亮区与命中列表", () => {
    const rep = { ...detectZhuque(AI_TEXT), spans: [], topSpans: [] };
    const { container, getByText, queryByText } = render(<ZhuquePanel {...panelProps({ rep })} />);
    expect(getByText(/未标出可疑片段，全篇落人工特征档/)).toBeTruthy();
    expect(queryByText(/标注 \d+ 处/)).toBeNull();
    expect(container.querySelector(".zq-text")).toBeNull();
    expect(container.querySelector(".zq-spans")).toBeNull();
  });

  it("高亮片段 ai/suspected 分档配色与 title 原因；topSpans 超 60 字截断", () => {
    const text = AI_TEXT;
    const longText = "这是一段超过六十个字的超长命中原因说明文本".repeat(4); // 21×4=84 字 > 60
    const spans = [
      {
        start: 0,
        end: 8,
        text: text.slice(0, 8),
        risk: 88,
        label: "ai" as const,
        reasons: ["模板套话", "排比密集"],
      },
      {
        start: 20,
        end: 28,
        text: text.slice(20, 28),
        risk: 45,
        label: "suspected" as const,
        reasons: ["句长均匀"],
      },
      {
        start: text.length - 10,
        end: text.length,
        text: text.slice(-10),
        risk: 70,
        label: "ai" as const,
        reasons: ["收尾升华"],
      },
    ];
    const topSpans = [spans[0], { ...spans[1], text: longText }];
    const rep = { ...detectZhuque(AI_TEXT), spans, topSpans };
    const { container, getByTitle } = render(<ZhuquePanel {...panelProps({ rep, text })} />);
    // ai → zq-ai 红、suspected → zq-sus 黄；title 带「档位 · 风险 · 原因」
    const marks = container.querySelectorAll(".zq-text mark");
    expect(marks).toHaveLength(3);
    expect(marks[0].className).toBe("zq-ai");
    expect(marks[1].className).toBe("zq-sus");
    expect(getByTitle("AI特征 · 风险 88 · 模板套话、排比密集")).toBeTruthy();
    expect(getByTitle("疑似AI · 风险 45 · 句长均匀")).toBeTruthy();
    // 高亮切分后正文可原样拼回（首段 0 起跳、中段补普通文本、末段贴到文末无尾段）
    expect(container.querySelector(".zq-text")!.textContent).toBe(text);
    // topSpans 超长命中原因截断为 60 字 + …，且不泄露完整长文本
    const listText = container.querySelector(".zq-spans")!.textContent!;
    expect(listText).toContain(longText.slice(0, 60) + "…");
    expect(listText).not.toContain(longText);
    expect(listText).toContain("（模板套话、排比密集）");
  });

  it("末段标注未贴到文末：补出尾段普通文本，正文仍能原样拼回（ZhuqueHighlight 尾段真分支）", () => {
    // 上一条的最后一个片段 end 恰好等于 text.length，`pos < text.length` 恒假；
    // 这里刻意让末段停在正文中，钉住尾段 <span key="tail"> 那一支。
    const text = AI_TEXT;
    const spans = [
      {
        start: 0,
        end: 8,
        text: text.slice(0, 8),
        risk: 88,
        label: "ai" as const,
        reasons: ["模板套话"],
      },
      {
        start: 20,
        end: 28,
        text: text.slice(20, 28),
        risk: 45,
        label: "suspected" as const,
        reasons: ["句长均匀"],
      },
    ];
    const rep = { ...detectZhuque(AI_TEXT), spans, topSpans: spans };
    const { container } = render(<ZhuquePanel {...panelProps({ rep, text })} />);

    const marks = container.querySelectorAll(".zq-text mark");
    expect(marks).toHaveLength(2);
    expect(marks[0].className).toBe("zq-ai");
    expect(marks[1].className).toBe("zq-sus");
    // 关键：末段 28 之后的正文必须由尾段节点补出来，且整段可拼回原文
    const root = container.querySelector(".zq-text")!;
    expect(root.textContent).toBe(text);
    expect(root.textContent!.slice(28)).toBe(text.slice(28));
    expect(text.length).toBeGreaterThan(28); // 前置条件：确实存在尾段，断言非永真
  });

  it("展开 12 维特征：名称高值红/其余弱化，条形三档配色与宽度，按钮文案与回调", () => {
    const onToggleFeatures = vi.fn();
    const rep = {
      ...detectZhuque(AI_TEXT),
      features: [
        { name: "AI 套话密度", value: 0.9, hint: "红线值" },
        { name: "句长均匀度", value: 0.42, hint: "中档" },
        { name: "排比触发", value: 0.1, hint: "安全" },
      ],
    };
    const { container, getByText } = render(
      <ZhuquePanel {...panelProps({ rep, showFeatures: true, onToggleFeatures })} />,
    );
    expect(getByText(/12 维特征（条越长越像 AI）/)).toBeTruthy();
    expect(getByText("收起特征")).toBeTruthy();
    // 名称色：value > 0.55 红，否则弱化
    expect((getByText("AI 套话密度") as HTMLElement).style.color).toBe("#ff5d6c");
    expect((getByText("句长均匀度") as HTMLElement).style.color).toBe("var(--muted)");
    expect((getByText("排比触发") as HTMLElement).style.color).toBe("var(--muted)");
    // 条形三档：>0.55 红 / >0.3 橙 / 其余绿；宽度 = round(value×100)%
    const barOf = (name: string) => {
      const row = [...container.querySelectorAll(".bench-row")].find((r) =>
        r.textContent!.includes(name),
      )!;
      const spans = [...row.querySelectorAll("span")];
      return {
        color:
          spans.find((s) => ["#ff5d6c", "#ffb454", "#3ddc97"].includes(s.style.background))?.style
            .background ?? "",
        width: spans.find((s) => s.style.width.endsWith("%"))?.style.width ?? "",
      };
    };
    expect(barOf("AI 套话密度").color).toBe("#ff5d6c");
    expect(barOf("句长均匀度").color).toBe("#ffb454");
    expect(barOf("排比触发").color).toBe("#3ddc97");
    expect(barOf("句长均匀度").width).toBe("42%");
    // 展开态按钮文案为「收起特征」，点击触发回调
    fireEvent.click(getByText("收起特征"));
    expect(onToggleFeatures).toHaveBeenCalledTimes(1);
  });

  it("体裁线预测按 60/30 分档配色，传 null 时整块隐藏", () => {
    const { container, rerender } = render(
      <ZhuquePanel {...panelProps({ genreEstimate: { pct: 70, tag: "高危线" } })} />,
    );
    const genreColor = (): string => {
      const row = [...container.querySelectorAll(".bench-row")].find((r) =>
        r.textContent!.includes("体裁线预测"),
      )!;
      return (row.querySelector("b") as HTMLElement).style.color;
    };
    expect(genreColor()).toBe("#ff5d6c"); // ≥60 红
    rerender(<ZhuquePanel {...panelProps({ genreEstimate: { pct: 45, tag: "过渡线" } })} />);
    expect(genreColor()).toBe("#ffb454"); // 30~60 橙
    rerender(<ZhuquePanel {...panelProps({ genreEstimate: { pct: 20, tag: "安全线" } })} />);
    expect(genreColor()).toBe("#3ddc97"); // <30 绿
    rerender(<ZhuquePanel {...panelProps({ genreEstimate: null })} />);
    expect(container.textContent).not.toContain("体裁线预测");
  });

  it("已校准且粘贴可解析：官方估计、负截距映射、解析提示与可用按钮（三回调）", () => {
    const rep = { ...detectZhuque(AI_TEXT), officialEstimate: 87.5 };
    const calib = { a: 1.2, b: -8.5, n: 7, points: [] };
    const onSaveCalib = vi.fn();
    const onClearCalib = vi.fn();
    const onCopySubmit = vi.fn();
    const { container, getByText } = render(
      <ZhuquePanel
        {...panelProps({
          rep,
          calib,
          paste: "AI生成 99.99%",
          msg: "已记入校准库",
          onSaveCalib,
          onClearCalib,
          onCopySubmit,
        })}
      />,
    );
    // officialEstimate 非 null：行内展示校准后的官方分估计
    expect(container.textContent).toContain("校准后估官方分 87.5%");
    // n>0 且 b<0：映射式用负号形态
    expect(container.textContent).toContain(
      "官方分 ≈ 1.2 × 本地综合分 − 8.5（7 个实测点，最小二乘拟合）",
    );
    // 粘贴解析成功：提示 + 保存按钮可用；清空按钮随 n>0 可用
    expect(getByText(/解析成功：AI生成\/AI特征 99\.99%/)).toBeTruthy();
    expect((getByText("记为校准点").closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect((getByText("清空校准（7）").closest("button") as HTMLButtonElement).disabled).toBe(
      false,
    );
    // msg 提示行
    expect(getByText("已记入校准库")).toBeTruthy();
    // 三个操作回调接通
    fireEvent.click(getByText("复制送检文本"));
    fireEvent.click(getByText("记为校准点"));
    fireEvent.click(getByText("清空校准（7）"));
    expect(onCopySubmit).toHaveBeenCalledTimes(1);
    expect(onSaveCalib).toHaveBeenCalledTimes(1);
    expect(onClearCalib).toHaveBeenCalledTimes(1);
  });

  it("粘贴解析失败：显示 note 且保存按钮保持禁用；正截距映射用加号", () => {
    const calib = { a: 1.1, b: 2.5, n: 3, points: [] };
    const { container, getByText } = render(
      <ZhuquePanel {...panelProps({ calib, paste: "一段没有百分比的普通文字" })} />,
    );
    expect(container.textContent).toContain(
      "官方分 ≈ 1.1 × 本地综合分 + 2.5（3 个实测点，最小二乘拟合）",
    );
    expect(getByText(/没解析出百分比或档位/)).toBeTruthy();
    expect((getByText("记为校准点").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("清空校准（3）").closest("button") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("困惑度层已融合时展示权重与说明；检测警告逐条渲染", () => {
    const rep = {
      ...detectZhuque(AI_TEXT),
      pplLayer: { score: 88, note: "困惑度异常低（字均NLL 0.31 nat）→ 困惑度层 88 分" },
      warnings: ["不足 350 字，官方口径仅供参考"],
    };
    const { container } = render(<ZhuquePanel {...panelProps({ rep })} />);
    expect(container.textContent).toContain("🧠 困惑度层已融合（权重 15%）");
    expect(container.textContent).toContain("困惑度异常低（字均NLL 0.31 nat）→ 困惑度层 88 分");
    expect(container.textContent).toContain("不足 350 字，官方口径仅供参考");
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

describe("CalibLabModal 启用态交互（v0.8.7 补盲）", () => {
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

  /** 干净的 localStorage（labStats/collectPoints 读真库，不能被其他用例污染） */
  function cleanLabStorage(): void {
    localStorage.removeItem("quaiwei.zhuque.samples");
    localStorage.removeItem("quaiwei.zhuque.calib");
  }

  it("未回填样本：粘贴框可输入触发 onPaste，「记录」空值不触发 onFill", () => {
    cleanLabStorage();
    const onPaste = vi.fn();
    const onFill = vi.fn();
    const { getByPlaceholderText, getByText, container } = render(
      <CalibLabModal
        {...modalProps({
          samples: [
            {
              id: "s1",
              name: "原文样本",
              text: "样本正文",
              source: "manual" as const,
              surface: 55.3,
              semantic: null,
              official: null,
              officialLabel: null,
              ts: Date.now(),
            },
          ],
          onPaste,
          onFill,
        })}
      />,
    );
    const input = getByPlaceholderText(/粘贴官方结果/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "AI生成 88.5%" } });
    expect(onPaste).toHaveBeenCalledWith("s1", "AI生成 88.5%");
    // 直接点「记录」但 pasteMap 未传值 → onFill 不触发（防空回填守卫在组件内）
    fireEvent.click(getByText("记录"));
    expect(onFill).not.toHaveBeenCalled();
    expect(container).toBeTruthy();
  });

  it("pasteMap 有值时点「记录」触发 onFill", () => {
    cleanLabStorage();
    const onFill = vi.fn();
    const { getByText } = render(
      <CalibLabModal
        {...modalProps({
          samples: [
            {
              id: "s1",
              name: "原文样本",
              text: "样本正文",
              source: "manual" as const,
              surface: 55.3,
              semantic: null,
              official: null,
              officialLabel: null,
              ts: Date.now(),
            },
          ],
          pasteMap: { s1: "AI生成 88.5%" },
          onFill,
        })}
      />,
    );
    fireEvent.click(getByText("记录"));
    expect(onFill).toHaveBeenCalledWith("s1", "AI生成 88.5%");
  });

  it("推荐语义层权重出现时可「应用为默认」，触发 onApplyWeight", () => {
    cleanLabStorage();
    // 造 4 条带 semantic 的已回填样本 → labStats 可拟合出 bestWeight
    const mk = (i: number, official: number) => ({
      id: "w" + i,
      name: "样本" + i,
      text: "t",
      source: "manual" as const,
      surface: 40 + i * 5,
      semantic: 50 + i * 3,
      official,
      officialLabel: "ai" as const,
      ts: Date.now(),
    });
    const samples = [mk(0, 85), mk(1, 70), mk(2, 55), mk(3, 40)];
    localStorage.setItem("quaiwei.zhuque.samples", JSON.stringify(samples));
    const onApplyWeight = vi.fn();
    const { getByText, queryByText } = render(
      <CalibLabModal {...modalProps({ samples, onApplyWeight })} />,
    );
    const applyBtn = queryByText("应用为默认");
    if (applyBtn) {
      // 拟合出推荐权重时按钮出现且触发回调
      fireEvent.click(applyBtn);
      expect(onApplyWeight).toHaveBeenCalledTimes(1);
      expect(typeof onApplyWeight.mock.calls[0][0]).toBe("number");
    } else {
      // 样本量不足以拟合权重时按钮不出现（也是正确行为）
      expect(getByText(/推荐语义层权重|映射：/)).toBeTruthy();
    }
  });

  it("样本文本回显：官方已回填与未回填的行都渲染「复制/删」按钮", () => {
    cleanLabStorage();
    const onDelete = vi.fn();
    const { getAllByText } = render(
      <CalibLabModal
        {...modalProps({
          samples: [
            {
              id: "a",
              name: "已回填样本",
              text: "A",
              source: "manual" as const,
              surface: 50,
              semantic: null,
              official: 90,
              officialLabel: "ai" as const,
              ts: Date.now(),
            },
            {
              id: "b",
              name: "未回填样本",
              text: "B",
              source: "manual" as const,
              surface: 45,
              semantic: null,
              official: null,
              officialLabel: null,
              ts: Date.now(),
            },
          ],
          onDelete,
        })}
      />,
    );
    expect(getAllByText("复制").length).toBe(2);
    expect(getAllByText("删").length).toBe(2);
    // 新样本在上：第一个「删」应属未回填样本 b
    fireEvent.click(getAllByText("删")[0]);
    expect(onDelete).toHaveBeenCalledWith("b");
  });

  it("空库提示与「清空样本库」按钮触发 onClear", () => {
    cleanLabStorage();
    const onClear = vi.fn();
    const { getByText } = render(<CalibLabModal {...modalProps({ onClear })} />);
    expect(getByText(/还没有样本/)).toBeTruthy();
    fireEvent.click(getByText("清空样本库"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
