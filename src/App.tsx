import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  runHumanize,
  ApiConfig,
  judgeScoreStable,
  effectiveKeys,
  DEEP_MAX_ROUNDS,
  DEEP_TARGET_SCORE,
} from "./api/llm";
import {
  fingerprintCheck,
  checkFidelityLocal,
  pplIssues as derivePplIssues,
  aiScore,
  FingerprintReport,
  type ScoreBreakdown,
} from "./engine/humanize";
import { classifyGenre } from "./engine/classify-genre";
import { CALIB, trackForGenre, predictOfficialPct } from "./engine/zhuque-calib";
import { detectSemanticStable, semanticAvailable } from "./api/zhuque-semantic";
import { DetectorConfig, scoreViaDetector } from "./api/detector";
import {
  computePplFeature,
  ensurePplModel,
  pplStatus,
  isPplReady,
  type PplProgressInfo,
} from "./ppl/ppl-client";
import type { PplIssueLite } from "./components/FingerprintPanel";
import type { PplFeature } from "./ppl/scorer-core";
import {
  loadApi,
  saveApi,
  loadIntensity,
  saveIntensity,
  loadDetector,
  saveDetector,
  loadZhuqueMode,
  saveZhuqueMode,
  loadPplEnabled,
  savePplEnabled,
  hasSecureStore,
  saveApiKeySecure,
  saveDetectorKeySecure,
  loadFuseWeight,
  saveFuseWeight,
  loadLocal,
  saveLocal,
  type LocalSettings,
} from "./store";
import {
  detectZhuque,
  ZHUQUE_URL,
  type ZhuqueReport,
  type Calibration,
  type SemanticLayer,
} from "./engine/zhuque";
import { detectAI, type DetectReport } from "./engine/detector";
import {
  addCalibPoint,
  buildSubmission,
  clearAllCalibration,
  copyText,
  loadCalibration,
  openOfficial,
  parseOfficialResult,
  submissionAdvice,
} from "./api/zhuque";
import {
  loadSamples,
  generateBatch,
  fillOfficial,
  deleteSample,
  clearAllSamples,
  labStats,
  seedTruthAnchors,
  type CalibSample,
} from "./api/calib-lab";
import { SettingsModal } from "./components/SettingsModal";
import { ScoreBadge } from "./components/ScoreBadge";
import { TextPane } from "./components/TextPane";
import { DiffView } from "./components/DiffView";
import { HistoryPanel } from "./components/HistoryPanel";
import { FingerprintPanel } from "./components/FingerprintPanel";
import { BenchmarkPanel } from "./components/BenchmarkPanel";
import { ZhuquePanel } from "./components/ZhuquePanel";
import { CalibLabModal } from "./components/CalibLabModal";
import { LocalDetectPanel } from "./components/LocalDetectPanel";
import {
  loadHistory,
  saveHistory,
  clearHistory,
  makeHistoryEntry,
  type HistoryEntry,
} from "./store-history";

type Score = ScoreBreakdown;

/** 朱雀网页版检测文本长度门槛：送检前给出提示，去味本身不受影响 */
const ZHUQUE_MIN_CHARS = 350;

/** 「示例」按钮载入的样例文本 */
const SAMPLE_TEXT = `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。
综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。
然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。
从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。
因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的发展。`;

export default function App({
  initialApi,
  initialDetector,
}: {
  initialApi?: ApiConfig;
  initialDetector?: DetectorConfig;
}) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [intensity, setIntensity] = useState<number>(loadIntensity());
  const [zhuqueMode, setZhuqueMode] = useState<boolean>(loadZhuqueMode());
  const [genreOverride, setGenreOverride] = useState<
    "main" | "narrative" | "dialogue" | "humanHand" | null
  >(null);
  const [api, setApi] = useState<ApiConfig>(initialApi ?? loadApi());
  const [detector, setDetector] = useState<DetectorConfig>(initialDetector ?? loadDetector());
  const [judgeScore, setJudgeScore] = useState<number | null>(null);
  const [judgeCritique, setJudgeCritique] = useState<string[]>([]);
  const [detectorScore, setDetectorScore] = useState<number | null>(null);
  const [zhuqueManualScore, setZhuqueManualScore] = useState<string>("");
  const [judging, setJudging] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [before, setBefore] = useState<Score | null>(null);
  const [after, setAfter] = useState<Score | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [roundScores, setRoundScores] = useState<number[]>([]);
  const [fingerprint, setFingerprint] = useState<FingerprintReport | null>(null);
  const [fidelity, setFidelity] = useState<{ pass: boolean; problems: string[] } | null>(null);
  // ---- 困惑度第 8 项状态机 ----
  const [pplEnabled, setPplEnabled] = useState<boolean>(loadPplEnabled());
  const [pplState, setPplState] = useState<
    "idle" | "need-download" | "downloading" | "loading" | "done" | "error" | "unsupported"
  >("idle");
  const [pplFeature, setPplFeature] = useState<PplFeature | null>(null);
  const [pplIssues, setPplIssues] = useState<PplIssueLite[] | null>(null);
  const [pplProgress, setPplProgress] = useState<number | null>(null);
  const [pplNote, setPplNote] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  // ---- 朱雀检测（本地近似 + 官方校准）与本地 AI 检测 ----
  const [detectIn, setDetectIn] = useState<DetectReport | null>(null);
  const [detectOut, setDetectOut] = useState<DetectReport | null>(null);
  const [showDetectFeatures, setShowDetectFeatures] = useState(false);
  const [zq, setZq] = useState<ZhuqueReport | null>(null);
  const [zqText, setZqText] = useState("");
  const [zqCalib, setZqCalib] = useState<Calibration>(() => loadCalibration());
  const [zqPaste, setZqPaste] = useState("");
  const [zqMsg, setZqMsg] = useState("");
  const [zqFeatures, setZqFeatures] = useState(false);
  const [zqSem, setZqSem] = useState<SemanticLayer | null>(null);
  const [zqSemLoading, setZqSemLoading] = useState(false);
  const [zqWeight, setZqWeight] = useState<number>(() => loadFuseWeight());
  const [showLab, setShowLab] = useState(false);
  const [labSamples, setLabSamples] = useState<CalibSample[]>([]);
  const [labText, setLabText] = useState("");
  const [labPaste, setLabPaste] = useState<Record<string, string>>({});
  const [labMsg, setLabMsg] = useState("");
  const [local, setLocal] = useState<LocalSettings>(() => loadLocal());

  // 第 8 项（困惑度）：模型就绪才推理；未下载转引导态；失败静默降级为仅 7 项
  async function runPplFeature(target: string): Promise<void> {
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
      if (zqText) {
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
    } catch {
      setPplFeature(null);
      setPplIssues(null);
      setPplState("error");
    }
  }

  async function ensurePpl(): Promise<void> {
    if (pplState === "downloading") return;
    setPplState("downloading");
    setPplProgress(0);
    try {
      await ensurePplModel((p: PplProgressInfo) => {
        if (typeof p.progress === "number") setPplProgress(p.progress);
      });
      setPplState("idle");
      const target = output.trim() ? output : input;
      if (target.trim()) void runPplFeature(target);
    } catch (e: unknown) {
      setPplState("error");
      setPplNote("模型下载失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  function handleFingerprint() {
    const target = output.trim() ? output : input;
    if (!target.trim()) return;
    const fid = output.trim() ? checkFidelityLocal(input, output) : null;
    setFingerprint(fingerprintCheck(target));
    setFidelity(fid);
    setPplNote(null);
    void runPplFeature(target);
  }

  async function handleHumanize() {
    if (!input.trim()) return;
    setLoading(true);
    setNote("");
    setRoundScores([]);
    setFingerprint(null);
    setFidelity(null);
    try {
      const r = await runHumanize(
        input,
        intensity,
        api,
        (round, score, stage) => {
          setNote(
            score !== null && score >= 0
              ? `${stage ?? ""}深度去味第 ${round} 轮完成，LLM 评分 ${score}${score <= DEEP_TARGET_SCORE ? "（已达标）" : "，继续压…"}`
              : `${stage ?? ""}深度去味第 ${round} 轮完成，本轮评分失败，继续…`,
          );
        },
        zhuqueMode,
        genreOverride ?? undefined,
        local.bestOf ? { bestOf: true, candidates: local.candidates } : undefined,
      );
      setOutput(r.text);
      setBefore(r.before);
      setAfter(r.after);
      setJudgeScore(null);
      setJudgeCritique([]);
      setDetectorScore(null);
      setRoundScores(r.roundScores || []);
      // 闭环复检：本地 AI 检测（原文 vs 去味稿降档对照）+ 朱雀口径三档占比
      const din = detectAI(input);
      const dout = detectAI(r.text);
      setDetectIn(din);
      setDetectOut(dout);
      setZqSem(null); // 新去味稿：旧语义层结果作废
      const zt = r.text.trim();
      setZqText(zt);
      const zr = detectZhuque(zt, zhuqueOpts(zqCalib));
      setZq(zr);
      let msg = r.usedApi
        ? r.roundScores?.length
          ? "已使用 API 深度去味"
          : "已使用 API（LLM）去味"
        : "使用本地引擎去味（未配置/未启用 API）";
      if (r.note) msg += " · " + r.note;
      if (r.bestOf) {
        msg += ` · 多候选择优：${r.bestOf.tried} 稿中挑最优（淘汰 ${r.bestOf.rejected} 稿，中选种子 ${r.bestOf.seed}）`;
      }
      const visibleLen = input.replace(/\s/g, "").length;
      if (visibleLen < ZHUQUE_MIN_CHARS) {
        msg += ` · 提示：朱雀检测要求不少于 ${ZHUQUE_MIN_CHARS} 字（当前 ${visibleLen} 字），去味本身不受影响`;
      }
      msg += ` · 本地检测：${din.levelText}(${din.probability}%) → ${dout.levelText}(${dout.probability}%)`;
      msg += ` · 朱雀口径：AI特征占比 ${zr.ratios.ai}%（${zr.labelText}）`;
      // 检测器自动闭环：已配置外部检测器时，去味后自动送检一次（真实分回显，
      // 形成"改写→检测"闭环的一部分），不再需要手动点「用外部检测器」
      if (detector.enabled && detector.url.trim() && r.text.trim()) {
        try {
          const s = await scoreViaDetector(r.text, detector);
          setDetectorScore(s);
          msg += ` · 检测器自动送检：${s} 分`;
        } catch (de: unknown) {
          msg += " · 检测器送检失败：" + (de instanceof Error ? de.message : String(de));
        }
      }
      setNote(msg);
      // 保存到历史记录
      const entry = makeHistoryEntry(input, r.text, r.before, r.after, intensity, r.usedApi);
      saveHistory(entry);
      setHistory(loadHistory());
    } catch (e: unknown) {
      setNote("出错了：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }

  function copy() {
    if (!output) return;
    navigator.clipboard?.writeText(output);
    setNote("已复制到剪贴板");
  }

  async function handleJudge() {
    if (!api.enabled || effectiveKeys(api).length === 0 || !output) return;
    setJudging(true);
    try {
      const r = await judgeScoreStable(output, api);
      setJudgeScore(r.score);
      setJudgeCritique(r.critique);
    } catch (e: unknown) {
      setNote("LLM 评判失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setJudging(false);
    }
  }

  async function handleDetect() {
    if (!detector.enabled || !detector.url || !output) return;
    setDetecting(true);
    try {
      const s = await scoreViaDetector(output, detector);
      setDetectorScore(s);
    } catch (e: unknown) {
      setNote("检测器调用失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDetecting(false);
    }
  }

  /* ---- 本地 AI 检测（14 特征离线启发式，原文 vs 去味稿降档对照） ---- */

  function handleLocalDetect() {
    const target = output.trim() ? output : input;
    if (!target.trim()) return;
    setDetectIn(detectAI(input));
    setDetectOut(output.trim() ? detectAI(output) : null);
    setShowDetectFeatures(false);
  }

  /* ---- 朱雀检测（本地近似 + 官方校准） ---- */

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
    setZqCalib({ a: 1, b: 0, n: 0, points: [] });
    if (zqText) setZq(detectZhuque(zqText, zhuqueOpts(null)));
    setZqMsg("已清空校准数据（样本保留，可重新回填）");
  }

  /* ---- 校准实验室（攒真值 → 自动重拟映射与权重） ---- */

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

  function handleLabFill(id: string, input: string) {
    const r = fillOfficial(id, input);
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
    setZqCalib({ a: 1, b: 0, n: 0, points: [] });
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

  function handleSaveSettings(
    a: ApiConfig,
    d: DetectorConfig,
    z: boolean,
    ppl: boolean,
    l: LocalSettings,
  ) {
    // 桌面版：主 API Key 与外部检测器 Key 都通过 safeStorage 加密存储；Web 版仍走 localStorage
    if (hasSecureStore()) {
      void saveApiKeySecure(a.apiKey);
      saveApi({ ...a, apiKey: "" }); // 只存非敏感字段到 localStorage
      void saveDetectorKeySecure(d.apiKey);
      saveDetector({ ...d, apiKey: "" }); // 检测器 Key 同样不落明文
    } else {
      saveApi(a);
      saveDetector(d);
    }
    saveZhuqueMode(z);
    savePplEnabled(ppl);
    saveLocal(l);
    setApi(a);
    setDetector(d);
    setZhuqueMode(z);
    setPplEnabled(ppl);
    setLocal(l);
    setShowSettings(false);
    setNote("设置已保存（仅存本地）");
  }

  // 强度滑块防抖落盘：拖动时高频 onChange 只更新内存状态，停手 300ms 后再写 localStorage，
  // 避免拖动过程连续同步 IO（长文场景下会卡手感）
  const intensitySaveRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(intensitySaveRef.current);
    intensitySaveRef.current = window.setTimeout(() => saveIntensity(intensity), 300);
    return () => window.clearTimeout(intensitySaveRef.current);
  }, [intensity]);

  // 非空判定派生为布尔值：渲染体里只比布尔，避免每次按键对全文做 trim() 拷贝
  const inputHasText = useMemo(() => input.trim().length > 0, [input]);
  const outputHasText = useMemo(() => output.trim().length > 0, [output]);

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

  // ---- 稳定回调（供 memo 化的 TextPane 使用，避免右侧面板随左侧输入重渲） ----
  const hotkeyRef = useRef<() => void>(() => {});
  hotkeyRef.current = handleHumanize;
  const handleInputHotkey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") hotkeyRef.current();
  }, []);
  const handleInputChange = useCallback((v: string) => setInput(v), []);
  const handleOutputChange = useCallback((v: string) => setOutput(v), []);
  const openSettings = useCallback(() => setShowSettings(true), []);

  function handleClear() {
    setInput("");
    setOutput("");
    setNote("");
    setBefore(null);
    setAfter(null);
    setJudgeScore(null);
    setJudgeCritique([]);
    setDetectorScore(null);
    setRoundScores([]);
    setFingerprint(null);
    setFidelity(null);
    setDetectIn(null);
    setDetectOut(null);
    setZq(null);
    setZqSem(null);
    setZqMsg("");
  }

  function handleSample() {
    setInput(SAMPLE_TEXT);
    setOutput("");
    setNote("已载入示例文本，点「去味」试一把。");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⚡</span>
          <div>
            <div className="title">趣AI味 · QuAiWei</div>
            <div className="subtitle">本地引擎离线可用 · 可选接 LLM · 对标朱雀</div>
          </div>
        </div>
        <button className="gear" onClick={openSettings}>
          ⚙ 设置
        </button>
      </header>

      <main className="grid">
        <TextPane
          label="原文（AI 稿）"
          value={input}
          onChange={handleInputChange}
          onHotkey={handleInputHotkey}
          placeholder="把 AI 写的文章粘进来……（Ctrl+Enter 快速去味）"
        />
        <TextPane
          label="去味后（人写感）"
          value={output}
          onChange={handleOutputChange}
          placeholder="点击「去味」生成……（生成后可直接手工润色，改完点「指纹体检」复查）"
        />
      </main>

      <div className="controls">
        <div className="slider">
          <label>
            去味强度 <b>{Math.round(intensity * 100)}%</b>
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={intensity}
            onChange={(e) => setIntensity(parseFloat(e.target.value))}
          />
        </div>
        {api.enabled && effectiveKeys(api).length > 0 && (
          <span
            className="mode-tag"
            title={
              api.deepMode
                ? `改写 → LLM评分 → 未达标自动再改写，最多 ${DEEP_MAX_ROUNDS} 轮`
                : "单次 LLM 改写（设置里可开深度模式）"
            }
          >
            {api.deepMode ? "⚡ 深度模式" : "LLM 单轮"}
          </span>
        )}
        <label
          className={`mode-tag ${zhuqueMode ? "active" : ""}`}
          title="朱雀增强：叠加方言/插入语/句式片段/主观意见/括号自语等反检测特征"
          style={
            zhuqueMode
              ? {
                  color: "#ff5d6c",
                  borderColor: "rgba(255, 93, 108, 0.5)",
                  background: "rgba(255, 93, 108, 0.1)",
                  cursor: "pointer",
                }
              : { cursor: "pointer" }
          }
        >
          <input
            type="checkbox"
            checked={zhuqueMode}
            onChange={(e) => {
              setZhuqueMode(e.target.checked);
              saveZhuqueMode(e.target.checked);
            }}
            style={{ display: "none" }}
          />
          🛡 朱雀增强
        </label>
        <button className="primary" onClick={handleHumanize} disabled={loading}>
          {loading ? "处理中…" : "去味"}
        </button>
        <button className="ghost" onClick={copy} disabled={!output}>
          复制
        </button>
        <button
          className="ghost"
          onClick={() => setShowDiff(true)}
          disabled={!inputHasText || !outputHasText}
        >
          对比
        </button>
        <button className="ghost" onClick={handleClear}>
          清空
        </button>
        <button className="ghost" onClick={handleSample}>
          示例
        </button>
        <button className="ghost" onClick={() => setShowHistory(true)}>
          历史
        </button>
        <button
          className="ghost"
          onClick={handleFingerprint}
          disabled={!outputHasText && !inputHasText}
        >
          指纹体检
        </button>
        <button className="ghost" onClick={handleLocalDetect} disabled={!inputHasText}>
          AI 检测
        </button>
        <button className="ghost" onClick={handleZhuque} disabled={!inputHasText && !outputHasText}>
          朱雀检测
        </button>
      </div>

      <FingerprintPanel
        fingerprint={fingerprint}
        fidelity={fidelity}
        checkingOutput={outputHasText}
        pplEnabled={pplEnabled}
        pplState={pplState}
        pplFeature={pplFeature}
        pplIssues={pplIssues}
        pplProgress={pplProgress}
        pplNote={pplNote}
        onDownloadPpl={() => void ensurePpl()}
      />

      {before && after && (
        <div className="scores">
          <ScoreBadge label="去味前 · AI味" s={before} tone="before" />
          <ScoreBadge label="去味后 · AI味" s={after} tone="after" />
          <div className="delta">
            <div className="delta-label">降幅</div>
            <div
              className="delta-value"
              style={{ color: after.score <= before.score ? "#3ddc97" : "#ff5d6c" }}
            >
              {before.score - after.score > 0 ? "−" : "+"}
              {Math.abs(before.score - after.score)}
            </div>
          </div>
        </div>
      )}

      <BenchmarkPanel
        output={output}
        after={after}
        roundScores={roundScores}
        judging={judging}
        detecting={detecting}
        api={api}
        detector={detector}
        judgeScore={judgeScore}
        judgeCritique={judgeCritique}
        detectorScore={detectorScore}
        zhuqueManualScore={zhuqueManualScore}
        onJudge={handleJudge}
        onDetect={handleDetect}
        onManualScore={setZhuqueManualScore}
        onGenreChange={setGenreOverride}
        onNote={setNote}
      />

      {(detectIn || detectOut) && (
        <LocalDetectPanel
          detectIn={detectIn}
          detectOut={detectOut}
          showFeatures={showDetectFeatures}
          onToggleFeatures={() => setShowDetectFeatures((v) => !v)}
        />
      )}

      {zq && (
        <ZhuquePanel
          text={zqText || zqTarget()}
          rep={zq}
          calib={zqCalib}
          paste={zqPaste}
          msg={zqMsg}
          showFeatures={zqFeatures}
          sem={zqSem}
          semLoading={zqSemLoading}
          weight={zqWeight}
          canRunSemantic={semanticAvailable(api)}
          genreEstimate={zqGenreEstimate}
          onPaste={setZqPaste}
          onSaveCalib={handleZqSaveCalib}
          onClearCalib={handleZqClearCalib}
          onCopySubmit={handleZqCopySubmit}
          onOpenOfficial={handleZqOpenOfficial}
          onOpenLab={handleLabOpen}
          onToggleFeatures={() => setZqFeatures((v) => !v)}
          onRunSemantic={() => void handleZqSemantic(!!zqSem)}
          onWeight={handleZqWeight}
        />
      )}

      {showLab && (
        <CalibLabModal
          samples={labSamples}
          text={labText}
          msg={labMsg}
          pasteMap={labPaste}
          onText={setLabText}
          onPaste={(id, v) => setLabPaste((p) => ({ ...p, [id]: v }))}
          onClose={() => setShowLab(false)}
          onGenerate={handleLabGenerate}
          onFill={handleLabFill}
          onCopy={async (t) => {
            const ok = await copyText(t);
            setLabMsg(ok ? "已复制（超 2000 字会按句子边界截断）" : "复制失败，请手动复制");
          }}
          onDelete={handleLabDelete}
          onClear={handleLabClear}
          onApplyWeight={handleLabApplyWeight}
          onSeed={handleLabSeed}
        />
      )}

      {note && <div className="note">{note}</div>}

      {showSettings && (
        <SettingsModal
          api={api}
          detector={detector}
          zhuqueMode={zhuqueMode}
          pplEnabled={pplEnabled}
          local={local}
          onClose={() => setShowSettings(false)}
          onSave={handleSaveSettings}
        />
      )}

      {showDiff && inputHasText && outputHasText && (
        <DiffView before={input} after={output} onClose={() => setShowDiff(false)} />
      )}

      {showHistory && (
        <HistoryPanel
          entries={history}
          onLoad={(e) => {
            setInput(e.input);
            setOutput(e.output);
            setNote(`已载入历史记录（${e.timestamp}）`);
          }}
          onClear={() => {
            clearHistory();
            setHistory([]);
          }}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}
