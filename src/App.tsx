import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  runHumanize,
  ApiConfig,
  judgeScoreStable,
  effectiveKeys,
  DEEP_MAX_ROUNDS,
  DEEP_TARGET_SCORE,
} from "./api/llm";
import { fingerprintCheck, checkFidelityLocal } from "./engine/humanize";
import type { FingerprintReport, ScoreBreakdown } from "./engine/humanize";
import { detectAI, type DetectReport } from "./engine/detector";
import { detectZhuque } from "./engine/zhuque";
import { DetectorConfig, scoreViaDetector } from "./api/detector";
import { semanticAvailable } from "./api/zhuque-semantic";
import {
  loadApi,
  loadIntensity,
  saveIntensity,
  loadDetector,
  saveDetector,
  loadZhuqueMode,
  saveZhuqueMode,
  savePplEnabled,
  hasSecureStore,
  persistApiConfig,
  saveDetectorKeySecure,
  loadLocal,
  saveLocal,
  loadProtectedTerms,
  saveProtectedTerms,
  parseProtectedTerms,
  loadDraft,
  saveDraft,
  clearDraft,
  type LocalSettings,
} from "./store";
import { setProtectedTerms } from "./engine/term-protect";
import { copyText } from "./api/zhuque";
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
import { usePplFlow } from "./hooks/usePplFlow";
import { useZhuqueLab } from "./hooks/useZhuqueLab";
import { buildHumanizeNote, formatRestoredNote } from "./app-messages";
import {
  importFileToText,
  makeDatedName,
  downloadBlob,
  exportDocxBlob,
  makeTxtBlob,
} from "./app-fileio";
import type { PplFeature } from "./ppl/scorer-core";

type Score = ScoreBreakdown;

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
  // 草稿恢复：刷新/误关标签页后把上次编辑中的内容拿回来（v0.9.15）。
  // 只取一次并存在 ref 里——若用 state，恢复提示会被后续 effect 反复触发。
  const restoredDraft = useRef<ReturnType<typeof loadDraft>>(loadDraft());
  const [input, setInput] = useState(() => restoredDraft.current?.input ?? "");
  const [output, setOutput] = useState(() => restoredDraft.current?.output ?? "");
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
  const [showDiff, setShowDiff] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  // ---- 本地 AI 检测（14 特征离线启发式） ----
  const [detectIn, setDetectIn] = useState<DetectReport | null>(null);
  const [detectOut, setDetectOut] = useState<DetectReport | null>(null);
  const [showDetectFeatures, setShowDetectFeatures] = useState(false);
  const [local, setLocal] = useState<LocalSettings>(() => loadLocal());
  // 自定义保护术语（原文）。term-protect 的保护集是模块级全局，挂载时注入一次；
  // 设置里改完由 handleSaveSettings 再注入。
  const [protectedTermsRaw, setProtectedTermsRaw] = useState<string>(() => loadProtectedTerms());

  // ---- 困惑度第 8 项 + 朱雀检测/校准实验室编排（自本组件抽出，行为不变） ----
  // 两个 hook 互有依赖（ppl 特征 → 朱雀面板重算），用 ref 中转打破声明顺序循环：
  // usePplFlow 先声明（useZhuqueLab 要吃 pplFeature），其 applyPplToZhuque 回调
  // 经 ref 转发到 useZhuqueLab 的 rerunWithPpl——ref.current 每次渲染刷新，语义等价
  // 于原实现里闭包直读最新 state。
  const rerunPplRef = useRef<(f: PplFeature) => void>(() => {});
  const {
    pplEnabled,
    setPplEnabled,
    pplState,
    pplFeature,
    pplIssues,
    pplProgress,
    pplNote,
    setPplNote,
    runPplFeature,
    ensurePpl,
  } = usePplFlow({
    applyPplToZhuque: (feature) => rerunPplRef.current(feature),
    getAnalysisTarget: () => (output.trim() ? output : input),
  });
  const {
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
    zqOpts,
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
  } = useZhuqueLab({ input, output, api, pplFeature, genreOverride });
  rerunPplRef.current = rerunWithPpl;

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
      const zr = detectZhuque(zt, zqOpts(zqCalib));
      setZq(zr);
      // 结果文案组装已抽纯函数（src/app-messages.ts）：按真实产出引擎如实标注，
      // 回归防护见 src/app-messages.test.ts
      let detectorNote: string | undefined;
      // 检测器自动闭环：已配置外部检测器时，去味后自动送检一次（真实分回显，
      // 形成"改写→检测"闭环的一部分），不再需要手动点「用外部检测器」
      if (detector.enabled && detector.url.trim() && r.text.trim()) {
        try {
          const s = await scoreViaDetector(r.text, detector);
          setDetectorScore(s);
          detectorNote = ` · 检测器自动送检：${s} 分`;
        } catch (de: unknown) {
          detectorNote = " · 检测器送检失败：" + (de instanceof Error ? de.message : String(de));
        }
      }
      const msg = buildHumanizeNote({ r, input, din, dout, zr, detectorNote });
      setNote(msg);
      // 保存到历史记录
      const entry = makeHistoryEntry(input, r.text, r.before, r.after, intensity, r.usedApi, r.engine);
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

  async function handleSaveSettings(
    a: ApiConfig,
    d: DetectorConfig,
    z: boolean,
    ppl: boolean,
    l: LocalSettings,
    terms: string,
  ) {
    // 桌面版：主 API Key 与 Key 池都经 safeStorage 加密落盘（persistApiConfig 里判定，
    // 只有两个字段都确实写进加密存储才抹 localStorage 明文）；Web 版仍走 localStorage
    await persistApiConfig(a);
    if (hasSecureStore()) {
      const okDet = await saveDetectorKeySecure(d.apiKey);
      if (okDet) saveDetector({ ...d, apiKey: "" });
      else saveDetector(d);
    } else {
      saveDetector(d);
    }
    saveZhuqueMode(z);
    savePplEnabled(ppl);
    saveLocal(l);
    saveProtectedTerms(terms);
    // 术语保护是模块级全局（term-protect 的 userTerms），存盘之外必须当场注入才生效
    setProtectedTerms(parseProtectedTerms(terms));
    setApi(a);
    setDetector(d);
    setZhuqueMode(z);
    setPplEnabled(ppl);
    setLocal(l);
    setProtectedTermsRaw(terms);
    setShowSettings(false);
    setNote("设置已保存（仅存本地）");
  }

  // 挂载时提示草稿已恢复（只跑一次）；时长文案见 src/app-messages.ts
  useEffect(() => {
    const d = restoredDraft.current;
    if (!d || (!d.input.trim() && !d.output.trim())) return;
    setNote(formatRestoredNote(d.ts, d.input.length));
  }, []);

  // 草稿防抖落盘：每次键入都写会让长文手感变卡（与强度滑块同一手法）
  const draftSaveRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(draftSaveRef.current);
    draftSaveRef.current = window.setTimeout(() => {
      if (!input.trim() && !output.trim()) clearDraft();
      else saveDraft(input, output);
    }, 500);
    return () => window.clearTimeout(draftSaveRef.current);
  }, [input, output]);

  // 挂载时把持久化的自定义术语注入引擎（否则刷新后保护集只剩内置 58 项）
  useEffect(() => {
    setProtectedTerms(parseProtectedTerms(protectedTermsRaw));
  }, [protectedTermsRaw]);

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
    clearDraft(); // 显式清空：草稿随之丢弃，下次打开是干净的
  }

  function handleSample() {
    setInput(SAMPLE_TEXT);
    setOutput("");
    setNote("已载入示例文本，点「去味」试一把。");
  }

  /* ---------------- 文件导入 / 导出（v0.9.15） ----------------
   * 纯逻辑已抽到 src/app-fileio.ts（导入分支/导出文件名/下载），
   * 这里只做状态接线；行为与文案逐字保留。
   */
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // 清空 value，否则连选两次同一文件不会触发 change
    if (!f) return;
    void importFileToText(f).then((res) => {
      if (res.text) {
        setInput(res.text);
        setOutput("");
      }
      setNote(res.note);
    });
  }

  // v0.9.16：导出 .docx——纯文本按段落生成最小合法 OOXML（零依赖，src/docx-io.ts）。
  // 富文本格式（加粗/公式/图片）不保留——引擎输出本就是纯文本。
  async function handleExportDocx() {
    if (!output) return;
    try {
      const name = makeDatedName("docx");
      const blob = await exportDocxBlob(output);
      downloadBlob(blob, name);
      setNote("已导出 .docx（纯文本内容，Word/WPS 可打开）。");
    } catch (err: unknown) {
      setNote(`docx 导出失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleExport() {
    if (!output) return;
    const name = makeDatedName("txt");
    downloadBlob(makeTxtBlob(output), name);
    setNote(`已导出 ${name}`);
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
          onClick={handleExport}
          disabled={!output}
          title="把去味结果下载为 .txt"
        >
          导出 .txt
        </button>
        <button
          className="ghost"
          onClick={handleExportDocx}
          disabled={!output}
          title="把去味结果下载为 .docx（纯文本内容，Word/WPS 可打开）"
        >
          导出 .docx
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.markdown,.docx,text/plain"
          onChange={handleImportFile}
          style={{ display: "none" }}
        />
        <button
          className="ghost"
          onClick={() => fileInputRef.current?.click()}
          title="从 .txt / .md 导入原文（≤2MB）"
        >
          导入
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
          protectedTerms={protectedTermsRaw}
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
