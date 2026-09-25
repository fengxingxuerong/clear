// @vitest-environment happy-dom
/**
 * App 主界面渲染级测试（v0.9.16 测试迭代第五轮）。
 *
 * 此前 App.tsx（986 行主组件）语句覆盖仅 36.7%，是全项目最大的测试洞。
 * 本文件用 mock 隔离网络依赖（api/llm、ppl-client、zhuque-semantic、detector），
 * 引擎与 store 走真实实现，覆盖：渲染冒烟 / 示例载入 / 去味闭环（本地与 LLM 引擎
 * 两种产出来源的界面文案）/ 空输入守卫 / Ctrl+Enter 热键 / 强度持久化 / 历史落盘。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import App from "./App";
import { aiScore } from "./engine/humanize";
import { loadHistory } from "./store-history";
import { loadIntensity } from "./store";

const { runHumanizeMock } = vi.hoisted(() => ({ runHumanizeMock: vi.fn() }));

// 混合 mock：保留真实导出（DEFAULT_API / DEFAULT_DETECTOR / SENSENOVA_PRESET 等
// 被 store 与 SettingsModal 依赖），只替换会触网 / 依赖宿主推理的函数。
vi.mock("./api/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/llm")>()),
  runHumanize: runHumanizeMock,
}));

vi.mock("./ppl/ppl-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ppl/ppl-client")>()),
  computePplFeature: vi.fn(),
  ensurePplModel: vi.fn(),
  pplStatus: vi.fn(async () => ({ supported: false, ready: false })),
  isPplReady: () => false,
}));

vi.mock("./api/zhuque-semantic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/zhuque-semantic")>()),
  detectSemanticStable: vi.fn(),
  semanticAvailable: () => false,
}));

vi.mock("./api/detector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/detector")>()),
  scoreViaDetector: vi.fn(),
}));

const INPUT_TEXT =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。";

const OUTPUT_TEXT =
  "说真的，这行变化快得让人眼花。办公的活儿确实省力了不少，成本也压下来了。可挑战也实实在在地摆在眼前，躲不开。";

function makeRunResult(text: string, engine: string, usedApi = false, roundScores: number[] = []) {
  return {
    text,
    before: aiScore(INPUT_TEXT),
    after: aiScore(text),
    usedApi,
    engine,
    degrade: [],
    note: "",
    roundScores,
  };
}

const INPUT_PLACEHOLDER_PREFIX = "把 AI 写的文章粘进来";

async function renderApp() {
  const utils = render(<App />);
  const inputPane = utils.getByPlaceholderText(new RegExp(INPUT_PLACEHOLDER_PREFIX));
  return { ...utils, inputPane };
}

beforeEach(() => {
  localStorage.clear();
  runHumanizeMock.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("App 渲染冒烟", () => {
  it("主界面：标题、双输入区、去味按钮、强度滑块齐备", () => {
    const { getByText, getByPlaceholderText, container } = render(<App />);
    expect(getByText("趣AI味 · QuAiWei")).toBeTruthy();
    expect(getByPlaceholderText(/把 AI 写的文章粘进来/)).toBeTruthy();
    expect(getByPlaceholderText(/点击「去味」生成/)).toBeTruthy();
    expect(getByText("去味")).toBeTruthy();
    expect(container.querySelector('input[type="range"]')).toBeTruthy();
  });

  it("「示例」按钮：载入样例文本并给出提示", () => {
    const { getByText, getByPlaceholderText } = render(<App />);
    fireEvent.click(getByText("示例"));
    const pane = getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement;
    expect(pane.value.length).toBeGreaterThan(50);
    expect(getByText(/已载入示例文本/)).toBeTruthy();
  });

  it("「清空」按钮：清空输入并丢弃草稿", () => {
    const { getByText, getByPlaceholderText } = render(<App />);
    fireEvent.click(getByText("示例"));
    expect((getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement).value.length).toBeGreaterThan(0);
    fireEvent.click(getByText("清空"));
    expect((getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement).value).toBe("");
  });
});

describe("App 去味闭环", () => {
  it("本地引擎产出：输出面板显示去味稿，界面文案如实写「使用本地引擎去味」", async () => {
    runHumanizeMock.mockResolvedValue(makeRunResult(OUTPUT_TEXT, "local"));
    const { getByText, getByPlaceholderText } = await renderApp();
    fireEvent.change(getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(getByText("去味"));
    await waitFor(() => {
      expect((getByPlaceholderText(/点击「去味」生成/) as HTMLTextAreaElement).value).toBe(
        OUTPUT_TEXT,
      );
    });
    expect(runHumanizeMock).toHaveBeenCalledTimes(1);
    expect(getByText(/使用本地引擎去味/)).toBeTruthy();
  });

  it("LLM 引擎产出：界面文案如实写「已使用 API 深度去味」", async () => {
    runHumanizeMock.mockResolvedValue(makeRunResult(OUTPUT_TEXT, "llm", true, [88]));
    const { getByText, getByPlaceholderText } = await renderApp();
    fireEvent.change(getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(getByText("去味"));
    await waitFor(() => {
      expect(getByText(/已使用 API 深度去味/)).toBeTruthy();
    });
  });

  it("空输入点「去味」：不触发任何调用", async () => {
    const { getByText } = await renderApp();
    fireEvent.click(getByText("去味"));
    await waitFor(() => {
      expect(runHumanizeMock).not.toHaveBeenCalled();
    });
  });

  it("Ctrl+Enter 热键触发去味", async () => {
    runHumanizeMock.mockResolvedValue(makeRunResult(OUTPUT_TEXT, "local"));
    const { getByText, getByPlaceholderText } = await renderApp();
    const pane = getByPlaceholderText(/把 AI 写的文章粘进来/);
    fireEvent.change(pane, { target: { value: INPUT_TEXT } });
    fireEvent.keyDown(pane, { key: "Enter", ctrlKey: true });
    await waitFor(() => {
      expect(runHumanizeMock).toHaveBeenCalledTimes(1);
    });
    expect(getByText(/使用本地引擎去味/)).toBeTruthy();
  });

  it("runHumanize 抛错：界面给出错误提示且不崩", async () => {
    runHumanizeMock.mockRejectedValue(new Error("网关 504"));
    const { getByText, getByPlaceholderText } = await renderApp();
    fireEvent.change(getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(getByText("去味"));
    await waitFor(() => {
      expect(getByText(/504/)).toBeTruthy();
    });
  });
});

describe("App 持久化", () => {
  it("去味完成后历史落盘一条（含原文与产出）", async () => {
    runHumanizeMock.mockResolvedValue(makeRunResult(OUTPUT_TEXT, "local"));
    const { getByText, getByPlaceholderText } = await renderApp();
    fireEvent.change(getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(getByText("去味"));
    await waitFor(() => {
      expect(loadHistory().length).toBe(1);
    });
    const entry = loadHistory()[0];
    expect(entry.input).toBe(INPUT_TEXT);
    expect(entry.output).toBe(OUTPUT_TEXT);
  });

  it("强度滑块变更写入 localStorage（300ms 防抖后落盘）", async () => {
    const { container } = render(<App />);
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.85" } });
    await waitFor(
      () => {
        expect(loadIntensity()).toBeCloseTo(0.85, 5);
      },
      { timeout: 1500 },
    );
  });
});

describe("App 设置弹窗", () => {
  it("点齿轮打开 API 设置弹窗，Esc 可关闭", () => {
    const { getByText, container } = render(<App />);
    fireEvent.click(getByText("⚙ 设置"));
    expect(getByText("API 设置（可选）")).toBeTruthy();
    // Esc 关闭（桌面应用标配交互）
    fireEvent.keyDown(container.querySelector(".app") ?? container, { key: "Escape" });
    expect(container.querySelector('[aria-label="API 设置"]')).toBeNull();
  });

  it("历史按钮打开历史面板：无历史时显示空态", () => {
    const { getByText } = render(<App />);
    fireEvent.click(getByText("历史"));
    expect(getByText(/暂无历史|还没有|历史记录/)).toBeTruthy();
  });
});
