import { type ReviewReport } from "../engine/review";

/**
 * 审题面板（detector-only）——**只读**。它不持有任何改写能力，也不碰 input/output，
 * 存在的意义是让人先看清「哪几句露馅、为什么」，再决定要不要点「去味」。
 *
 * 起因（2026-10-17 开源同类对标）：`petergyang/no-ai-slop`（12.4k★）的 detect 模式
 * 是它三模式之一；本仓库此前只有「改完才知道改了什么」（ExplainPanel），缺这一步。
 */
export function ReviewPanel({
  report,
  onClose,
  onRun,
}: {
  report: ReviewReport;
  onClose: () => void;
  /** 给一个直接进主流程的出口：看到问题后最常见的动作就是去味 */
  onRun: () => void;
}) {
  const sevColor = (risk: number) => (risk >= 60 ? "#ff5d6c" : risk >= 45 ? "#ffb454" : "#8a98b5");

  return (
    <div className="bench">
      <div className="bench-head">
        AI 味痕迹地图（只读 · 不改稿）
        <button className="ghost sm" style={{ marginLeft: 10 }} onClick={onClose}>
          收起
        </button>
      </div>

      <div className="bench-row">
        <span>
          代理分 <b style={{ color: sevColor(report.probability) }}>{report.probability}</b> / 100 ·{" "}
          {report.levelText}
        </span>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          共 {report.total} 句，达到痕迹门槛 {report.marked} 句
        </span>
      </div>
      <div className="bench-row" style={{ justifyContent: "flex-start" }}>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>
          本地启发式代理分，不是任何检测器的官方分——只有同一篇的前后对比有意义
        </span>
      </div>

      {report.summary.length > 0 && (
        <div className="bench-row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>痕迹分布：</span>
          {report.summary.map(([k, v], i) => (
            <span
              key={i}
              style={{
                fontSize: 11,
                color: "var(--muted)",
                border: "1px solid rgba(120,160,255,0.25)",
                borderRadius: 10,
                padding: "1px 8px",
              }}
            >
              {k} ×{v}
            </span>
          ))}
        </div>
      )}

      {report.marks.length === 0 ? (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ fontSize: 12, color: "#3ddc97" }}>
            没有句子达到痕迹门槛——不代表一定像人写，只代表本地判据没抓到。
          </span>
        </div>
      ) : (
        <div className="diff-box" style={{ maxHeight: 320 }}>
          {report.marks.map((m) => (
            <div key={m.index} style={{ marginBottom: 10 }}>
              <div>
                <span style={{ color: sevColor(m.risk), fontSize: 12, marginRight: 6 }}>
                  第{m.index}句 · {m.risk} · {m.severityText}
                </span>
              </div>
              <div style={{ fontSize: 13 }}>{m.sentence}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                命中：{m.reasons.join(" / ")}
              </div>
              {m.suggestions.map((s, k) => (
                <div key={k} style={{ fontSize: 11, color: "#8a98b5" }}>
                  → {s}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {report.warnings.map((w, k) => (
        <div className="bench-row" key={"w" + k} style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "#ffb454", fontSize: 11 }}>· {w}</span>
        </div>
      ))}

      <div className="bench-row">
        <button className="primary sm" onClick={onRun}>
          去味
        </button>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>
          先看清问题在哪，再决定改不改；点了才动你的稿
        </span>
      </div>
    </div>
  );
}
