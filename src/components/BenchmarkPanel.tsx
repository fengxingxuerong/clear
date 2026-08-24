/**
 * 趣AI味 · 对标评分面板：深度轮次分、LLM 评判、外部检测器、朱雀送检回填
 */
import { DEEP_TARGET_SCORE, type ApiConfig } from "../api/llm";
import type { DetectorConfig } from "../api/detector";
import type { ScoreBreakdown } from "../engine/humanize";

interface BenchmarkPanelProps {
  output: string;
  after: ScoreBreakdown | null;
  roundScores: number[];
  judging: boolean;
  detecting: boolean;
  api: ApiConfig;
  detector: DetectorConfig;
  judgeScore: number | null;
  judgeCritique: string[];
  detectorScore: number | null;
  zhuqueManualScore: string;
  onJudge: () => void;
  onDetect: () => void;
  onManualScore: (v: string) => void;
  onNote: (v: string) => void;
}

export function BenchmarkPanel({
  output,
  after,
  roundScores,
  judging,
  detecting,
  api,
  detector,
  judgeScore,
  judgeCritique,
  detectorScore,
  zhuqueManualScore,
  onJudge,
  onDetect,
  onManualScore,
  onNote,
}: BenchmarkPanelProps) {
  if (!output) return null;
  return (
<div className="bench">
  <div className="bench-head">对标评分（真实通道，非本地代理分）</div>
  {roundScores.length > 0 && (
    <div className="bench-row">
      <span>
        深度去味各轮 LLM 评分：
        <b>{roundScores.map((s) => (s < 0 ? "失败" : s)).join(" → ")}</b>（目标 ≤
        {DEEP_TARGET_SCORE}）
      </span>
    </div>
  )}
  <div className="bench-row">
    <span>
      本地代理分（去味后）：<b>{after?.score}</b>
    </span>
    <button
      className="ghost sm"
      onClick={onJudge}
      disabled={!api.enabled || !api.apiKey || judging}
    >
      {judging ? "评判中…" : "用 LLM 评判"}
    </button>
    {judgeScore !== null && <span className="tag">LLM 评判：{judgeScore}</span>}
  </div>
  {judgeScore !== null && judgeCritique.length > 0 && (
    <div className="bench-row" style={{ flexWrap: "wrap" }}>
      <span style={{ color: "var(--muted)", fontSize: 12 }}>
        残留痕迹：{judgeCritique.join("；")}
      </span>
    </div>
  )}
  <div className="bench-row">
    <button
      className="ghost sm"
      onClick={onDetect}
      disabled={!detector.enabled || !detector.url || detecting}
    >
      {detecting ? "检测中…" : "用外部检测器"}
    </button>
    {detectorScore !== null && <span className="tag">检测器：{detectorScore}</span>}
  </div>
  {/* 朱雀免费版：半自动送检——复制文本 + 打开网页，用户手动检测后回填分 */}
  <div className="bench-row">
    <button
      className="ghost sm"
      onClick={() => {
        if (!output) return;
        navigator.clipboard?.writeText(output);
        window.open("https://matrix.tencent.com/ai-detect/ai_gen_txt/", "_blank");
        onNote("已复制去味文本并打开朱雀检测页——粘贴检测后，在下方填入朱雀分");
      }}
      disabled={!output}
    >
      🔍 朱雀送检（免费网页版）
    </button>
    <input
      type="number"
      min={0}
      max={100}
      value={zhuqueManualScore}
      onChange={(e) => onManualScore(e.target.value)}
      placeholder="朱雀分"
      style={{ width: 80, background: "rgba(8,12,22,0.7)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px", outline: "none" }}
    />
    {zhuqueManualScore && (
      <span
        className="tag"
        style={{
          color: Number(zhuqueManualScore) < 30 ? "#3ddc97" : "#ff5d6c",
          borderColor: Number(zhuqueManualScore) < 30 ? "rgba(61,220,151,0.3)" : "rgba(255,93,108,0.3)",
          background: Number(zhuqueManualScore) < 30 ? "rgba(61,220,151,0.1)" : "rgba(255,93,108,0.1)",
        }}
      >
        朱雀：{zhuqueManualScore} {Number(zhuqueManualScore) < 30 ? "✅" : "❌"}
      </span>
    )}
  </div>
  {!api.enabled && !detector.enabled && (
    <div className="bench-tip">
      对标检测两条路径：<b>① 免费</b>——点上方「朱雀送检」自动复制文本并打开朱雀网页，手动检测后回填分数；
      <b>② 自动</b>——在「设置」里配 EdgeOne 朱雀 API 网关（企业版），去味后自动送检。
    </div>
  )}
</div>
  );
}
