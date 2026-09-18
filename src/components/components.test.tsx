// @vitest-environment happy-dom
/**
 * 六个基础 UI 组件的渲染级测试（v0.8.7 测试迭代补盲）：
 * ScoreBadge / TextPane / DiffView / HistoryPanel / ErrorBoundary / FingerprintPanel。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { ScoreBadge } from "./ScoreBadge";
import { TextPane } from "./TextPane";
import { DiffView } from "./DiffView";
import { HistoryPanel } from "./HistoryPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { FingerprintPanel } from "./FingerprintPanel";
import { diffSentences } from "../engine/diff";
import type { ScoreBreakdown } from "../engine/humanize";
import type { HistoryEntry } from "../store-history";

afterEach(() => cleanup());

const hi: ScoreBreakdown = {
  score: 82,
  formulaicHits: 9,
  burstiness: 0.2,
  avgLen: 30,
  sentenceCount: 4,
};
const lo: ScoreBreakdown = {
  score: 22,
  formulaicHits: 1,
  burstiness: 0.5,
  avgLen: 15,
  sentenceCount: 2,
};
const mid: ScoreBreakdown = {
  score: 45,
  formulaicHits: 4,
  burstiness: 0.3,
  avgLen: 22,
  sentenceCount: 3,
};

describe("ScoreBadge（评分徽章）", () => {
  it("渲染标签、分数与三项明细", () => {
    const { getByText } = render(<ScoreBadge label="原文" s={hi} tone="before" />);
    expect(getByText("原文")).toBeTruthy();
    expect(getByText("82")).toBeTruthy();
    expect(getByText("套话 9 · 跳脱 0.2 · 均长 30")).toBeTruthy();
  });

  it("高危红（≥60）/ 中档橙（≥35）/ 低危绿（<35）三档配色", () => {
    const red = render(<ScoreBadge label="a" s={hi} tone="before" />).getByText(
      "82",
    ) as HTMLElement;
    expect(red.style.color).toBe("#ff5d6c");
    const orange = render(<ScoreBadge label="b" s={mid} tone="before" />).getByText(
      "45",
    ) as HTMLElement;
    expect(orange.style.color).toBe("#ffb454");
    const green = render(<ScoreBadge label="c" s={lo} tone="after" />).getByText(
      "22",
    ) as HTMLElement;
    expect(green.style.color).toBe("#3ddc97");
  });
});

describe("TextPane（受控输入面板）", () => {
  it("渲染标签、placeholder 与实时字数", () => {
    const { getByText, getByPlaceholderText } = render(
      <TextPane label="输入区" value="一二三" placeholder="粘贴文章" onChange={() => {}} />,
    );
    expect(getByText("输入区")).toBeTruthy();
    expect(getByText("3 字")).toBeTruthy();
    expect((getByPlaceholderText("粘贴文章") as HTMLTextAreaElement).value).toBe("一二三");
  });

  it("输入触发 onChange；快捷键触发 onHotkey", () => {
    const onChange = vi.fn();
    const onHotkey = vi.fn();
    const { getByPlaceholderText } = render(
      <TextPane label="" value="" placeholder="p" onChange={onChange} onHotkey={onHotkey} />,
    );
    const ta = getByPlaceholderText("p") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "新文本" } });
    expect(onChange).toHaveBeenCalledWith("新文本");
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    expect(onHotkey).toHaveBeenCalledTimes(1);
  });

  it("字数统计随 value 更新（受控）", () => {
    const { getByText, rerender } = render(
      <TextPane label="" value="ab" placeholder="" onChange={() => {}} />,
    );
    expect(getByText("2 字")).toBeTruthy();
    rerender(<TextPane label="" value="abcde" placeholder="" onChange={() => {}} />);
    expect(getByText("5 字")).toBeTruthy();
  });
});

describe("DiffView（去味前后对比）", () => {
  it("有改动时显示改动数，双栏渲染原文/去味后", () => {
    const before = "第一句话没变。第二句要被换掉。";
    const after = "第一句话没变。第二句换了个说法。";
    const { left, right } = diffSentences(before, after);
    expect(left.some((p) => p.type === "del")).toBe(true);
    expect(right.some((p) => p.type === "ins")).toBe(true);
    const { getByText } = render(<DiffView before={before} after={after} onClose={() => {}} />);
    expect(getByText(/改动了 \d+ 处/)).toBeTruthy();
    expect(getByText("原文（AI 稿）")).toBeTruthy();
    expect(getByText("去味后")).toBeTruthy();
  });

  it("无改动时显示「无改动」", () => {
    const { getByText } = render(
      <DiffView before="一样的话。" after="一样的话。" onClose={() => {}} />,
    );
    expect(getByText(/无改动/)).toBeTruthy();
  });

  it("点关闭按钮与点遮罩都触发 onClose；点弹窗内容不触发", () => {
    const onClose = vi.fn();
    const { getByText, container } = render(
      <DiffView before="A。" after="B。" onClose={onClose} />,
    );
    // 点遮罩（modal-mask 自身）
    fireEvent.click(container.querySelector(".modal-mask")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    // 点弹窗内部（stopPropagation）
    fireEvent.click(container.querySelector(".diff-modal")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(getByText("关闭"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("HistoryPanel（去味历史）", () => {
  const e1: HistoryEntry = {
    id: "h1",
    input: "一段被去味的原文内容",
    output: "输出",
    beforeScore: 75,
    afterScore: 20,
    intensity: 0.7,
    usedApi: false,
    timestamp: Date.now() - 5 * 60 * 1000,
  };
  const e2: HistoryEntry = {
    ...e1,
    id: "h2",
    usedApi: true,
    timestamp: Date.now() - 3 * 60 * 60 * 1000,
  };

  function props(overrides: Partial<Parameters<typeof HistoryPanel>[0]> = {}) {
    return {
      entries: [] as HistoryEntry[],
      onLoad: vi.fn(),
      onClear: vi.fn(),
      onClose: vi.fn(),
      ...overrides,
    };
  }

  it("空历史：提示文案，「清空历史」禁用", () => {
    const p = props();
    const { getByText } = render(<HistoryPanel {...p} />);
    expect(getByText(/暂无历史记录/)).toBeTruthy();
    expect((getByText("清空历史") as HTMLButtonElement).disabled).toBe(true);
    expect(getByText(/最近 0 条/)).toBeTruthy();
  });

  it("有历史：条目含相对时间/强度/通道与降幅，清空按钮可用", () => {
    const p = props({ entries: [e1] });
    const { container, getByText } = render(<HistoryPanel {...p} />);
    expect(container.textContent).toContain("5 分钟前");
    expect(container.textContent).toContain("强度 70%");
    expect(container.textContent).toContain("本地引擎");
    expect(container.textContent).toContain("降 55 分");
    const clear = getByText("清空历史") as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    expect(p.onClear).toHaveBeenCalledTimes(1);
  });

  it("点条目触发 onLoad 并自动关闭；无 engine 字段的旧记录按 usedApi 推断", () => {
    const p = props({ entries: [e2, e1] });
    const { container, getAllByText } = render(<HistoryPanel {...p} />);
    expect(container.textContent).toContain("3 小时前");
    expect(container.textContent).toContain("LLM");
    fireEvent.click(getAllByText("一段被去味的原文内容…")[0]);
    expect(p.onLoad).toHaveBeenCalledWith(e2);
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it("混拼条目必须显式标出（usedApi=true 不代表整稿都来自 LLM）", () => {
    const mixed: HistoryEntry = { ...e2, id: "h3", engine: "mixed" };
    const passthrough: HistoryEntry = { ...e1, id: "h4", engine: "passthrough" };
    const { container } = render(<HistoryPanel {...props({ entries: [mixed, passthrough] })} />);
    expect(container.textContent).toContain("LLM+本地混拼");
    expect(container.textContent).toContain("未处理（过短）");
  });

  it("点关闭按钮触发 onClose", () => {
    const p = props({ entries: [e1] });
    const { getByText } = render(<HistoryPanel {...p} />);
    fireEvent.click(getByText("关闭"));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ErrorBoundary（全局错误边界）", () => {
  // 静默 React 打印的预期错误
  let spy: ReturnType<typeof vi.spyOn>;
  function Boom(): never {
    throw new Error("测试爆炸");
  }

  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it("无异常时正常渲染 children", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <div>正常内容</div>
      </ErrorBoundary>,
    );
    expect(getByText("正常内容")).toBeTruthy();
  });

  it("子组件抛错时显示兜底界面（含错误信息与重载按钮）", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(getByText("界面出了点问题")).toBeTruthy();
    expect(getByText("测试爆炸")).toBeTruthy();
    expect(getByText("重载应用")).toBeTruthy();
  });
});

describe("FingerprintPanel（指纹体检面板）", () => {
  function base(overrides: Partial<Parameters<typeof FingerprintPanel>[0]> = {}) {
    return {
      fingerprint: null,
      fidelity: null,
      checkingOutput: false,
      pplEnabled: false,
      pplState: "idle" as const,
      pplFeature: null,
      pplIssues: null,
      pplProgress: null,
      pplNote: null,
      onDownloadPpl: vi.fn(),
      ...overrides,
    };
  }

  it("fingerprint 为 null 时整块不渲染", () => {
    const { container } = render(<FingerprintPanel {...base()} />);
    expect(container.textContent).toBe("");
  });

  it("体检通过：显示 CV 与标准差；检查对象文案随 checkingOutput 切换", () => {
    const fp = { pass: true, issues: [], sentenceCV: 0.42, sentenceStd: 6.2 };
    const { getByText, rerender } = render(<FingerprintPanel {...base({ fingerprint: fp })} />);
    expect(getByText(/检查原文/)).toBeTruthy();
    expect(getByText(/句长CV 0.42 \/ 标准差 6.2/)).toBeTruthy();
    rerender(<FingerprintPanel {...base({ fingerprint: fp, checkingOutput: true })} />);
    expect(getByText(/检查去味结果/)).toBeTruthy();
  });

  it("体检不通过：逐项渲染指纹（名称×次数+提示）与忠实度问题", () => {
    const fp = {
      pass: false,
      issues: [{ name: "中英空格", count: 3, hint: "AI 训练语料爱留空格" }],
      sentenceCV: 0.1,
    };
    const { getByText } = render(
      <FingerprintPanel
        {...base({
          fingerprint: fp,
          fidelity: { pass: false, problems: ["数字被篡改"] },
        })}
      />,
    );
    expect(getByText("· 中英空格 ×3")).toBeTruthy();
    expect(getByText("AI 训练语料爱留空格")).toBeTruthy();
    expect(getByText("· 忠实度：数字被篡改")).toBeTruthy();
  });

  it("ppl 状态机：need-download 显示下载按钮；downloading 显示进度；error/unsupported 提示", () => {
    const onDownloadPpl = vi.fn();
    const fp = { pass: true, issues: [], sentenceCV: 0.4 };
    const a = render(
      <FingerprintPanel
        {...base({ fingerprint: fp, pplEnabled: true, pplState: "need-download", onDownloadPpl })}
      />,
    );
    const btn = a.getByText("下载模型（约 100MB，仅一次，之后离线）");
    fireEvent.click(btn);
    expect(onDownloadPpl).toHaveBeenCalledTimes(1);
    a.unmount();

    const b = render(
      <FingerprintPanel
        {...base({ fingerprint: fp, pplEnabled: true, pplState: "downloading", pplProgress: 42 })}
      />,
    );
    expect(b.container.textContent).toContain("正在下载模型 42%");
    b.unmount();

    const c = render(
      <FingerprintPanel {...base({ fingerprint: fp, pplEnabled: true, pplState: "error" })} />,
    );
    expect(c.getByText(/困惑度检查本次不可用/)).toBeTruthy();
    c.unmount();

    const d = render(
      <FingerprintPanel
        {...base({ fingerprint: fp, pplEnabled: true, pplState: "unsupported" })}
      />,
    );
    expect(d.getByText(/当前环境不支持困惑度检查/)).toBeTruthy();
  });

  it("ppl done：无问题显示正常+统计，有问题逐条渲染；pplNote 透传", () => {
    const fp = { pass: true, issues: [], sentenceCV: 0.4 };
    const feature = { meanNll: 1.234, winStd: 0.56, scoredChars: 500, windows: [] };
    const a = render(
      <FingerprintPanel
        {...base({
          fingerprint: fp,
          pplEnabled: true,
          pplState: "done",
          pplFeature: feature,
          pplIssues: [],
          pplNote: "这是备注",
        })}
      />,
    );
    expect(a.container.textContent).toContain("困惑度特征正常");
    expect(a.container.textContent).toContain("字均NLL 1.23 nat · 窗间σ 0.56");
    expect(a.container.textContent).toContain("这是备注");
    a.unmount();

    const b = render(
      <FingerprintPanel
        {...base({
          fingerprint: fp,
          pplEnabled: true,
          pplState: "done",
          pplIssues: [{ name: "全文置信度过高", count: 1, hint: "过于可预测" }],
        })}
      />,
    );
    expect(b.getByText("· 全文置信度过高")).toBeTruthy();
    expect(b.getByText("过于可预测")).toBeTruthy();
  });

  it("pplEnabled=false 时困惑度区域整块不出现", () => {
    const fp = { pass: true, issues: [], sentenceCV: 0.4 };
    const { queryByText } = render(
      <FingerprintPanel
        {...base({ fingerprint: fp, pplEnabled: false, pplState: "need-download" })}
      />,
    );
    expect(queryByText(/下载模型/)).toBeNull();
  });
});

describe("DiffView 字符级渲染", () => {
  it("未改动的字单独成 same 片段，标题带改动率", () => {
    const before = "值得注意的是，这道菜非常好吃。";
    const after = "说白了，这道菜挺好吃。";
    const { container, getByText } = render(<DiffView before={before} after={after} onClose={() => {}} />);
    // 两处独立改动 → 两个 del 块，中间的"这道菜"必须是未被涂色的 same
    expect(container.querySelectorAll(".diff-col-body .diff-del").length).toBeGreaterThanOrEqual(2);
    const sameText = [...container.querySelectorAll(".diff-col-body .diff-same")].map((e) => e.textContent).join("");
    expect(sameText).toContain("这道菜");
    expect(getByText(/\/\d+ 字（\d+%）/)).toBeTruthy();
  });

  it("改动率随改动规模变化，无改动时为「无改动」", () => {
    const small = render(<DiffView before="这是一句完全正常的人话没有套话。" after="这是一句完全正常的人话没有废话。" onClose={() => {}} />);
    const big = render(<DiffView before="这是一句完全正常的人话没有套话。" after="换掉了一大半的内容完全不同的句子。" onClose={() => {}} />);
    const pct = (c: HTMLElement) => Number(c.querySelector(".modal-head span")!.textContent!.match(/（(\d+)%）/)?.[1] ?? -1);
    expect(pct(big.container)).toBeGreaterThan(pct(small.container));
    small.unmount();
    const none = render(<DiffView before="同一句。" after="同一句。" onClose={() => {}} />);
    expect(none.getByText(/无改动/)).toBeTruthy();
  });
});
