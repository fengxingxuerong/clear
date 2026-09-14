import type { HistoryEntry } from "../store-history";

interface HistoryPanelProps {
  entries: HistoryEntry[];
  onLoad: (entry: HistoryEntry) => void;
  onClear: () => void;
  onClose: () => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export function HistoryPanel({ entries, onLoad, onClear, onClose }: HistoryPanelProps) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal diff-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 600 }}
      >
        <div className="modal-head">
          <span>去味历史 · 最近 {entries.length} 条</span>
          <button onClick={onClose}>✕</button>
        </div>
        {entries.length === 0 ? (
          <p className="modal-tip">暂无历史记录。每次去味完成后自动保存。</p>
        ) : (
          <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
            {entries.map((e) => (
              <div
                key={e.id}
                className="bench-row"
                style={{
                  cursor: "pointer",
                  padding: "10px 12px",
                  margin: "6px 0",
                  background: "rgba(8,12,22,0.4)",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  flexWrap: "wrap",
                }}
                onClick={() => {
                  onLoad(e);
                  onClose();
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 2 }}>
                    {timeAgo(e.timestamp)} · 强度 {Math.round(e.intensity * 100)}% ·{" "}
                    {e.usedApi ? "API" : "本地引擎"}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: "var(--text)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {e.input.slice(0, 80)}…
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    <span style={{ color: "var(--muted)" }}>评分 </span>
                    <span style={{ color: e.beforeScore >= 60 ? "#ff5d6c" : "#ffb454" }}>
                      {e.beforeScore}
                    </span>
                    <span style={{ color: "var(--muted)" }}> → </span>
                    <span style={{ color: e.afterScore < 35 ? "#3ddc97" : "#ffb454" }}>
                      {e.afterScore}
                    </span>
                    <span style={{ color: "var(--muted)", marginLeft: 8 }}>
                      降 {e.beforeScore - e.afterScore} 分
                    </span>
                  </div>
                </div>
                <span style={{ fontSize: 18, color: "var(--accent)", marginLeft: 8 }}>→</span>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions" style={{ justifyContent: "space-between" }}>
          <button className="ghost sm" onClick={onClear} disabled={entries.length === 0}>
            清空历史
          </button>
          <button className="primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
