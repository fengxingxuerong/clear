/**
 * 困惑度（第 8 项）状态机 hook（自 App.tsx 抽出，行为逐字保留）。
 *
 * 状态机：idle → need-download（模型未就绪）→ downloading → idle（下载完成）
 * → loading → done；不支持的环境直接 unsupported；任何异常静默降级为 error
 * （只丢困惑度层，其余 7 项指纹照常）。与朱雀面板的交叉通过注入回调解耦：
 * 特征就绪后若面板已打开，由 applyPplToZhuque 带上第 13 维重算综合分。
 */
import { useCallback, useState } from "react";
import { pplIssues as derivePplIssues } from "../engine/humanize";
import {
  computePplFeature,
  ensurePplModel,
  pplStatus,
  isPplReady,
  type PplProgressInfo,
} from "../ppl/ppl-client";
import type { PplFeature } from "../ppl/scorer-core";
import type { PplIssueLite } from "../components/FingerprintPanel";
import { loadPplEnabled } from "../store";

export type PplUiState =
  | "idle"
  | "need-download"
  | "downloading"
  | "loading"
  | "done"
  | "error"
  | "unsupported";

export interface UsePplFlowOptions {
  /** 特征就绪后让朱雀检测面板带上第 13 维重算综合分（面板未打开时 no-op） */
  applyPplToZhuque?: (feature: PplFeature) => void;
  /** 模型下载完成后自动对当前目标文本跑特征（原文优先于去味稿） */
  getAnalysisTarget?: () => string;
}

export interface UsePplFlowResult {
  pplEnabled: boolean;
  setPplEnabled: (v: boolean) => void;
  pplState: PplUiState;
  pplFeature: PplFeature | null;
  pplIssues: PplIssueLite[] | null;
  pplProgress: number | null;
  pplNote: string | null;
  setPplNote: (v: string | null) => void;
  setPplFeature: (v: PplFeature | null) => void;
  setPplIssues: (v: PplIssueLite[] | null) => void;
  runPplFeature: (target: string) => Promise<void>;
  ensurePpl: () => Promise<void>;
}

export function usePplFlow(opts: UsePplFlowOptions = {}): UsePplFlowResult {
  const [pplEnabled, setPplEnabled] = useState<boolean>(loadPplEnabled());
  const [pplState, setPplState] = useState<PplUiState>("idle");
  const [pplFeature, setPplFeature] = useState<PplFeature | null>(null);
  const [pplIssues, setPplIssues] = useState<PplIssueLite[] | null>(null);
  const [pplProgress, setPplProgress] = useState<number | null>(null);
  const [pplNote, setPplNote] = useState<string | null>(null);

  // 第 8 项（困惑度）：模型就绪才推理；未下载转引导态；失败静默降级为仅 7 项
  const runPplFeature = useCallback(
    async (target: string): Promise<void> => {
      if (!loadPplEnabled()) return;
      try {
        const st = await pplStatus();
        if (!st.supported) {
          setPplState("unsupported");
          return;
        }
        if (!isPplReady()) {
          setPplState("need-download");
          return;
        }
        setPplState("loading");
        const feature = await computePplFeature(target);
        setPplFeature(feature);
        setPplIssues(derivePplIssues(feature));
        setPplState("done");
        // 困惑度层就绪：朱雀检测面板若已打开，自动带上第 13 维重算综合分
        opts.applyPplToZhuque?.(feature);
      } catch {
        setPplFeature(null);
        setPplIssues(null);
        setPplState("error");
      }
    },
    [opts.applyPplToZhuque],
  );

  const ensurePpl = useCallback(async (): Promise<void> => {
    if (pplState === "downloading") return;
    setPplState("downloading");
    setPplProgress(0);
    try {
      await ensurePplModel((p: PplProgressInfo) => {
        if (typeof p.progress === "number") setPplProgress(p.progress);
      });
      setPplState("idle");
      const target = opts.getAnalysisTarget?.() ?? "";
      if (target.trim()) void runPplFeature(target);
    } catch (e: unknown) {
      setPplState("error");
      setPplNote("模型下载失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }, [pplState, runPplFeature, opts.getAnalysisTarget]);

  return {
    pplEnabled,
    setPplEnabled,
    pplState,
    pplFeature,
    pplIssues,
    pplProgress,
    pplNote,
    setPplNote,
    setPplFeature,
    setPplIssues,
    runPplFeature,
    ensurePpl,
  };
}
