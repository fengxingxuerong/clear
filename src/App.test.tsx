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
import { render, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import App from "./App";
import { aiScore } from "./engine/humanize";
import { loadHistory } from "./store-history";
import { loadIntensity, saveDraft, loadDraft, loadZhuqueMode, loadDetector } from "./store";
import { DEFAULT_API } from "./api/llm-config";
import { DEFAULT_DETECTOR } from "./api/detector";

const {
  runHumanizeMock,
  readDocxTextMock,
  createObjectURLMock,
  judgeScoreStableMock,
  writeDocxTextMock,
  scoreViaDetectorMock,
  computePplFeatureMock,
  ensurePplModelMock,
  pplStatusMock,
  isPplReadyMock,
  detectSemanticStableMock,
  semanticAvailableMock,
} = vi.hoisted(() => ({
  runHumanizeMock: vi.fn(),
  readDocxTextMock: vi.fn(),
  createObjectURLMock: vi.fn(),
  judgeScoreStableMock: vi.fn(),
  writeDocxTextMock: vi.fn(),
  scoreViaDetectorMock: vi.fn(),
  computePplFeatureMock: vi.fn(),
  ensurePplModelMock: vi.fn(),
  pplStatusMock: vi.fn(),
  isPplReadyMock: vi.fn(() => false),
  // 语义层：默认不可用（与真实 Web 版一致）；个别用例临时打开验证回调链
  detectSemanticStableMock: vi.fn(),
  semanticAvailableMock: vi.fn(() => false),
}));

// 混合 mock：保留真实导出（DEFAULT_API / DEFAULT_DETECTOR / SENSENOVA_PRESET 等
// 被 store 与 SettingsModal 依赖），只替换会触网 / 依赖宿主推理的函数。
vi.mock("./api/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/llm")>()),
  runHumanize: runHumanizeMock,
  judgeScoreStable: judgeScoreStableMock,
}));

// docx-io：readDocxText 换成可控 mock（导入路径分支测试用）；
// writeDocxText 默认转发真实实现（导出测试捕获真实生成的 Blob），
// 失败分支用例可临时覆盖为 rejected。真实实现经 hoisted 容器中转，
// 规避 vi.mock 工厂先于 let 声明执行的 TDZ 问题。
const docxReal = vi.hoisted(() => ({
  writeDocxText: null as null | ((text: string) => Promise<Blob>),
}));
vi.mock("./docx-io", async (importOriginal) => {
  const real = await importOriginal<typeof import("./docx-io")>();
  docxReal.writeDocxText = real.writeDocxText;
  return { ...real, readDocxText: readDocxTextMock, writeDocxText: writeDocxTextMock };
});

vi.mock("./ppl/ppl-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ppl/ppl-client")>()),
  computePplFeature: computePplFeatureMock,
  ensurePplModel: ensurePplModelMock,
  pplStatus: pplStatusMock,
  isPplReady: isPplReadyMock,
}));

vi.mock("./api/zhuque-semantic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/zhuque-semantic")>()),
  detectSemanticStable: detectSemanticStableMock,
  semanticAvailable: semanticAvailableMock,
}));

vi.mock("./api/detector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/detector")>()),
  scoreViaDetector: scoreViaDetectorMock,
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
  readDocxTextMock.mockReset();
  judgeScoreStableMock.mockReset();
  scoreViaDetectorMock.mockReset();
  computePplFeatureMock.mockReset();
  ensurePplModelMock.mockReset();
  pplStatusMock.mockReset();
  isPplReadyMock.mockReset();
  isPplReadyMock.mockReturnValue(false);
  detectSemanticStableMock.mockReset();
  semanticAvailableMock.mockReset();
  semanticAvailableMock.mockReturnValue(false);
  writeDocxTextMock.mockReset();
  writeDocxTextMock.mockImplementation((t: string) => docxReal.writeDocxText!(t));
  // happy-dom 未实现 URL.createObjectURL/revokeObjectURL——直接赋值 stub（下载路径断言用）
  (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURLMock;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  createObjectURLMock.mockReset();
  createObjectURLMock.mockReturnValue("blob:mock-url");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  // 加密桥只在个别用例里临时挂上；测完必摘，避免污染后续用例的 hasSecureStore 判定
  delete (window as unknown as { secureStore?: unknown }).secureStore;
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
    expect(
      (getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement).value.length,
    ).toBeGreaterThan(0);
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

describe("App 文件导入 / 导出（v0.9.15/16/17 UI 能力补锁）", () => {
  function getFileInput(container: HTMLElement): HTMLInputElement {
    return container.querySelector('input[type="file"]') as HTMLInputElement;
  }

  it("导入 .docx：走 readDocxText 提取，文本进输入面板并给出提示", async () => {
    readDocxTextMock.mockResolvedValue("从 Word 文档里提取出来的正文。");
    const { getByText, getByPlaceholderText, container } = await renderApp();
    const file = new File(["binary-docx-bytes"], "报告.docx");
    fireEvent.change(getFileInput(container), { target: { files: [file] } });
    await waitFor(() => {
      expect(getByText(/已导入 报告\.docx（\d+ 字，格式不保留）/)).toBeTruthy();
    });
    expect((getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement).value).toBe(
      "从 Word 文档里提取出来的正文。",
    );
    expect(readDocxTextMock).toHaveBeenCalledTimes(1);
  });

  it("导入空 docx：提示无文字且不写入输入面板", async () => {
    readDocxTextMock.mockResolvedValue("   ");
    const { getByText, getByPlaceholderText, container } = await renderApp();
    fireEvent.change(getFileInput(container), {
      target: { files: [new File(["x"], "空.docx")] },
    });
    await waitFor(() => {
      expect(getByText(/docx 里没有可提取的文字/)).toBeTruthy();
    });
    expect((getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement).value).toBe("");
  });

  it("导入坏 docx：解析失败给出真实原因且不崩", async () => {
    readDocxTextMock.mockRejectedValue(new Error("不是有效的 zip 文件（找不到 EOCD）"));
    const utils = await renderApp();
    fireEvent.change(getFileInput(utils.container), {
      target: { files: [new File(["garbage"], "坏.docx")] },
    });
    await waitFor(() => {
      expect(utils.getByText(/docx 解析失败：不是有效的 zip 文件/)).toBeTruthy();
    });
  });

  it("导入 .txt：走 FileReader 读文本并写入输入面板", async () => {
    const { getByText, getByPlaceholderText, container } = await renderApp();
    fireEvent.change(getFileInput(container), {
      target: { files: [new File(["纯文本内容一二三"], "笔记.txt")] },
    });
    await waitFor(() => {
      expect(getByText(/已导入 笔记\.txt（\d+ 字）/)).toBeTruthy();
    });
    expect((getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement).value).toBe(
      "纯文本内容一二三",
    );
  });

  it("导入超 2MB 文件：拒绝并提示走 CLI 批量", async () => {
    const big = new File([new ArrayBuffer(2 * 1024 * 1024 + 1)], "大文件.txt");
    const { getByText, container } = await renderApp();
    fireEvent.change(getFileInput(container), { target: { files: [big] } });
    await waitFor(() => {
      expect(getByText(/文件超过 2MB/)).toBeTruthy();
    });
    expect(readDocxTextMock).not.toHaveBeenCalled();
  });

  it("去味后导出 .docx：writeDocxText 真实生成 Blob 并触发下载", async () => {
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
    let captured: Blob | null = null;
    createObjectURLMock.mockImplementation((b: Blob) => {
      captured = b;
      return "blob:mock-url";
    });
    fireEvent.click(getByText("导出 .docx"));
    await waitFor(() => {
      expect(getByText(/已导出 \.docx/)).toBeTruthy();
    });
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(captured).toBeInstanceOf(Blob);
    expect(captured!.size).toBeGreaterThan(0);
  });

  it("无输出时导出按钮禁用：点击不触发任何下载", () => {
    const { getByText, container } = render(<App />);
    const txtBtn = getByText("导出 .txt") as HTMLButtonElement;
    const docxBtn = getByText("导出 .docx") as HTMLButtonElement;
    expect(txtBtn.disabled).toBe(true);
    expect(docxBtn.disabled).toBe(true);
    fireEvent.click(docxBtn);
    expect(createObjectURLMock).not.toHaveBeenCalled();
    expect(container).toBeTruthy();
  });

  it("导出 .txt：Blob 内容与去味输出逐字一致", async () => {
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
    let captured: Blob | null = null;
    createObjectURLMock.mockImplementation((b: Blob) => {
      captured = b;
      return "blob:mock-url";
    });
    fireEvent.click(getByText("导出 .txt"));
    await waitFor(() => {
      expect(getByText(/已导出 去味-\d{8}-\d{4}\.txt/)).toBeTruthy();
    });
    const text = await captured!.text();
    expect(text).toBe(OUTPUT_TEXT);
  });
});

describe("App 集成：评分 / 检测闭环 / 设置 / 历史 / 草稿 / 面板", () => {
  const ENABLED_API = { ...DEFAULT_API, enabled: true, apiKey: "sk-test" };
  const ENABLED_DETECTOR = {
    ...DEFAULT_DETECTOR,
    enabled: true,
    url: "http://detector.local/score",
  };

  async function humanizeFirst(utils: ReturnType<typeof render>) {
    runHumanizeMock.mockResolvedValue(makeRunResult(OUTPUT_TEXT, "local"));
    const { getByText, getByPlaceholderText } = utils;
    fireEvent.change(getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(getByText("去味"));
    await waitFor(() => {
      expect((getByPlaceholderText(/点击「去味」生成/) as HTMLTextAreaElement).value).toBe(
        OUTPUT_TEXT,
      );
    });
    return { getByText, getByPlaceholderText };
  }

  it("已配置检测器时去味后自动送检：真实分回显进文案", async () => {
    scoreViaDetectorMock.mockResolvedValue(21);
    const utils = render(<App initialDetector={ENABLED_DETECTOR} />);
    await humanizeFirst(utils);
    await waitFor(() => {
      expect(utils.getByText(/检测器自动送检：21 分/)).toBeTruthy();
    });
  });

  it("检测器自动送检失败：失败原因进文案且不崩", async () => {
    scoreViaDetectorMock.mockRejectedValue(new Error("502 Bad Gateway"));
    const utils = render(<App initialDetector={ENABLED_DETECTOR} />);
    await humanizeFirst(utils);
    await waitFor(() => {
      expect(utils.getByText(/检测器送检失败：502/)).toBeTruthy();
    });
  });

  it("深度模式轮次回调：评分中与评分失败两种播报都不崩（最终文案以结果为准）", async () => {
    runHumanizeMock.mockImplementation(
      async (
        _input: string,
        _i: number,
        _a: unknown,
        onRound?: (r: number, s: number | null, st?: string) => void,
      ) => {
        onRound?.(1, 88);
        onRound?.(2, null);
        return makeRunResult(OUTPUT_TEXT, "llm", true, [88, 0]);
      },
    );
    const { getByText, getByPlaceholderText } = await renderApp();
    fireEvent.change(getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(getByText("去味"));
    await waitFor(() => {
      expect(getByText(/已使用 API 深度去味/)).toBeTruthy();
    });
  });

  it("「用 LLM 评判」：成功后展示评判分与残留痕迹", async () => {
    judgeScoreStableMock.mockResolvedValue({ score: 21, critique: ["仍有总分总骨架"] });
    const utils = render(<App initialApi={ENABLED_API} />);
    const { getByText } = await humanizeFirst(utils);
    fireEvent.click(getByText("用 LLM 评判"));
    await waitFor(() => {
      expect(getByText(/LLM 评判：21/)).toBeTruthy();
      expect(getByText(/仍有总分总骨架/)).toBeTruthy();
    });
  });

  it("「用 LLM 评判」：失败给真实原因且不崩", async () => {
    judgeScoreStableMock.mockRejectedValue(new Error("网关 429"));
    const utils = render(<App initialApi={ENABLED_API} />);
    const { getByText } = await humanizeFirst(utils);
    fireEvent.click(getByText("用 LLM 评判"));
    await waitFor(() => {
      expect(getByText(/LLM 评判失败：网关 429/)).toBeTruthy();
    });
  });

  it("「用外部检测器」：手动送检回显分数", async () => {
    scoreViaDetectorMock.mockResolvedValue(35);
    const utils = render(<App initialDetector={ENABLED_DETECTOR} />);
    const { getByText } = await humanizeFirst(utils);
    fireEvent.click(getByText("用外部检测器"));
    await waitFor(() => {
      expect(getByText(/检测器：35/)).toBeTruthy();
    });
  });

  it("「复制」按钮：提示已复制到剪贴板", async () => {
    const utils = render(<App />);
    const { getByText } = await humanizeFirst(utils);
    fireEvent.click(getByText("复制"));
    expect(getByText("已复制到剪贴板")).toBeTruthy();
  });

  it("「AI 检测」：14 特征面板出现，特征明细可展开收起", async () => {
    const utils = render(<App />);
    await humanizeFirst(utils);
    fireEvent.click(utils.getByText("AI 检测"));
    fireEvent.click(utils.getByText("看特征明细"));
    expect(utils.getByText("收起特征")).toBeTruthy();
    fireEvent.click(utils.getByText("收起特征"));
    expect(utils.getByText("看特征明细")).toBeTruthy();
  });

  it("「指纹体检」+ 困惑度引导：模型未就绪出现下载按钮，点击后进入下载流程", async () => {
    pplStatusMock.mockResolvedValue({ supported: true, ready: true });
    ensurePplModelMock.mockResolvedValue(undefined);
    const utils = render(<App />);
    await humanizeFirst(utils);
    fireEvent.click(utils.getByText("指纹体检"));
    await waitFor(() => {
      expect(utils.getByText(/下载模型（约 100MB，仅一次，之后离线）/)).toBeTruthy();
    });
    // 下载完成后模型就绪：自动对目标文本跑特征 → done（第 13 维并入朱雀面板的链路）
    isPplReadyMock.mockReturnValue(true);
    computePplFeatureMock.mockResolvedValue({
      meanNll: 3.2,
      winStd: 0.6,
      scoredChars: 500,
      windows: [{ charStart: 0, charEnd: 500, scoredCount: 480, meanNll: 3.2 }],
    });
    fireEvent.click(utils.getByText(/下载模型（约 100MB，仅一次，之后离线）/));
    await waitFor(() => {
      expect(utils.queryByText(/下载模型（约 100MB，仅一次，之后离线）/)).toBeNull();
    });
    expect(ensurePplModelMock).toHaveBeenCalledTimes(1);
  });

  it("「设置」保存：走真实 store 落盘并给出提示", async () => {
    const utils = render(<App />);
    fireEvent.click(utils.getByText("⚙ 设置"));
    fireEvent.click(utils.getByText("保存"));
    await waitFor(() => {
      expect(utils.getByText(/设置已保存（仅存本地）/)).toBeTruthy();
    });
    expect(utils.container.querySelector('[aria-label="API 设置"]')).toBeNull();
  });

  it("docx 导出失败：报真实原因且不崩", async () => {
    writeDocxTextMock.mockRejectedValueOnce(new Error("磁盘空间不足"));
    const utils = render(<App />);
    const { getByText } = await humanizeFirst(utils);
    fireEvent.click(getByText("导出 .docx"));
    await waitFor(() => {
      expect(getByText(/docx 导出失败：磁盘空间不足/)).toBeTruthy();
    });
  });

  it("降幅徽章：去味后分数反升时如实显示 + 号（不粉饰）", async () => {
    const mildInput = "我今天出门买菜，路上碰见老王，聊了几句家常，挺开心的。";
    runHumanizeMock.mockResolvedValue({
      ...makeRunResult(INPUT_TEXT, "local"),
      before: aiScore(mildInput),
    });
    const { getByText, getByPlaceholderText, container } = await renderApp();
    fireEvent.change(getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: mildInput },
    });
    fireEvent.click(getByText("去味"));
    await waitFor(() => {
      expect(container.querySelector(".delta-value")).toBeTruthy();
    });
    expect(container.querySelector(".delta-value")!.textContent).toContain("+");
  });

  it("「对比」：DiffView 打开并可关闭", async () => {
    const utils = render(<App />);
    const { getByText } = await humanizeFirst(utils);
    fireEvent.click(getByText("对比"));
    expect(utils.container.querySelector(".modal-tip") || utils.getByText("关闭")).toBeTruthy();
    fireEvent.click(utils.getByText("关闭"));
    expect(utils.queryByText("关闭")).toBeNull();
  });

  it("「导入」按钮：触发隐藏文件选择器不崩", async () => {
    const { getByText } = await renderApp();
    fireEvent.click(getByText("导入"));
    expect(getByText("导入")).toBeTruthy();
  });

  it("「朱雀检测」：面板出现并可打开校准实验室完成复制动作", async () => {
    const utils = render(<App />);
    await humanizeFirst(utils);
    fireEvent.click(utils.getByText("朱雀检测"));
    fireEvent.click(utils.getByText(/校准实验室（攒真值）/));
    fireEvent.click(utils.getByText(/预置真值锚点/));
    // 页面存在两个「复制」按钮（主工具条 + 实验室样本行），逐个点击直到实验室给出回执
    for (const btn of utils.getAllByText("复制")) fireEvent.click(btn);
    await waitFor(() => {
      expect(utils.getByText(/已复制|复制失败/)).toBeTruthy();
    });
  });

  it("历史条目点击载入：输入输出回填；「清空历史」后为空", async () => {
    const utils = await renderApp();
    const { getByText, getByPlaceholderText } = await humanizeFirst(utils);
    fireEvent.click(getByText("历史"));
    // 注意：getAllByText 第一个匹配是输入面板 TEXTAREA（value 相同），历史条目是 DIV
    const entry = utils
      .getAllByText(new RegExp(INPUT_TEXT.slice(0, 20)))
      .find((el) => el.tagName === "DIV");
    expect(entry).toBeTruthy();
    fireEvent.click(entry!);
    await waitFor(() => {
      expect((getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement).value).toBe(
        INPUT_TEXT,
      );
      expect(utils.getByText(/已载入历史记录/)).toBeTruthy();
    });
    // 点条目时 HistoryPanel 的 onClick 已同步 onClose——重新打开再清空
    fireEvent.click(utils.getByText("历史"));
    fireEvent.click(utils.getByText("清空历史"));
    expect(loadHistory().length).toBe(0);
  });

  it("草稿恢复：刷新后提示恢复时长；再清空后草稿被丢弃", async () => {
    saveDraft("上次没写完的稿子内容", "");
    const utils = render(<App />);
    await waitFor(() => {
      expect(utils.getByText(/已恢复.*未完成的稿（10 字）/)).toBeTruthy();
    });
    expect((utils.getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement).value).toBe(
      "上次没写完的稿子内容",
    );
    // 输入后清空：500ms 防抖落盘走 clearDraft 分支
    fireEvent.change(utils.getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: "临时的字" },
    });
    fireEvent.change(utils.getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: "" },
    });
    await waitFor(
      () => {
        expect(loadDraft()?.input ?? "").toBe("");
      },
      { timeout: 1500 },
    );
    expect(loadDraft()?.output ?? "").toBe("");
  });
});

/* -------------------------------------------------------------------------
 * 行覆盖补锁（第六轮）：针对 App.tsx 此前 100% 未触达的守卫/回调行——
 * 草稿 saveDraft 分支 / 输出面板 onChange / 导入空选择 / 朱雀增强开关 /
 * 评判与送检守卫 / 加密桥保存分支 / 面板与弹窗回调。
 * 网络依旧全桩：fetch 不出站，语义层、检测器、LLM 均为 mock。
 * ---------------------------------------------------------------------- */
describe("App 守卫分支与面板回调（行覆盖补锁）", () => {
  const ENABLED_DETECTOR = {
    ...DEFAULT_DETECTOR,
    enabled: true,
    url: "http://detector.local/score",
  };
  const SEEDED_DETECTOR_JSON = JSON.stringify({
    enabled: true,
    url: "http://detector.local/score",
    apiKey: "sk-det",
    scorePath: "score",
    scale: "0-100",
  });

  async function humanizeFirst(utils: ReturnType<typeof render>) {
    runHumanizeMock.mockResolvedValue(makeRunResult(OUTPUT_TEXT, "local"));
    const { getByText, getByPlaceholderText } = utils;
    fireEvent.change(getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(getByText("去味"));
    await waitFor(() => {
      expect((getByPlaceholderText(/点击「去味」生成/) as HTMLTextAreaElement).value).toBe(
        OUTPUT_TEXT,
      );
    });
  }

  it("草稿防抖：有内容停手 500ms 后走 saveDraft 落盘（else 分支）", async () => {
    const { getByPlaceholderText } = await renderApp();
    fireEvent.change(getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: "这次真要落盘的草稿" },
    });
    await waitFor(
      () => {
        expect(loadDraft()?.input).toBe("这次真要落盘的草稿");
      },
      { timeout: 1500 },
    );
    expect(loadDraft()?.output ?? "").toBe("");
  });

  it("输出面板手工润色：键入经 handleOutputChange 落状态并解锁下游按钮", () => {
    const { getByPlaceholderText, getByText } = render(<App />);
    const outPane = getByPlaceholderText(/点击「去味」生成/) as HTMLTextAreaElement;
    expect((getByText("复制") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("对比") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(outPane, { target: { value: OUTPUT_TEXT } });
    expect(outPane.value).toBe(OUTPUT_TEXT);
    expect((getByText("复制") as HTMLButtonElement).disabled).toBe(false);
    expect((getByText("对比") as HTMLButtonElement).disabled).toBe(true); // 对比还要有原文
  });

  it("文件选择器未选中任何文件：立即返回，不读文件不改面板", () => {
    const { container, getByPlaceholderText, queryByText } = render(<App />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput);
    expect(readDocxTextMock).not.toHaveBeenCalled();
    expect(queryByText(/已导入/)).toBeNull();
    expect(queryByText(/docx 解析失败/)).toBeNull();
    expect((getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement).value).toBe("");
  });

  it("「朱雀增强」开关：勾选写入 store 并点亮 active 标签", () => {
    const { container, getByText } = render(<App />);
    const label = getByText("🛡 朱雀增强").closest("label")!;
    const checkbox = label.querySelector("input") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(container.querySelector(".mode-tag.active")).toBeNull();
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(container.querySelector(".mode-tag.active")).toBeTruthy();
    expect(loadZhuqueMode()).toBe(true);
  });

  it("「用 LLM 评判」守卫：Key 全是空白时按钮可点但直接返回、不发请求", async () => {
    const utils = render(<App initialApi={{ ...DEFAULT_API, enabled: true, apiKey: "   " }} />);
    await humanizeFirst(utils);
    const btn = utils.getByText("用 LLM 评判") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(judgeScoreStableMock).not.toHaveBeenCalled();
    expect(utils.queryByText(/评判中…/)).toBeNull();
    expect(utils.queryByText(/LLM 评判失败/)).toBeNull();
  });

  it("「用外部检测器」手动送检失败：报真实原因（区别于自动送检文案）", async () => {
    scoreViaDetectorMock.mockRejectedValue(new Error("502 Bad Gateway"));
    const utils = render(<App initialDetector={ENABLED_DETECTOR} />);
    await humanizeFirst(utils);
    // 先等去味内自动送检的失败文案落地，排除异步竞态
    await waitFor(() => {
      expect(utils.getByText(/检测器送检失败：502/)).toBeTruthy();
    });
    fireEvent.click(utils.getByText("用外部检测器"));
    await waitFor(() => {
      expect(utils.getByText(/检测器调用失败：502 Bad Gateway/)).toBeTruthy();
    });
    expect(scoreViaDetectorMock).toHaveBeenCalledTimes(2);
  });

  it("设置保存（挂加密桥·写入成功）：检测器 Key 进 secureStore 后抹掉明文", async () => {
    localStorage.setItem("aihumanizer.detector", SEEDED_DETECTOR_JSON);
    const setMock = vi.fn(async (_k: string, _v: string | null) => true);
    (window as unknown as { secureStore: unknown }).secureStore = {
      get: async () => null,
      set: setMock,
    };
    const utils = render(<App />);
    expect(loadDetector().apiKey).toBe("sk-det"); // 前置：明文确实存在
    fireEvent.click(utils.getByText("⚙ 设置"));
    fireEvent.click(utils.getByText("保存"));
    await waitFor(() => {
      expect(utils.getByText(/设置已保存（仅存本地）/)).toBeTruthy();
    });
    expect(setMock).toHaveBeenCalledWith("detectorApiKey", "sk-det");
    expect(loadDetector().apiKey).toBe(""); // okDet=true → saveDetector 剥掉明文
  });

  it("设置保存（挂加密桥·写入失败）：明文原样保留，绝不能抹 Key", async () => {
    localStorage.setItem("aihumanizer.detector", SEEDED_DETECTOR_JSON);
    const setMock = vi.fn(async (_k: string, _v: string | null) => false);
    (window as unknown as { secureStore: unknown }).secureStore = {
      get: async () => null,
      set: setMock,
    };
    const utils = render(<App />);
    fireEvent.click(utils.getByText("⚙ 设置"));
    fireEvent.click(utils.getByText("保存"));
    await waitFor(() => {
      expect(utils.getByText(/设置已保存（仅存本地）/)).toBeTruthy();
    });
    expect(setMock).toHaveBeenCalledWith("detectorApiKey", "sk-det");
    expect(loadDetector().apiKey).toBe("sk-det"); // okDet=false → 原样落盘
  });

  it("朱雀面板「看 12 维特征」：onToggleFeatures 开合生效", async () => {
    const utils = render(<App />);
    await humanizeFirst(utils);
    fireEvent.click(utils.getByText("朱雀检测"));
    expect(utils.getByText("看 12 维特征")).toBeTruthy();
    fireEvent.click(utils.getByText("看 12 维特征"));
    expect(utils.getByText("收起特征")).toBeTruthy();
    expect(utils.getByText(/条越长越像 AI/)).toBeTruthy();
    fireEvent.click(utils.getByText("收起特征"));
    expect(utils.getByText("看 12 维特征")).toBeTruthy();
  });

  it("朱雀面板「用 LLM 补语义层」：onRunSemantic 回调触发，失败文案如实回显", async () => {
    semanticAvailableMock.mockReturnValue(true);
    detectSemanticStableMock.mockRejectedValue(new Error("语义超时"));
    const utils = render(<App />);
    await humanizeFirst(utils);
    fireEvent.click(utils.getByText("朱雀检测"));
    const btn = utils.getByText("用 LLM 补语义层") as HTMLButtonElement;
    expect(btn.disabled).toBe(false); // canRunSemantic 才放行
    fireEvent.click(btn);
    await waitFor(() => {
      expect(utils.getByText(/语义层评判失败：语义超时/)).toBeTruthy();
    });
    expect(detectSemanticStableMock).toHaveBeenCalledTimes(1);
  });

  it("校准实验室：粘贴真值回填受控输入（onPaste）；「完成」关闭弹窗（onClose）", async () => {
    const utils = render(<App />);
    await humanizeFirst(utils);
    fireEvent.click(utils.getByText("朱雀检测"));
    fireEvent.click(utils.getByText(/校准实验室（攒真值）/));
    fireEvent.change(utils.getByPlaceholderText(/贴一篇 AI 写的原文/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(utils.getByText("生成本批样本（4 条）"));
    // 注意：主朱雀面板也有同 placeholder 的回填框，查询必须圈在弹窗内
    const modal = utils.container.querySelector(".modal") as HTMLElement;
    expect(modal).toBeTruthy();
    const pasteInputs = within(modal).getAllByPlaceholderText(/粘贴官方结果/) as HTMLInputElement[];
    expect(pasteInputs.length).toBe(4);
    fireEvent.change(pasteInputs[0], { target: { value: "AI生成 99.99%" } });
    // 受控输入：值留在输入框 = onPaste 确实把状态更新了（否则 React 会弹回空串）
    expect(pasteInputs[0].value).toBe("AI生成 99.99%");
    fireEvent.click(within(modal).getByText("完成"));
    expect(utils.container.querySelector(".modal")).toBeNull();
    expect(utils.queryByText(/校准实验室 · 攒真值/)).toBeNull();
  });
});

/**
 * 引擎返回值的边界形状（目标行 221 / 229）
 *
 * 之前所有用例都走 makeRunResult(...) 这个**规整的**工厂：
 * 它恒带 roundScores（默认 []），且从不带 bestOf。
 * 于是 App 里两处兜底写法一次都没被走过：
 *   · 行 221 `local.bestOf ? {...} : undefined` —— 短路取 undefined 那半边
 *   · 行 229 `r.roundScores || []`             —— undefined 兜底那半边
 */
describe("引擎返回值的边界形状（目标行 221 / 229）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("roundScores 为 undefined 时兜底成空数组，界面不崩", async () => {
    // makeRunResult 恒带 roundScores，这里手搓一个**不带该字段**的结果
    runHumanizeMock.mockResolvedValue({
      text: OUTPUT_TEXT,
      before: aiScore(INPUT_TEXT),
      after: aiScore(OUTPUT_TEXT),
      usedApi: false,
      engine: "local",
      degrade: [],
      note: "",
      // roundScores 故意缺失（不是 null —— null 与 undefined 是两条不同的分支）
    });
    const utils = render(<App />);
    fireEvent.change(utils.getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(utils.getByText("去味"));
    // 关键：没崩，且输出照常落位
    await waitFor(() => {
      expect((utils.getByPlaceholderText(/点击「去味」生成/) as HTMLTextAreaElement).value).toBe(
        OUTPUT_TEXT,
      );
    });
    // 轮次序列不该显示任何分数
    expect(utils.queryByText(/第 \d+ 轮/)).toBeNull();
  });

  it("roundScores 为 null 时同样兜底（null 与 undefined 是不同分支）", async () => {
    runHumanizeMock.mockResolvedValue({
      text: OUTPUT_TEXT,
      before: aiScore(INPUT_TEXT),
      after: aiScore(OUTPUT_TEXT),
      usedApi: false,
      engine: "local",
      degrade: [],
      note: "",
      roundScores: null as unknown as number[],
    });
    const utils = render(<App />);
    fireEvent.change(utils.getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(utils.getByText("去味"));
    await waitFor(() => {
      expect((utils.getByPlaceholderText(/点击「去味」生成/) as HTMLTextAreaElement).value).toBe(
        OUTPUT_TEXT,
      );
    });
  });

  it("引擎开启 bestOf 时把候选数透传给 runHumanize", async () => {
    // 行 221：`local.bestOf ? { bestOf: true, candidates: local.candidates } : undefined`
    //
    // ⚠️ 第一版把 key 写成 `quaiwei.cfg.local`，探针（失败信息 expected 8 to be 4）
    // 指出读到的是默认值：store.ts 的 key 其实是 `aihumanizer.local`，
    // 而 DEFAULT_LOCAL = { bestOf: true, candidates: 8 }——所以默认值就会透传 8。
    // 这里显式写一份非默认的 4，才能证明「配置值确实被透传」而不是碰巧撞上默认。
    runHumanizeMock.mockResolvedValue(makeRunResult(OUTPUT_TEXT, "local"));
    localStorage.setItem("aihumanizer.local", JSON.stringify({ bestOf: true, candidates: 4 }));
    const utils = render(<App />);
    fireEvent.change(utils.getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(utils.getByText("去味"));
    await waitFor(() => {
      expect((utils.getByPlaceholderText(/点击「去味」生成/) as HTMLTextAreaElement).value).toBe(
        OUTPUT_TEXT,
      );
    });
    // 第 7 个入参应带上 bestOf 与**配置里的**候选数
    // ⚠️ 用 [len - 1] 而非 .at(-1)：项目 tsconfig target 不含 ES2022，
    // Array.prototype.at 在类型上不存在（tsc 报 TS2550）。
    const calls = runHumanizeMock.mock.calls;
    const opts = calls[calls.length - 1][6] as
      { bestOf?: boolean; candidates?: number } | undefined;
    expect(opts?.bestOf).toBe(true);
    expect(opts?.candidates).toBe(4); // 非默认的 8 —— 证明读到的是配置而非默认值
  });

  it("关闭 bestOf 时第 7 个入参为 undefined（短路那半边）", async () => {
    // 覆盖行 221 的 `: undefined` 分支：optArgs 整个不传
    runHumanizeMock.mockResolvedValue(makeRunResult(OUTPUT_TEXT, "local"));
    localStorage.setItem("aihumanizer.local", JSON.stringify({ bestOf: false, candidates: 8 }));
    const utils = render(<App />);
    fireEvent.change(utils.getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(utils.getByText("去味"));
    await waitFor(() => {
      expect((utils.getByPlaceholderText(/点击「去味」生成/) as HTMLTextAreaElement).value).toBe(
        OUTPUT_TEXT,
      );
    });
    const calls = runHumanizeMock.mock.calls;
    expect(calls[calls.length - 1][6]).toBeUndefined();
  });
});

/**
 * 「指纹体检」的空输入守卫（App.tsx 行 191-192）
 *
 * handleFingerprint 的第一句是
 *   const target = output.trim() ? output : input;
 *   if (!target.trim()) return;
 * 之前唯一的「指纹体检」用例（行 522）都先跑了 humanizeFirst，
 * output 非空 —— 于是「两个都是空」的早退分支一次都没被走过。
 *
 * 断言要点：点了**不崩、也不发起困惑度推理**。后者用 mock 调用次数钉住，
 * 因为早退若失效，先崩的可能是异步的推理链，而不是这个 handler 本身。
 */
describe("指纹体检的空输入守卫（行 191-192）", () => {
  beforeEach(() => {
    localStorage.clear();
    computePplFeatureMock.mockReset();
    ensurePplModelMock.mockReset();
  });

  it("原文与输出都为空：点「指纹体检」不崩，且不发起任何困惑度推理", async () => {
    pplStatusMock.mockResolvedValue({ supported: true, ready: true });
    const utils = render(<App />);
    // 不填输入、不去味 → input 与 output 都是空串
    expect((utils.getByPlaceholderText(/把 AI 写的文章粘进来/) as HTMLTextAreaElement).value).toBe(
      "",
    );
    fireEvent.click(utils.getByText("指纹体检"));
    // 让事件循环跑一轮，若早退失效这里就会看到 reject/异常
    await new Promise((r) => setTimeout(r, 20));
    expect(computePplFeatureMock).not.toHaveBeenCalled();
    expect(ensurePplModelMock).not.toHaveBeenCalled();
    // 界面还在，且没冒出任何报错文案
    expect(utils.getByText("指纹体检")).toBeTruthy();
    expect(utils.queryByText(/出错|失败/)).toBeNull();
  });

  it("只有原文（无输出）时走 input 侧：早退不生效，正常发起推理", async () => {
    pplStatusMock.mockResolvedValue({ supported: true, ready: true });
    isPplReadyMock.mockReturnValue(true);
    computePplFeatureMock.mockResolvedValue({ ppl: 12.3 });
    const utils = render(<App />);
    fireEvent.change(utils.getByPlaceholderText(/把 AI 写的文章粘进来/), {
      target: { value: INPUT_TEXT },
    });
    fireEvent.click(utils.getByText("指纹体检"));
    await waitFor(() => {
      expect(computePplFeatureMock).toHaveBeenCalled();
    });
    // 送进推理的是 input（去味稿还没有）
    const target = (computePplFeatureMock.mock.calls[0]?.[0] ?? "") as string;
    expect(target).toBe(INPUT_TEXT);
  });
});

/**
 * LLM 模式标签的两副面孔（App.tsx 行 509-518）。
 *
 * 标签只在 `api.enabled && effectiveKeys(api).length > 0` 时渲染，
 * 内容由 `api.deepMode` 二选一。此前所有用例都没配过 API，
 * 于是这个 span 从来没出现过——三处缺口（513 的 true 支、515 的 false 支、518）。
 *
 * ⚠️ 选择器必须限定 span：App.tsx 行 522 还有另一个 `className="mode-tag"`
 *   （朱雀模式的 **label**，带 active 类）。第一版用 `querySelector(".mode-tag")`
 *   的第三条用例就是这么错的——拿到的是行 522 那个 label，不是行 510 的 span。
 */
describe("LLM 模式标签（行 509-518）", () => {
  const KEY = "aihumanizer.api";
  const LLM_TAG = "span.mode-tag"; // 行 510 是 span；行 522 是 label，两者 className 相同

  function renderWith(cfg: Record<string, unknown>) {
    localStorage.clear();
    localStorage.setItem(
      KEY,
      JSON.stringify({ baseUrl: "https://api.example.com", apiKey: "k1", ...cfg }),
    );
    return render(<App />);
  }

  it("deepMode 开 → 「⚡ 深度模式」，title 说明会多轮改写", () => {
    const utils = renderWith({ enabled: true, deepMode: true });
    const tag = utils.container.querySelector(LLM_TAG) as HTMLElement;
    expect(tag).toBeTruthy();
    expect(tag.textContent).toBe("⚡ 深度模式");
    // title 说的是「最多 N 轮」，N 取自常量，这里只断言形状不写死数字
    expect(tag.title).toMatch(/改写 → LLM评分 → 未达标自动再改写，最多 \d+ 轮/);
  });

  it("deepMode 关 → 「LLM 单轮」，title 指向设置里开启", () => {
    const utils = renderWith({ enabled: true, deepMode: false });
    const tag = utils.container.querySelector(LLM_TAG) as HTMLElement;
    expect(tag).toBeTruthy();
    expect(tag.textContent).toBe("LLM 单轮");
    expect(tag.title).toBe("单次 LLM 改写（设置里可开深度模式）");
  });

  it("enabled 但 Key 为空 → 这个 span 不渲染（effectiveKeys 返回空数组）", () => {
    // 探针实测：effectiveKeys({apiKey:"", apiKeys:""}) === []（splitKeys 会滤掉空串）
    const utils = renderWith({ enabled: true, deepMode: true, apiKey: "", apiKeys: "" });
    expect(utils.container.querySelector(LLM_TAG)).toBeNull();
    // 对照：行 522 那个 label 仍在——证明是「这个 span 不渲染」而非整页崩了
    expect(utils.container.querySelector(".mode-tag")).toBeTruthy();
  });
});
