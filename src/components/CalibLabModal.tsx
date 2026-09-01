import { labStats, type CalibSample } from "../api/calib-lab";

export function CalibLabModal({
  samples,
  text,
  msg,
  pasteMap,
  onText,
  onPaste,
  onClose,
  onGenerate,
  onFill,
  onCopy,
  onDelete,
  onClear,
  onApplyWeight,
  onSeed,
}: {
  samples: CalibSample[];
  text: string;
  msg: string;
  pasteMap: Record<string, string>;
  onText: (v: string) => void;
  onPaste: (id: string, v: string) => void;
  onClose: () => void;
  onGenerate: () => void;
  onFill: (id: string, input: string) => void;
  onCopy: (text: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onApplyWeight: (w: number) => void;
  onSeed: () => void;
}) {
  const st = labStats();
  const cal = st.calibration;
  const ordered = [...samples].reverse(); // 新样本在上

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720, width: "92%" }}>
        <div className="modal-head">
          <span>校准实验室 · 攒真值（官方每日约 20 次配额）</span>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="bench-row" style={{ gap: 14, flexWrap: "wrap" }}>
          <span className="tag">样本 {st.total}</span>
          <span className="tag">已回填 {st.filled}</span>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{st.progress}</span>
          <button
            className="ghost sm"
            style={{ marginLeft: "auto" }}
            onClick={onSeed}
            title="预置样本D两点的朱雀官方实测真值（2026-08-30 游客模式）：99.99% / 98.47%，surface 按当前引擎现场重算"
          >
            预置真值锚点（样本D ×2）
          </button>
        </div>
        <div className="bench-tip">
          映射：{st.calibration.n === 0
            ? "未拟合（≥1 条回填后出现，≥2 条起做最小二乘）"
            : `官方分 ≈ ${cal.a} × 本地综合分 ${cal.b >= 0 ? "+" : "−"} ${Math.abs(cal.b)}（${cal.n} 点）`}
          {st.holdoutMAE !== null && (
            <> · 留出验证 MAE <b>{st.holdoutMAE}</b> 分（{st.holdoutN} 条留出，越小越可信）</>
          )}
          {st.bestWeight !== null && (
            <>
              {" "}· 推荐语义层权重 <b>{Math.round(st.bestWeight * 100)}%</b>
              <button className="ghost sm" style={{ marginLeft: 8 }} onClick={() => onApplyWeight(st.bestWeight as number)}>
                应用为默认
              </button>
            </>
          )}
        </div>

        <div className="modal-divider">① 生成样本（贴一篇 ≥350 字的原文）</div>
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="贴一篇 AI 写的原文……（生成 4 条样本：原文 + 本地引擎强度 0.3/0.6/0.9）"
          style={{
            width: "100%", minHeight: 64, background: "rgba(8,12,22,0.7)", color: "var(--text)",
            border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px",
            fontFamily: "inherit", fontSize: 12, boxSizing: "border-box",
          }}
        />
        <div className="bench-row">
          <button className="primary sm" onClick={onGenerate} disabled={!text.trim()}>
            生成本批样本（4 条）
          </button>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            官方单次 ≤2000 字：超长的样本复制时会按句子边界截断
          </span>
        </div>

        <div className="modal-divider">② 送检 → ③ 逐条回填官方结果</div>
        {ordered.length === 0 && (
          <div className="bench-tip">还没有样本。上面贴一篇原文点「生成本批样本」。</div>
        )}
        {ordered.map((s) => (
          <div key={s.id} className="bench-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, minWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {s.name}
            </span>
            <span className="tag">本地 {s.surface}</span>
            {s.official !== null ? (
              <span className="tag" style={{ color: "var(--accent2)", borderColor: "rgba(61,220,151,0.5)" }}>
                官方 {s.official}%（{s.officialLabel === "ai" ? "AI生成" : s.officialLabel === "suspected" ? "疑似AI辅助" : "人工特征"}）
              </span>
            ) : (
              <input
                value={pasteMap[s.id] ?? ""}
                placeholder="粘贴官方结果，如「AI生成 99.99%」"
                onChange={(e) => onPaste(s.id, e.target.value)}
                style={{
                  flex: 1, minWidth: 180, background: "rgba(8,12,22,0.7)", color: "var(--text)",
                  border: "1px solid var(--border)", borderRadius: 8, padding: "5px 8px", fontSize: 12,
                }}
              />
            )}
            <button className="ghost sm" onClick={() => onCopy(s.text)}>复制</button>
            {s.official === null && (
              <button
                className="primary sm"
                onClick={() => {
                  const v = pasteMap[s.id];
                  if (v && v.trim()) onFill(s.id, v);
                }}
              >
                记录
              </button>
            )}
            <button className="ghost sm" onClick={() => onDelete(s.id)}>删</button>
          </div>
        ))}

        {msg && <div className="bench-tip" style={{ color: "var(--accent)" }}>{msg}</div>}

        <div className="modal-actions">
          <button className="ghost sm" onClick={onClear}>清空样本库</button>
          <button className="primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}
