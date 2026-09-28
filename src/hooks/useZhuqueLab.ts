/**
 * 朱雀检测面板 + 校准实验室编排 hook（自 App.tsx 抽出，行为逐字保留）。
 *
 * 覆盖原 App.tsx 的两块编排：
 * - 朱雀检测（本地近似 + 官方校准 + LLM 语义层 + 语义/表层融合权重）
 * - 校准实验室（攒真值 → 自动重拟映射与权重）
 *
 * 与主状态的边界：input/output 只读（zqTarget 取「去味稿优先，无则原文」）；
 * pplFeature 只读（检测选项里拼第 13 维）；handleHumanize 需要的写入面通过
 * setZq / setZqText / setZqSem / zqOpts / rerunWithPpl 暴露。
 */
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { classifyGenre } from "../engine/classify-genre";
import { CALIB, trackForGenre, predictOfficialPct } from "../engine/zhuque-calib";
import { aiScore } from "../engine/humanize";
import {
  detectZhuque,
  ZHUQUE_URL,
  type ZhuqueReport,
  type Calibration,
  type SemanticLayer,
} from "../engine/zhuque";
import { detectSemanticStable, semanticAvailable } from "../api/zhuque-semantic";
import type { ApiConfig } from "../api/llm";
import {
  addCalibPoint,
  buildSubmission,
  clearAllCalibration,
  copyText,
  loadCalibration,
  openOfficial,
  parseOfficialResult,
  submissionAdvice,
} from "../api/zhuque";
import {
  loadSamples,
  generateBatch,
  fillOfficial,
  deleteSample,
  clearAllSamples,
  labStats,
  seedTruthAnchors,
  type CalibSample,
} from "../api/calib-lab";
import { loadFuseWeight, saveFuseWeight } from "../store";
import type { PplFeature } from "../ppl/scorer-core";

export interface UseZhuqueLabOptions {
  input: string;
  output: string;
  api: ApiConfig;
  /** 困惑度特征（就绪时并入检测选项作第 13 维），null 表示未就绪 */
  pplFeature: PplFeature | null;
  /** 体裁线覆盖（BenchmarkPanel 手动选择），null 跟随自动判别 */
  genreOverride: "main" | "narrative" | "dialogue" | "humanHand" | null;
}

export interface UseZhuqueLabResult {
  zq: ZhuqueReport | null;
  zqText: string;
  zqCalib: Calibration;
  zqPaste: string;
  zqMsg: string;
  zqFeatures: boolean;
  zqSem: SemanticLayer | null;
  zqSemLoading: boolean;
  zqWeight: number;
  zqGenreEstimate: { pct: number; tag: string } | null;
  setZq: (v: ZhuqueReport | null) => void;
  setZqText: (v: string) => void;
  setZqSem: (v: SemanticLayer | null) => void;
  setZqPaste: (v: string) => void;
  setZqMsg: (v: string) => void;
  setZqFeatures: Dispatch<SetStateAction<boolean>>;
  setLabMsg: (v: string) => void;
  zqOpts: (cal: Calibration | null) => {
    calibration: Calibration | null;
    ppl: { meanNll: number; winStd: number; scoredChars: number; windowCount: number } | null;
  };
  zqTarget: () => string;
  handleZhuque: () => void;
  handleZqCopySubmit: () => Promise<void>;
  handleZqOpenOfficial: () => void;
  handleZqSaveCalib: () => void;
  handleZqSemantic: (bypassCache?: boolean) => Promise<void>;
  handleZqWeight: (v: number) => void;
  handleZqClearCalib: () => void;
  handleLabOpen: () => void;
  handleLabGenerate: () => void;
  handleLabFill: (id: string, inputText: string) => void;
  handleLabDelete: (id: string) => void;
  handleLabClear: () => void;
  handleLabApplyWeight: (w: number) => void;
  handleLabSeed: () => void;
  setShowLab: (v: boolean) => void;
  setLabText: (v: string) => void;
  labSamples: CalibSample[];
  labText: string;
  labMsg: string;
  labPaste: Record<string, string>;
  showLab: boolean;
  setLabPaste: (updater: (p: Record<string, string>) => Record<string, string>) => void;
  /** 困惑度特征就绪后的面板重算入口（面板开着才重算） */
  rerunWithPpl: (feature: PplFeature) => void;
}

const EMPTY_CALIB: Calibration = { a: 1, b: 0, n: 0, points: [] };

export function useZhuqueLab(opts: UseZhuqueLabOptions): UseZhuqueLabResult {
  const { input, output, api, pplFeature, genreOverride } = opts;
  // ---- 朱雀检测（本地近似 + 官方校准） ----
  const [zq, setZq] = useState<ZhuqueReport | null>(null);
  const [zqText, setZqText] = useState("");
  const [zqCalib, setZqCalib] = useState<Calibration>(() => loadCalibration());
  const [zqPaste, setZqPasteRaw] = useState("");
  const [zqMsg, setZqMsg] = useState("");
  const [zqFeatures, setZqFeatures] = useState(false);
  const [zqSem, setZqSem] = useState<SemanticLayer | null>(null);
  const [zqSemLoading, setZqSemLoading] = useState(false);
  const [zqWeight, setZqWeight] = useState<number>(() => loadFuseWeight());
  // ---- 校准实验室（攒真值 → 自动重拟映射与权重） ----
  const [showLab, setShowLab] = useState(false);
  const [labSamples, setLabSamples] = useState<CalibSample[]>([]);
  const [labText, setLabText] = useState("");
  const [labPaste, setLabPaste] = useState<Record<string, string>>({});
  const [labMsg, setLabMsg] = useState("");

  const setZqPaste = (v: string) => setZqPasteRaw(v);

  function zqTarget(): string {
    return (output.trim() ? output : input).trim();
  }

  /** 检测选项：校准映射 + 困惑度层（模型就绪时自动并入，字数不足时引擎内部忽略） */
  function zhuqueOpts(cal: Calibration | null) {
    return {
      calibration: cal,
      ppl: pplFeature
        ? {
            meanNll: pplFeature.meanNll,
            winStd: pplFeature.winStd,
            scoredChars: pplFeature.scoredChars,
            windowCount: pplFeature.windows.length,
          }
        : null,
    };
  }

  function handleZhuque() {
    const t = zqTarget();
    if (!t) return;
    setZqText(t);
    setZq(detectZhuque(t, zhuqueOpts(zqCalib)));
    setZqMsg("");
    setZqSem(null); // 换文本即作废旧的语义层结果，防止张冠李戴
  }

  async function handleZqCopySubmit() {
    const sub = buildSubmission(zqTarget());
    if (!sub.chars) return;
    const ok = await copyText(sub.text);
    setZqMsg(
      `${submissionAdvice(sub.chars)}｜${ok ? "已复制，去官方页面粘贴即可" : "复制失败，请手动复制"}`,
    );
  }

  function handleZqOpenOfficial() {
    if (!openOfficial()) setZqMsg(`浏览器拦截了弹窗，请手动打开 ${ZHUQUE_URL}`);
  }

  function handleZqSaveCalib() {
    const p = parseOfficialResult(zqPaste);
    if (!p.ok || p.probability === null || !zq) {
      setZqMsg(p.note || "解析失败，粘一行官方结果再试");
      return;
    }
    const cal = addCalibPoint(zq.composite, p.probability);
    setZqCalib(cal);
    setZq(detectZhuque(zqText || zqTarget(), zhuqueOpts(cal)));
    setZqPaste("");
    setZqMsg(
      `已记录：本地综合分 ${zq.composite} → 官方 ${p.probability}%（${p.labelText}），现有 ${cal.n} 个校准点`,
    );
  }

  async function handleZqSemantic(bypassCache = false) {
    const t = zqText || zqTarget();
    if (!t || !semanticAvailable(api)) return;
    setZqSemLoading(true);
    setZqMsg("");
    try {
      // 面板「重跑语义层」= 已有结果再点 → 显式绕过缓存真跑一次（LLM 评分会漂移）
      const r = await detectSemanticStable(t, api, { bypassCache });
      setZqSem({ score: r.score, critique: r.critique, source: r.source });
    } catch (e: unknown) {
      setZqMsg(
        "语义层评判失败：" +
          (e instanceof Error ? e.message : String(e)) +
          "（本地表层结果不受影响）",
      );
    } finally {
      setZqSemLoading(false);
    }
  }

  function handleZqWeight(v: number) {
    setZqWeight(v);
    saveFuseWeight(v);
  }

  function handleZqClearCalib() {
    clearAllCalibration();
    setZqCalib(EMPTY_CALIB);
    if (zqText) setZq(detectZhuque(zqText, zhuqueOpts(null)));
    setZqMsg("已清空校准数据（样本保留，可重新回填）");
  }

  function handleLabOpen() {
    setLabSamples(loadSamples());
    setLabMsg("");
    setShowLab(true);
  }

  function handleLabGenerate() {
    if (!labText.trim()) return;
    const batch = generateBatch(labText);
    if (!batch.length) return;
    setLabSamples(loadSamples());
    setLabText("");
    setLabMsg(
      `已生成 ${batch.length} 条样本（原文 + 本地引擎 0.3/0.6/0.9），逐条「复制」去官方送检`,
    );
  }

  function handleLabFill(id: string, inputText: string) {
    const r = fillOfficial(id, inputText);
    setLabMsg(r.note);
    if (r.ok) {
      setLabSamples(loadSamples());
      setLabPaste((p) => ({ ...p, [id]: "" }));
      // 回填成功 → 同步主面板的校准映射
      const cal = loadCalibration();
      setZqCalib(cal);
      if (zqText) setZq(detectZhuque(zqText, zhuqueOpts(cal)));
    }
  }

  function handleLabDelete(id: string) {
    deleteSample(id);
    setLabSamples(loadSamples());
    setLabMsg("已删除该样本");
  }

  function handleLabClear() {
    clearAllSamples();
    setLabSamples([]);
    setZqCalib(EMPTY_CALIB);
    if (zqText) setZq(detectZhuque(zqText, zhuqueOpts(null)));
    setLabMsg("已清空样本库与校准点");
  }

  function handleLabApplyWeight(w: number) {
    handleZqWeight(w);
    setLabMsg(
      `已把语义层权重默认值设为 ${Math.round(w * 100)}%（拟合自 ${labStats().filled} 条回填样本）`,
    );
  }

  function handleLabSeed() {
    const r = seedTruthAnchors();
    setLabSamples(loadSamples());
    const cal = loadCalibration();
    setZqCalib(cal);
    if (zqText) setZq(detectZhuque(zqText, zhuqueOpts(cal)));
    setLabMsg(
      r.added
        ? `已预置 ${r.added} 条样本D官方真值锚点（surface 按当前引擎重算）；注意：锚点参与拟合属自证，真评估靠后续留出样本`
        : `真值锚点已存在（共 ${r.total} 条样本）`,
    );
  }

  // 特征就绪后朱雀面板的重算入口（usePplFlow 注入用）：面板开着才重算
  function rerunWithPpl(feature: PplFeature) {
    if (!zqText) return;
    setZq(
      detectZhuque(zqText, {
        calibration: zqCalib,
        ppl: {
          meanNll: feature.meanNll,
          winStd: feature.winStd,
          scoredChars: feature.scoredChars,
          windowCount: feature.windows.length,
        },
      }),
    );
  }

  // 朱雀面板的体裁线预测：v3 18 点 OLS（与对标评分面板共用 engine/zhuque-calib 同一把尺子）。
  // aiScore + classifyGenre 都是全文扫描，用 useMemo 缓存——面板未开（zq 为 null）时直接跳过，
  // 开着时也只随检测文本/体裁覆盖变化重算，不跟着每次输入键入白跑。
  const zqGenreEstimate = useMemo(() => {
    if (!zq) return null;
    const t = zqText || (output.trim() ? output : input).trim();
    if (!t) return null;
    const g = genreOverride ?? classifyGenre(t).genre;
    const track = trackForGenre(g);
    return {
      pct: Math.round(predictOfficialPct(aiScore(t).score, track) * 10) / 10,
      tag: CALIB[track].x40Tag,
    };
  }, [zq, zqText, input, output, genreOverride]);

  return {
    zq,
    zqText,
    zqCalib,
    zqPaste,
    zqMsg,
    zqFeatures,
    zqSem,
    zqSemLoading,
    zqWeight,
    zqGenreEstimate,
    setZq,
    setZqText,
    setZqSem,
    setZqPaste,
    setZqMsg,
    setZqFeatures,
    setLabMsg,
    zqOpts: zhuqueOpts,
    zqTarget,
    handleZhuque,
    handleZqCopySubmit,
    handleZqOpenOfficial,
    handleZqSaveCalib,
    handleZqSemantic,
    handleZqWeight,
    handleZqClearCalib,
    handleLabOpen,
    handleLabGenerate,
    handleLabFill,
    handleLabDelete,
    handleLabClear,
    handleLabApplyWeight,
    handleLabSeed,
    setShowLab,
    setLabText,
    labSamples,
    labText,
    labMsg,
    labPaste,
    showLab,
    setLabPaste,
    rerunWithPpl,
  };
}
