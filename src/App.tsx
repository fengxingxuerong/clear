import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  runHumanize,
  ApiConfig,
  judgeScoreStable,
  DEEP_MAX_ROUNDS,
  DEEP_TARGET_SCORE,
} from "./api/llm";
import {
  fingerprintCheck,
  checkFidelityLocal,
  FingerprintReport,
  type ScoreBreakdown,
} from "./engine/humanize";
import { DetectorConfig, scoreViaDetector } from "./api/detector";
import {
  loadApi,
  saveApi,
  loadIntensity,
  saveIntensity,
  loadDetector,
  saveDetector,
  loadZhuqueMode,
  saveZhuqueMode,
  hasSecureStore,
  saveApiKeySecure,
  saveDetectorKeySecure,
} from "./store";
import { SettingsModal } from "./components/SettingsModal";
import { ScoreBadge } from "./components/ScoreBadge";
import { TextPane } from "./components/TextPane";
import { DiffView } from "./components/DiffView";
import { HistoryPanel } from "./components/HistoryPanel";
import { FingerprintPanel } from "./components/FingerprintPanel";
import { BenchmarkPanel } from "./components/BenchmarkPanel";
import { loadHistory, saveHistory, clearHistory, makeHistoryEntry, type HistoryEntry } from "./store-history";

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

  function handleFingerprint() {
    const target = output.trim() ? output : input;
    if (!target.trim()) return;
    const fid = output.trim() ? checkFidelityLocal(input, output) : null;
    setFingerprint(fingerprintCheck(target));
    setFidelity(fid);
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
      );
      setOutput(r.text);
      setBefore(r.before);
      setAfter(r.after);
      setJudgeScore(null);
      setJudgeCritique([]);
      setDetectorScore(null);
      setRoundScores(r.roundScores || []);
      let msg = r.usedApi
        ? r.roundScores?.length
          ? "已使用 API 深度去味"
          : "已使用 API（LLM）去味"
        : "使用本地引擎去味（未配置/未启用 API）";
      if (r.note) msg += " · " + r.note;
      const visibleLen = input.replace(/\s/g, "").length;
      if (visibleLen < ZHUQUE_MIN_CHARS) {
        msg += ` · 提示：朱雀检测要求不少于 ${ZHUQUE_MIN_CHARS} 字（当前 ${visibleLen} 字），去味本身不受影响`;
      }
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
    if (!api.enabled || !api.apiKey || !output) return;
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

  function handleSaveSettings(a: ApiConfig, d: DetectorConfig, z: boolean) {
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
    setApi(a);
    setDetector(d);
    setZhuqueMode(z);
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
        {api.enabled && api.apiKey.trim() && (
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
      </div>

          <FingerprintPanel
            fingerprint={fingerprint}
            fidelity={fidelity}
            checkingOutput={outputHasText}
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
            onNote={setNote}
          />

      {note && <div className="note">{note}</div>}

      {showSettings && (
        <SettingsModal
          api={api}
          detector={detector}
          zhuqueMode={zhuqueMode}
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
