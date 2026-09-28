// @vitest-environment happy-dom
/**
 * usePplFlow（困惑度第 8 项状态机）行为锁（自 App.tsx 抽出时补）。
 * 状态机：idle→unsupported / need-download→downloading→idle→loading→done；
 * 失败静默降级 error；开关关闭直接短路；下载完成自动对目标文本跑特征。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePplFlow } from "./usePplFlow";
import { savePplEnabled } from "../store";

const { computePplFeatureMock, ensurePplModelMock, pplStatusMock, isPplReadyMock } = vi.hoisted(
  () => ({
    computePplFeatureMock: vi.fn(),
    ensurePplModelMock: vi.fn(),
    pplStatusMock: vi.fn(),
    isPplReadyMock: vi.fn(),
  }),
);

// 混合 mock：ppl-client 其余真实导出保留，只替换触网/依赖宿主推理的四个面
vi.mock("../ppl/ppl-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ppl/ppl-client")>()),
  computePplFeature: computePplFeatureMock,
  ensurePplModel: ensurePplModelMock,
  pplStatus: pplStatusMock,
  isPplReady: isPplReadyMock,
}));

const FEATURE = {
  meanNll: 3.2,
  winStd: 0.6,
  scoredChars: 500,
  windows: [{ charStart: 0, charEnd: 500, scoredCount: 480, meanNll: 3.2 }],
};

function ready() {
  pplStatusMock.mockResolvedValue({ supported: true, ready: true });
  isPplReadyMock.mockReturnValue(true);
}

beforeEach(() => {
  localStorage.clear();
  computePplFeatureMock.mockReset();
  ensurePplModelMock.mockReset();
  pplStatusMock.mockReset();
  isPplReadyMock.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe("usePplFlow：runPplFeature 状态机", () => {
  it("开关关闭：直接短路，不碰 pplStatus", async () => {
    savePplEnabled(false);
    const { result } = renderHook(() => usePplFlow());
    await act(async () => {
      await result.current.runPplFeature("文本");
    });
    expect(pplStatusMock).not.toHaveBeenCalled();
    expect(result.current.pplState).toBe("idle");
  });

  it("环境不支持 → unsupported", async () => {
    pplStatusMock.mockResolvedValue({ supported: false, ready: false });
    const { result } = renderHook(() => usePplFlow());
    await act(async () => {
      await result.current.runPplFeature("文本");
    });
    expect(result.current.pplState).toBe("unsupported");
  });

  it("模型未就绪 → need-download（引导态）", async () => {
    pplStatusMock.mockResolvedValue({ supported: true, ready: true });
    isPplReadyMock.mockReturnValue(false);
    const { result } = renderHook(() => usePplFlow());
    await act(async () => {
      await result.current.runPplFeature("文本");
    });
    expect(result.current.pplState).toBe("need-download");
  });

  it("成功 → done，feature/issues 落位，朱雀重算回调被触发", async () => {
    ready();
    computePplFeatureMock.mockResolvedValue(FEATURE);
    const applyPpl = vi.fn();
    const { result } = renderHook(() => usePplFlow({ applyPplToZhuque: applyPpl }));
    await act(async () => {
      await result.current.runPplFeature("文本");
    });
    expect(result.current.pplState).toBe("done");
    expect(result.current.pplFeature?.meanNll).toBe(3.2);
    expect(Array.isArray(result.current.pplIssues)).toBe(true);
    expect(applyPpl).toHaveBeenCalledTimes(1);
    expect(applyPpl).toHaveBeenCalledWith(FEATURE);
  });

  it("推理抛错 → error 且 feature/issues 清空（静默降级为仅 7 项）", async () => {
    ready();
    computePplFeatureMock.mockRejectedValue(new Error("worker 崩了"));
    const { result } = renderHook(() => usePplFlow());
    await act(async () => {
      await result.current.runPplFeature("文本");
    });
    expect(result.current.pplState).toBe("error");
    expect(result.current.pplFeature).toBeNull();
    expect(result.current.pplIssues).toBeNull();
  });
});

describe("usePplFlow：ensurePpl 下载链", () => {
  it("下载成功 → idle，并对目标文本自动跑特征", async () => {
    ensurePplModelMock.mockImplementation(async (cb: (p: { progress?: number }) => void) => {
      cb({ progress: 0.5 });
      return;
    });
    computePplFeatureMock.mockResolvedValue(FEATURE);
    ready();
    const { result } = renderHook(() =>
      usePplFlow({ getAnalysisTarget: () => "目标文本" }),
    );
    await act(async () => {
      await result.current.ensurePpl();
    });
    await waitFor(() => {
      expect(result.current.pplState).toBe("done");
    });
    expect(result.current.pplProgress).toBe(0.5);
    expect(computePplFeatureMock).toHaveBeenCalledWith("目标文本");
  });

  it("目标文本为空白：下载完成但不跑特征", async () => {
    ensurePplModelMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => usePplFlow({ getAnalysisTarget: () => "   " }));
    await act(async () => {
      await result.current.ensurePpl();
    });
    expect(result.current.pplState).toBe("idle");
    expect(computePplFeatureMock).not.toHaveBeenCalled();
  });

  it("下载失败 → error + 注明「模型下载失败」", async () => {
    ensurePplModelMock.mockRejectedValue(new Error("网络超时"));
    const { result } = renderHook(() => usePplFlow());
    await act(async () => {
      await result.current.ensurePpl();
    });
    expect(result.current.pplState).toBe("error");
    expect(result.current.pplNote).toContain("模型下载失败：网络超时");
  });

  it("downloading 期间重入被挡：ensurePplModel 只被调一次", async () => {
    let release!: () => void;
    ensurePplModelMock.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const { result } = renderHook(() => usePplFlow());
    let first!: Promise<void>;
    act(() => {
      first = result.current.ensurePpl();
    });
    await act(async () => {
      await result.current.ensurePpl();
    });
    expect(ensurePplModelMock).toHaveBeenCalledTimes(1);
    release();
    await act(async () => {
      await first;
    });
  });
});
