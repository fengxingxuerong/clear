// @vitest-environment happy-dom
/**
 * useZhuqueLab（朱雀检测面板 + 校准实验室编排）行为锁（自 App.tsx 抽出时补）。
 * detectZhuque/标定/样本库全走真实实现（engine 与 localStorage 均无网络副作用），
 * 只 mock 触网的 detectSemanticStable；calib-lab 走混合 mock（默认透传真实实现，
 * 仅 labGenEmpty.value=true 时让 generateBatch 返回空批次，打不可达的防御分支）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useZhuqueLab } from "./useZhuqueLab";
import { loadFuseWeight } from "../store";
import { DEFAULT_API } from "../api/llm";
import { detectZhuque, ZHUQUE_URL } from "../engine/zhuque";
import { CALIB, trackForGenre } from "../engine/zhuque-calib";

const { detectSemanticStableMock, labGenEmpty } = vi.hoisted(() => ({
  detectSemanticStableMock: vi.fn(),
  labGenEmpty: { value: false },
}));

vi.mock("../api/zhuque-semantic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/zhuque-semantic")>()),
  detectSemanticStable: detectSemanticStableMock,
}));

// 混合 mock：其余导出（loadSamples/fillOfficial/seedTruthAnchors…）保持真实，
// 只把 generateBatch 包一层开关——「批次为空」在真实实现里不可达
//（labText.trim() 非空 ⇒ generateBatch 必出 4 条），只能靠桩打防御分支。
vi.mock("../api/calib-lab", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/calib-lab")>();
  return {
    ...real,
    generateBatch: (raw: string) => (labGenEmpty.value ? [] : real.generateBatch(raw)),
  };
});

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

// 宿主能力桩的描述符快照：模块加载时取（先于任何用例改写），
// 用例里用 defineProperty 打桩（只挂实例、不动原型），afterEach 统一还原。
const origOpenDesc = Object.getOwnPropertyDescriptor(window, "open");
const origClipDesc = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const origExecDesc = Object.getOwnPropertyDescriptor(document, "execCommand");

function stubProp(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, configurable: true, writable: true });
}

function restoreProp(obj: object, key: string, orig: PropertyDescriptor | undefined): void {
  if (orig) Object.defineProperty(obj, key, orig);
  else delete (obj as Record<string, unknown>)[key];
}

// 宿主桩与 mock 开关的还原：独立 afterEach，不动既有用例的清理逻辑
afterEach(() => {
  labGenEmpty.value = false;
  restoreProp(window, "open", origOpenDesc);
  restoreProp(navigator, "clipboard", origClipDesc);
  restoreProp(document, "execCommand", origExecDesc);
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

describe("useZhuqueLab：送检复制 / 官方页（补盲）", () => {
  it("setZqPaste：粘贴文本写入即回读", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.setZqPaste("AI生成 99.99%");
    });
    expect(result.current.zqPaste).toBe("AI生成 99.99%");
  });

  it("handleZqCopySubmit：无任何文本时早退，不碰剪贴板", async () => {
    const { result } = renderHook(() => useZhuqueLab(opts({ input: "", output: "" })));
    await act(async () => {
      await result.current.handleZqCopySubmit();
    });
    expect(result.current.zqMsg).toBe(""); // 早退分支：一行提示都不写
  });

  it("handleZqCopySubmit：复制成功 → 字数门检建议 + 已复制文案", async () => {
    stubProp(navigator, "clipboard", { writeText: vi.fn().mockResolvedValue(undefined) });
    const { result } = renderHook(() => useZhuqueLab(opts()));
    await act(async () => {
      await result.current.handleZqCopySubmit();
    });
    // TEXT 不足 350 字门槛 → submissionAdvice 给出劝退提示
    expect(result.current.zqMsg).toContain("低于官方 350 字门槛");
    expect(result.current.zqMsg).toContain("｜");
    expect(result.current.zqMsg).toContain("已复制，去官方页面粘贴即可");
  });

  it("handleZqCopySubmit：剪贴板与降级路径都失败 → 手动复制文案", async () => {
    stubProp(navigator, "clipboard", { writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    stubProp(document, "execCommand", () => false); // textarea + execCommand 降级也失败
    const { result } = renderHook(() => useZhuqueLab(opts()));
    await act(async () => {
      await result.current.handleZqCopySubmit();
    });
    expect(result.current.zqMsg).toContain("复制失败，请手动复制");
    expect(result.current.zqMsg).not.toContain("已复制，去官方页面粘贴即可");
  });

  it("handleZqOpenOfficial：弹窗放行不打扰；被拦截时给出手动打开提示", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    stubProp(window, "open", () => ({}));
    act(() => {
      result.current.handleZqOpenOfficial();
    });
    expect(result.current.zqMsg).toBe("");
    stubProp(window, "open", () => null); // 覆盖上一桩：拦截分支
    act(() => {
      result.current.handleZqOpenOfficial();
    });
    expect(result.current.zqMsg).toContain("浏览器拦截了弹窗");
    expect(result.current.zqMsg).toContain(ZHUQUE_URL);
  });
});

describe("useZhuqueLab：校准点管理（补盲）", () => {
  it("handleZqSaveCalib：已检测 + 可解析粘贴 → 记点、清粘贴、重算报告", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleZhuque();
    });
    act(() => {
      result.current.setZqPaste("AI生成 99.99%");
    });
    act(() => {
      result.current.handleZqSaveCalib();
    });
    expect(result.current.zqPaste).toBe(""); // 成功后清空粘贴框
    expect(result.current.zqCalib.n).toBeGreaterThanOrEqual(1);
    expect(result.current.zqMsg).toContain("已记录");
    expect(result.current.zqMsg).toContain("99.99");
    expect(result.current.zq).not.toBeNull(); // 记点后按新映射重算
  });

  it("handleZqSaveCalib：解析成功但还没检测（!zq）→ 用解析提示早退", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.setZqPaste("AI生成 99.99%");
    });
    act(() => {
      result.current.handleZqSaveCalib();
    });
    expect(result.current.zqCalib.n).toBe(0); // 不落点
    expect(result.current.zq).toBeNull();
    expect(result.current.zqMsg).toContain("已识别");
    expect(result.current.zqPaste).toBe("AI生成 99.99%"); // 失败不清粘贴，方便用户改完再存
  });

  it("handleZqSaveCalib：zqText 为空时重算走 zqTarget 兜底", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    // 不经 handleZhuque 直接挂报告：zqText 仍为空 → zqText || zqTarget() 走右支
    act(() => {
      result.current.setZq(detectZhuque(TEXT.trim()));
    });
    act(() => {
      result.current.setZqPaste("人工特征 5%");
    });
    act(() => {
      result.current.handleZqSaveCalib();
    });
    expect(result.current.zqCalib.n).toBeGreaterThanOrEqual(1);
    expect(result.current.zqMsg).toContain("已记录");
    expect(result.current.zq).not.toBeNull();
  });

  it("handleZqClearCalib：从没检测过（zqText 空）→ 只清提示，不动报告", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleZqClearCalib();
    });
    expect(result.current.zqCalib.n).toBe(0);
    expect(result.current.zq).toBeNull(); // 无文本 → 跳过重算分支
    expect(result.current.zqMsg).toContain("已清空校准数据");
  });
});

describe("useZhuqueLab：语义层调用细节（补盲）", () => {
  it("handleZqSemantic：bypassCache 显式 true 与缺省 false 都透传给下层", async () => {
    detectSemanticStableMock.mockResolvedValue({ score: 6, critique: [], source: "llm" });
    const { result } = renderHook(() =>
      useZhuqueLab(opts({ api: { ...DEFAULT_API, enabled: true, apiKey: "sk-test" } })),
    );
    act(() => {
      result.current.handleZhuque();
    });
    await act(async () => {
      await result.current.handleZqSemantic(true);
    });
    expect(detectSemanticStableMock).toHaveBeenCalledTimes(1);
    expect(detectSemanticStableMock.mock.calls[0][2]).toEqual({ bypassCache: true });
    await act(async () => {
      await result.current.handleZqSemantic();
    });
    expect(detectSemanticStableMock).toHaveBeenCalledTimes(2);
    expect(detectSemanticStableMock.mock.calls[1][2]).toEqual({ bypassCache: false });
  });

  it("handleZqSemantic：抛非 Error 值走 String(e) 分支", async () => {
    detectSemanticStableMock.mockRejectedValue("网关 504（字符串）");
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
    expect(result.current.zqMsg).toContain("网关 504（字符串）");
    expect(result.current.zqSem).toBeNull();
    expect(result.current.zqSemLoading).toBe(false);
  });

  it("handleZqSemantic：API 可用但无检测文本时早退不调用", async () => {
    const { result } = renderHook(() =>
      useZhuqueLab(opts({ input: "", output: "", api: { ...DEFAULT_API, enabled: true, apiKey: "sk-test" } })),
    );
    await act(async () => {
      await result.current.handleZqSemantic();
    });
    expect(detectSemanticStableMock).not.toHaveBeenCalled();
    expect(result.current.zqSemLoading).toBe(false);
  });

  it("handleZqSemantic：loading 置位 → 完成复位并落语义层结果", async () => {
    let resolveSem!: (v: unknown) => void;
    detectSemanticStableMock.mockReturnValue(
      new Promise((r) => {
        resolveSem = r;
      }),
    );
    const { result } = renderHook(() =>
      useZhuqueLab(opts({ api: { ...DEFAULT_API, enabled: true, apiKey: "sk-test" } })),
    );
    act(() => {
      result.current.handleZhuque();
    });
    act(() => {
      void result.current.handleZqSemantic();
    });
    expect(result.current.zqSemLoading).toBe(true); // 请求挂起期间 loading 在位
    expect(result.current.zqSem).toBeNull();
    await act(async () => {
      resolveSem({ score: 9, critique: ["x"], source: "llm" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.zqSemLoading).toBe(false); // finally 必复位
    expect(result.current.zqSem?.score).toBe(9);
  });
});

describe("useZhuqueLab：检测选项与体裁预测（补盲）", () => {
  it("zqOpts：pplFeature 为 null 不出 ppl 层；就绪时并入第 13 维", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    const noPpl = result.current.zqOpts(null);
    expect(noPpl.calibration).toBeNull();
    expect(noPpl.ppl).toBeNull();

    const { result: r2 } = renderHook(() =>
      useZhuqueLab(
        opts({
          pplFeature: {
            meanNll: 2.8,
            winStd: 0.4,
            scoredChars: 500,
            windows: [{ charStart: 0, charEnd: 500, scoredCount: 480, meanNll: 2.8 }],
          },
        }),
      ),
    );
    expect(r2.current.zqOpts(null).ppl).toEqual({
      meanNll: 2.8,
      winStd: 0.4,
      scoredChars: 500,
      windowCount: 1, // windows.length 当第 13 维的窗口数
    });
    // 校准映射原样透传
    const cal = { a: 1.5, b: 2, n: 3, points: [] };
    expect(r2.current.zqOpts(cal).calibration).toBe(cal);
    // pplFeature 就绪后 handleZhuque 照常出报告
    act(() => {
      r2.current.handleZhuque();
    });
    expect(r2.current.zq).not.toBeNull();
  });

  it("zqGenreEstimate：体裁覆盖生效，tag 与 CALIB/trackForGenre 同源", () => {
    const { result } = renderHook(() => useZhuqueLab(opts({ genreOverride: "dialogue" })));
    act(() => {
      result.current.handleZhuque();
    });
    const est = result.current.zqGenreEstimate;
    expect(est).not.toBeNull();
    expect(est!.tag).toBe(CALIB[trackForGenre("dialogue")].x40Tag);
    expect(typeof est!.pct).toBe("number");
  });

  it("zqGenreEstimate：有报告但检测文本为空 → 跳过预测", () => {
    const { result } = renderHook(() => useZhuqueLab(opts({ input: "", output: "" })));
    act(() => {
      result.current.setZq(detectZhuque("占位文本"));
    });
    expect(result.current.zq).not.toBeNull(); // 报告在，但没有可算的文本
    expect(result.current.zqGenreEstimate).toBeNull();
  });

  it("zqGenreEstimate：zqText 为空时取去味稿 output 兜底（而非空 input）", () => {
    const { result } = renderHook(
      () => useZhuqueLab(opts({ input: "", output: "去味稿内容，用来验证体裁预测的兜底取文分支。" })),
    );
    act(() => {
      result.current.setZq(detectZhuque("占位文本"));
    });
    // 取文三元：zqText 空 → output.trim() 非空必须走 output；若错走 input（空）预测会是 null
    expect(result.current.zq).not.toBeNull();
    expect(result.current.zqGenreEstimate).not.toBeNull();
    expect(typeof result.current.zqGenreEstimate!.pct).toBe("number");
  });
});

describe("useZhuqueLab：校准实验室回填链路（补盲）", () => {
  it("handleLabFill：样本不存在 → 提示失败，样本库/粘贴态/校准都不动", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleLabFill("no-such-id", "AI生成 99.99%");
    });
    expect(result.current.labMsg).toContain("样本不存在");
    expect(result.current.labSamples.length).toBe(0);
    expect(result.current.labPaste["no-such-id"]).toBeUndefined();
    expect(result.current.zqCalib.n).toBe(0);
  });

  it("handleLabFill：回填成功 → 样本库 / 粘贴态 / 校准映射 / zq 四处同步", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleZhuque(); // zqText 非空 → 命中回填后重算 zq 分支
    });
    act(() => {
      result.current.setLabText("这是一段用于生成校准样本的原文内容，用来批量回填。");
    });
    act(() => {
      result.current.handleLabGenerate();
    });
    expect(result.current.labSamples.length).toBe(4);
    const id = result.current.labSamples[0].id;
    act(() => {
      result.current.handleLabFill(id, "AI生成 99.99%");
    });
    expect(result.current.labMsg).toContain("已记录");
    expect(result.current.labSamples.find((s) => s.id === id)?.official).toBe(99.99);
    expect(result.current.labPaste[id]).toBe(""); // 该行粘贴框清空
    expect(result.current.zqCalib.n).toBeGreaterThanOrEqual(1); // 样本派生点进了映射
    expect(result.current.zq).not.toBeNull();
  });

  it("handleLabFill：回填成功但主面板没检测过 → 校准同步、zq 保持空", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.setLabText("这是一段用于生成校准样本的原文内容，用来批量回填。");
    });
    act(() => {
      result.current.handleLabGenerate();
    });
    const id = result.current.labSamples[0].id;
    act(() => {
      result.current.handleLabFill(id, "疑似AI辅助 62.3%");
    });
    expect(result.current.labMsg).toContain("已记录");
    expect(result.current.zqCalib.n).toBeGreaterThanOrEqual(1); // 映射照样同步
    expect(result.current.zq).toBeNull(); // zqText 空 → 跳过重算分支
  });

  it("handleLabGenerate：生成器返回空批次 → 原文与提示都不动", () => {
    labGenEmpty.value = true; // 桩出真实实现里不可达的空批次
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.setLabText("有内容的原文，用来验证空批次防御分支。");
    });
    act(() => {
      result.current.handleLabGenerate();
    });
    expect(result.current.labMsg).toBe("");
    expect(result.current.labText).toBe("有内容的原文，用来验证空批次防御分支。"); // 未被清空
    expect(result.current.labSamples.length).toBe(0);
  });

  it("handleLabClear：已有检测文本时同步按无校准重算 zq", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleZhuque();
    });
    expect(result.current.zq).not.toBeNull();
    act(() => {
      result.current.handleLabClear();
    });
    expect(result.current.zqCalib.n).toBe(0);
    expect(result.current.zq).not.toBeNull(); // 重算后报告仍在（校准已清）
    expect(result.current.labMsg).toContain("已清空样本库与校准点");
  });

  it("handleLabSeed：已有检测文本时同步重算 zq，两条锚点进校准", () => {
    const { result } = renderHook(() => useZhuqueLab(opts()));
    act(() => {
      result.current.handleZhuque();
    });
    act(() => {
      result.current.handleLabSeed();
    });
    expect(result.current.labMsg).toContain("已预置 2 条");
    expect(result.current.labSamples.length).toBe(2);
    expect(result.current.zqCalib.n).toBeGreaterThanOrEqual(2);
    expect(result.current.zq).not.toBeNull();
  });
});
