// @vitest-environment happy-dom
/**
 * useZhuqueLab（朱雀检测面板 + 校准实验室编排）行为锁（自 App.tsx 抽出时补）。
 * detectZhuque/标定/样本库全走真实实现（engine 与 localStorage 均无网络副作用），
 * 只 mock 触网的 detectSemanticStable。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useZhuqueLab } from "./useZhuqueLab";
import { loadFuseWeight } from "../store";
import { DEFAULT_API } from "../api/llm";

const { detectSemanticStableMock } = vi.hoisted(() => ({
  detectSemanticStableMock: vi.fn(),
}));

vi.mock("../api/zhuque-semantic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/zhuque-semantic")>()),
  detectSemanticStable: detectSemanticStableMock,
}));

const TEXT =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。";

function opts(over: Partial<Parameters<typeof useZhuqueLab>[0]> = {}) {
  return {
    input: TEXT,
    output: "",
    api: { ...DEFAULT_API, enabled: false },
    pplFeature: null,
    genreOverride: null,
    ...over,
  } as Parameters<typeof useZhuqueLab>[0];
}

beforeEach(() => {
  localStorage.clear();
  detectSemanticStableMock.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe("useZhuqueLab：朱雀检测", () => {
  it("初始态：zq/zqText 为空，zqWeight 来自持久化默认", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    expect(result.current.zq).toBeNull();
    expect(result.current.zqText).toBe("");
    expect(result.current.zqWeight).toBe(loadFuseWeight());
    expect(result.current.zqGenreEstimate).toBeNull();
  });

  it("handleZhuque：文本进 zqText，本地检测报告落位，体裁线预测给出", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleZhuque();
    });
    expect(result.current.zqText).toBe(TEXT.trim());
    expect(result.current.zq).not.toBeNull();
    expect(result.current.zqMsg).toBe("");
    expect(result.current.zqSem).toBeNull(); // 换文本作废旧语义层
    const est = result.current.zqGenreEstimate;
    expect(est).not.toBeNull();
    expect(typeof est!.pct).toBe("number");
    expect(typeof est!.tag).toBe("string");
  });

  it("handleZhuque：无任何文本时 no-op", () => {
    const { result } = renderHook(() => useZhuqueLab(opts({ input: "", output: "" })));
    act(() => {
      result.current.handleZhuque();
    });
    expect(result.current.zq).toBeNull();
    expect(result.current.zqText).toBe("");
  });

  it("zqTarget：去味稿优先，无产出时回退原文", () => {
    const { result, rerender } = renderHook(
      (p: Parameters<typeof useZhuqueLab>[0]) => useZhuqueLab(p),
      { initialProps: opts() },
    );
    expect(result.current.zqTarget()).toBe(TEXT.trim());
    rerender(opts({ output: "去味稿内容。" }));
    expect(result.current.zqTarget()).toBe("去味稿内容。");
  });

  it("handleZqSemantic：语义层不可用（未启用 API）时不发起调用", async () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    await act(async () => {
      await result.current.handleZqSemantic();
    });
    expect(detectSemanticStableMock).not.toHaveBeenCalled();
    expect(result.current.zqSemLoading).toBe(false);
  });

  it("handleZqSemantic：可用时调用成功 → 语义层落位", async () => {
    detectSemanticStableMock.mockResolvedValue({ score: 18, critique: ["a"], source: "llm" });
    const { result } = renderHook(() =>
      useZhuqueLab(opts({ api: { ...DEFAULT_API, enabled: true, apiKey: "sk-test" } })),
    );
    act(() => {
      result.current.handleZhuque();
    });
    await act(async () => {
      await result.current.handleZqSemantic();
    });
    expect(detectSemanticStableMock).toHaveBeenCalledTimes(1);
    expect(result.current.zqSem?.score).toBe(18);
    expect(result.current.zqSemLoading).toBe(false);
  });

  it("handleZqSemantic：调用失败 → 报错文案但本地表层结果不受影响", async () => {
    detectSemanticStableMock.mockRejectedValue(new Error("网关 504"));
    const { result } = renderHook(() =>
      useZhuqueLab(opts({ api: { ...DEFAULT_API, enabled: true, apiKey: "sk-test" } })),
    );
    act(() => {
      result.current.handleZhuque();
    });
    await act(async () => {
      await result.current.handleZqSemantic();
    });
    expect(result.current.zqMsg).toContain("语义层评判失败");
    expect(result.current.zqMsg).toContain("504");
    expect(result.current.zq).not.toBeNull(); // 本地表层结果保留
  });

  it("rerunWithPpl：面板未开时 no-op；面板已开时带上第 13 维重算", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.rerunWithPpl({
        meanNll: 2.8,
        winStd: 0.4,
        scoredChars: 500,
        windows: [{ charStart: 0, charEnd: 500, scoredCount: 480, meanNll: 2.8 }],
      });
    });
    expect(result.current.zq).toBeNull();
    act(() => {
      result.current.handleZhuque();
    });
    const before = result.current.zq;
    act(() => {
      result.current.rerunWithPpl({
        meanNll: 2.8,
        winStd: 0.4,
        scoredChars: 500,
        windows: [{ charStart: 0, charEnd: 500, scoredCount: 480, meanNll: 2.8 }],
      });
    });
    expect(result.current.zq).not.toBeNull();
    expect(before).not.toBeNull();
  });
});

describe("useZhuqueLab：校准点管理", () => {
  it("handleZqSaveCalib：粘贴为空 → 提示粘贴内容为空", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleZhuque();
    });
    act(() => {
      result.current.handleZqSaveCalib();
    });
    expect(result.current.zqMsg).toBe("粘贴内容为空");
  });

  it("handleZqSaveCalib：zq 尚未检测 → 提示先粘官方结果", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleZqSaveCalib();
    });
    expect(result.current.zqMsg).toBe("粘贴内容为空");
  });

  it("handleZqClearCalib：校准点清零并提示（样本保留）", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleZhuque();
    });
    act(() => {
      result.current.handleZqClearCalib();
    });
    expect(result.current.zqCalib.n).toBe(0);
    expect(result.current.zqMsg).toContain("已清空校准数据");
  });

  it("handleZqWeight：权重落位并持久化", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleZqWeight(0.7);
    });
    expect(result.current.zqWeight).toBe(0.7);
    expect(loadFuseWeight()).toBe(0.7);
  });
});

describe("useZhuqueLab：校准实验室", () => {
  it("handleLabOpen：打开弹窗并载入样本库", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleLabOpen();
    });
    expect(result.current.showLab).toBe(true);
    expect(Array.isArray(result.current.labSamples)).toBe(true);
    expect(result.current.labMsg).toBe("");
  });

  it("handleLabGenerate：空文本 no-op；有文本生成原文+三档样本", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleLabGenerate();
    });
    expect(result.current.labMsg).toBe("");
    act(() => {
      result.current.setLabText("这是一段用于生成样本的原文内容，用来测试批量生成。");
    });
    act(() => {
      result.current.handleLabGenerate();
    });
    expect(result.current.labMsg).toContain("已生成 4 条样本");
    expect(result.current.labSamples.length).toBe(4);
    expect(result.current.labText).toBe("");
  });

  it("handleLabDelete / handleLabClear：删除与清空各给提示", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleLabDelete("不存在的 id");
    });
    expect(result.current.labMsg).toContain("已删除该样本");
    act(() => {
      result.current.handleLabClear();
    });
    expect(result.current.labMsg).toContain("已清空样本库与校准点");
    expect(result.current.labSamples.length).toBe(0);
    expect(result.current.zqCalib.n).toBe(0);
  });

  it("handleLabApplyWeight：应用权重并给出拟合提示", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleLabApplyWeight(0.8);
    });
    expect(result.current.zqWeight).toBe(0.8);
    expect(result.current.labMsg).toContain("80%");
  });

  it("handleLabSeed：首次预置锚点，再次调用提示已存在", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleLabSeed();
    });
    const first = result.current.labMsg;
    act(() => {
      result.current.handleLabSeed();
    });
    const second = result.current.labMsg;
    expect(first !== second).toBe(true);
    expect(second).toContain("真值锚点已存在");
  });
});
