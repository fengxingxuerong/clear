// @vitest-environment happy-dom
/**
 * 简洁模式（v0.9.48 面向用户的成品外壳）测试。
 *
 * v0.9.48 之前界面是**开发调参视图**：15 个按钮 + 6 个工程面板平铺。
 * 现在默认给用户的是「粘贴 → 去味 → 复制」这条主流程，工程面板收进专业模式。
 *
 * 本文件只测简洁档的产品形态；专业档的接线由 App.test.tsx 覆盖
 * （那里 beforeEach 显式 saveViewMode("pro")）。
 *
 * 引擎走真实本地实现（不 mock runHumanize）：本地路径不需要联网，
 * 而且这样断言的是"用户真的能跑完一次"而不是"mock 返回了"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import App from "./App";
import { aiScore } from "./engine/humanize";
import { loadViewMode } from "./store";

const INPUT_TEXT =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。";

/**
 * 专业档才有的入口（简洁档必须一个都不出现）。
 * 「朱雀增强」是 label.mode-tag（文本里带 emoji，getByText 精确匹配不到）⇒ 用选择器。
 */
const PRO_ONLY: { text?: string; sel?: string }[] = [
  { sel: "label.mode-tag" }, // 朱雀增强
  { text: "导出 .txt" },
  { text: "导出 .docx" },
  { text: "对比" },
  { text: "为什么这么改" },
  { text: "历史" },
  { text: "指纹体检" },
  { text: "AI 检测" },
  { text: "朱雀检测" },
];

/** 简洁档主流程必须有 */
const CORE_BUTTONS = ["去味", "复制", "导入", "清空", "示例"];

beforeEach(() => {
  localStorage.clear(); // 不预设 view ⇒ 默认简洁模式（这就是被测对象）
  // happy-dom 无真实剪贴板；App 用的是 navigator.clipboard?.writeText
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** 走完整闭环：粘稿 → 点去味 → 等产出（本地引擎，毫秒级） */
async function runOnce(utils: ReturnType<typeof render>) {
  const pane = utils.getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement;
  fireEvent.change(pane, { target: { value: INPUT_TEXT } });
  fireEvent.click(utils.getByText("去味"));
  await waitFor(() => {
    const out = utils.getByPlaceholderText(/点击「去味」生成/) as HTMLTextAreaElement;
    expect(out.value.length).toBeGreaterThan(0);
  });
}

describe("简洁模式：默认形态", () => {
  it("第一次打开就是简洁模式（不预设任何配置时）", () => {
    expect(loadViewMode()).toBe("simple");
    const { getByText } = render(<App />);
    expect(getByText("简洁")).toBeTruthy();
  });

  it("三步引导出现：用户最需要的是「我该干什么」", () => {
    const { getByText } = render(<App />);
    expect(getByText("① 把 AI 写的稿子粘进左边")).toBeTruthy();
    expect(getByText("② 点「去味」")).toBeTruthy();
    expect(getByText("③ 复制右边的结果")).toBeTruthy();
  });

  it("主流程按钮齐备", () => {
    const { getByText } = render(<App />);
    for (const t of CORE_BUTTONS) {
      expect(getByText(t), `缺少主流程按钮：${t}`).toBeTruthy();
    }
  });

  it("工程面板入口一个都不出现（那些词对只想改稿的人是噪音）", () => {
    const { queryByText, container } = render(<App />);
    for (const p of PRO_ONLY) {
      if (p.sel) expect(container.querySelector(p.sel), `简洁档不该出现：${p.sel}`).toBeNull();
      else expect(queryByText(p.text!), `简洁档不该出现：${p.text}`).toBeNull();
    }
  });

  it("流水线追踪面板不渲染（默认不给用户看逐步骤调试视图）", () => {
    const { container } = render(<App />);
    expect(container.querySelector(".pipe")).toBeNull();
  });

  it("强度滑块配人话标签，不只给一个百分比", () => {
    const { getByText } = render(<App />);
    // 默认 0.6 → 「标准」
    expect(getByText(/标准：换词 \+ 调句式/)).toBeTruthy();
  });
});

describe("简洁模式：去味闭环与结果条", () => {
  it("去味后出现结果条：分数、人话结论、复制与导出", async () => {
    const utils = render(<App />);
    await runOnce(utils);

    const bar = utils.container.querySelector(".resultbar");
    expect(bar, "结果条没出现").toBeTruthy();

    const before = aiScore(INPUT_TEXT).score;
    const scoreBox = utils.container.querySelector(".result-score")!;
    expect(scoreBox.textContent).toContain("AI 味");
    expect(scoreBox.textContent).toContain(String(before));

    // 结论必须是四种人话之一，不能是空白或技术术语
    expect(scoreBox.textContent).toMatch(/几乎没有 AI 味|已经落在人写区间|还有点味道|AI 味偏重/);

    expect(utils.getByText("复制结果")).toBeTruthy();
    expect(utils.getByText("导出 .docx")).toBeTruthy();
    expect(utils.getByText("导出 .txt")).toBeTruthy();
  });

  it("点「复制结果」真的写剪贴板", async () => {
    const utils = render(<App />);
    await runOnce(utils);
    fireEvent.click(utils.getByText("复制结果"));
    await waitFor(() => {
      expect(navigator.clipboard.writeText as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });
  });

  it("产出后三步引导撤掉（腾地方给结果）", async () => {
    const utils = render(<App />);
    await runOnce(utils);
    expect(utils.queryByText("① 把 AI 写的稿子粘进左边")).toBeNull();
  });
});

describe("模式切换：用户可随时切到专业，选择被记住", () => {
  it("切到专业后工程按钮出现，且写进 localStorage", () => {
    const { getByText, container } = render(<App />);
    fireEvent.click(getByText("专业"));
    expect(loadViewMode()).toBe("pro");
    for (const p of PRO_ONLY) {
      if (p.sel) expect(container.querySelector(p.sel), `专业档缺少：${p.sel}`).toBeTruthy();
      else expect(getByText(p.text!), `专业档缺少：${p.text}`).toBeTruthy();
    }
  });

  it("专业模式跨会话保留（localStorage 里存的是 pro）", () => {
    const { getByText } = render(<App />);
    fireEvent.click(getByText("专业"));
    cleanup();
    // 不 clear localStorage —— 模拟重新打开
    const second = render(<App />);
    expect(second.getByText("专业")).toBeTruthy();
    expect(second.getByText("指纹体检")).toBeTruthy();
  });

  it("从专业切回简洁，工程入口收回", () => {
    const { getByText, queryByText } = render(<App />);
    fireEvent.click(getByText("专业"));
    expect(getByText("指纹体检")).toBeTruthy();
    fireEvent.click(getByText("简洁"));
    expect(loadViewMode()).toBe("simple");
    expect(queryByText("指纹体检")).toBeNull();
  });

  it("切到专业后流水线面板回归（trace 仍然产出，只是默认不露）", async () => {
    // 默认设置开着多候选择优（DEFAULT_LOCAL.bestOf = true），那个模式按设计
    // **不产出逐步 trace**——N 个候选并行跑完整条流水线，逐个记录会互相穿插。
    // 这里显式关掉择优，验的是「关掉后 trace 照样产出，且只在专业档可见」。
    localStorage.setItem("aihumanizer.local", JSON.stringify({ bestOf: false, candidates: 8 }));
    const utils = render(<App />);
    await runOnce(utils);
    expect(utils.container.querySelector(".pipe")).toBeNull();
    fireEvent.click(utils.getByText("专业"));
    expect(utils.container.querySelector(".pipe")).toBeTruthy();
    expect(utils.getByText(/流水线追踪/)).toBeTruthy();
  });
});
