import { type DetectReport } from "../engine/detector";

function LevelBadge({ label, rep }: { label: string; rep: DetectReport }) {
  const color = rep.level === "high" ? "#ff5d6c" : rep.level === "medium" ? "#ffb454" : "#3ddc97";
  const mark = rep.level === "high" ? "🔴" : rep.level === "medium" ? "🟡" : "🟢";
  return (
    <div className="score-badge">
      <div className="score-label">{label}</div>
      <div className="score-value" style={{ color, fontSize: 24 }}>
        {mark} {rep.levelText}
      </div>
      <div className="score-sub">
        AI 概率 {rep.probability}% · 置信 {rep.confidence}%
      </div>
    </div>
  );
}

/** 本地 AI 检测（14 特征离线启发式）：原文与去味稿一起测，形成"降档"对照 */
export function LocalDetectPanel({
  detectIn,
  detectOut,
  showFeatures,
  onToggleFeatures,
}: {
  detectIn: DetectReport | null;
  detectOut: DetectReport | null;
  showFeatures: boolean;
  onToggleFeatures: () => void;
}) {
  return (
    <div className="bench">
      <div className="bench-head">
        本地 AI 检测（朱雀风格三档 · 离线启发式，非朱雀官方分）
        <button
          className="ghost sm"
          style={{ marginLeft: 10 }}
          onClick={onToggleFeatures}
        >
          {showFeatures ? "收起特征" : "看特征明细"}
        </button>
      </div>

      <div className="scores" style={{ marginBottom: 4 }}>
        {detectIn && <LevelBadge label="原文" rep={detectIn} />}
        {detectOut && <LevelBadge label="去味稿" rep={detectOut} />}
        {detectIn && detectOut && (
          <div className="delta">
            <div className="delta-label">降幅</div>
            <div
              className="delta-value"
              style={{ color: detectOut.probability <= detectIn.probability ? "#3ddc97" : "#ff5d6c" }}
            >
              {detectIn.probability - detectOut.probability > 0 ? "−" : "+"}
              {Math.abs(detectIn.probability - detectOut.probability)}
            </div>
          </div>
        )}
      </div>

      {detectOut?.warnings.map((w, k) => (
        <div className="bench-row" key={"w" + k} style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "#ffb454", fontSize: 12 }}>· {w}</span>
        </div>
      ))}

      {/* 风险最高的几句：让用户看见"到底哪几句露馅" */}
      {detectOut && detectOut.topSegments.length > 0 && (
        <>
          <div className="bench-row" style={{ justifyContent: "flex-start" }}>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>风险最高的句子（去味稿）：</span>
          </div>
          <div className="diff-box" style={{ maxHeight: 200 }}>
            {detectOut.topSegments.map((s, i) => {
              const c = s.risk >= 65 ? "#ff5d6c" : s.risk >= 45 ? "#ffb454" : "#8a98b5";
              return (
                <div key={i} style={{ marginBottom: 6 }}>
                  <span style={{ color: c, fontSize: 12, marginRight: 6 }}>[{s.risk}]</span>
                  <span>{s.text}</span>
                  <span style={{ color: "var(--muted)", fontSize: 11, marginLeft: 6 }}>（{s.reason}）</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {showFeatures && detectOut && (
        <>
          <div className="bench-row" style={{ justifyContent: "flex-start" }}>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>14 维特征（条越长越像 AI）：</span>
          </div>
          {detectOut.features.map((f, i) => (
            <div className="bench-row" key={i} style={{ gap: 8 }}>
              <span style={{ fontSize: 12, minWidth: 130, color: f.value > 0.55 ? "#ff5d6c" : "var(--muted)" }}>
                {f.name}
              </span>
              <span
                style={{
                  flex: 1,
                  height: 6,
                  background: "rgba(120,160,255,0.12)",
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: `${Math.round(f.value * 100)}%`,
                    height: "100%",
                    background: f.value > 0.55 ? "#ff5d6c" : f.value > 0.3 ? "#ffb454" : "#3ddc97",
                  }}
                />
              </span>
              <span style={{ fontSize: 11, color: "var(--muted)", minWidth: 200 }}>{f.hint}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
