import { type ReactNode } from "react";
import {
  fuseLayers,
  LABEL_TEXT,
  ZHUQUE_URL,
  DEFAULT_SEMANTIC_WEIGHT,
  PPL_FUSE_WEIGHT,
  type ZhuqueReport,
  type ZhuqueSpan,
  type Calibration,
  type FusedResult,
  type SemanticLayer,
} from "../engine/zhuque";
import { parseOfficialResult } from "../api/zhuque";

const ZQ_COLOR = { ai: "#ff5d6c", suspected: "#ffb454", human: "#3ddc97" };
const ZQ_MARK = { ai: "🔴", suspected: "🟡", human: "🟢" };

/** 按标注片段把正文切成「普通文本 + 高亮片段」渲染（朱雀官方的红/黄段落标注形态） */
function ZhuqueHighlight({ text, spans }: { text: string; spans: ZhuqueSpan[] }) {
  const nodes: ReactNode[] = [];
  let pos = 0;
  spans.forEach((s, i) => {
    if (s.start > pos) nodes.push(<span key={"p" + i}>{text.slice(pos, s.start)}</span>);
    nodes.push(
      <mark
        key={"m" + i}
        className={s.label === "ai" ? "zq-ai" : "zq-sus"}
        title={`${LABEL_TEXT[s.label]} · 风险 ${s.risk} · ${s.reasons.join("、")}`}
      >
        {text.slice(s.start, s.end)}
      </mark>,
    );
    pos = s.end;
  });
  if (pos < text.length) nodes.push(<span key="tail">{text.slice(pos)}</span>);
  return <div className="zq-text">{nodes}</div>;
}

export function ZhuquePanel({
  text,
  rep,
  calib,
  paste,
  msg,
  showFeatures,
  sem,
  semLoading,
  weight,
  canRunSemantic,
  genreEstimate,
  onPaste,
  onSaveCalib,
  onClearCalib,
  onCopySubmit,
  onOpenOfficial,
  onOpenLab,
  onToggleFeatures,
  onRunSemantic,
  onWeight,
}: {
  text: string;
  rep: ZhuqueReport;
  calib: Calibration;
  paste: string;
  msg: string;
  showFeatures: boolean;
  sem: SemanticLayer | null;
  semLoading: boolean;
  weight: number;
  canRunSemantic: boolean;
  /** v3 四体裁 18 点 OLS 体裁线预测（与对标评分面板同一把尺子；无文本时 null） */
  genreEstimate?: { pct: number; tag: string } | null;
  onPaste: (v: string) => void;
  /** v0.8.6 LLM 主导：记录口径跟随当前展示口径——有语义层时传融合分，否则传表层综合分 */
  onSaveCalib: () => void;
  onClearCalib: () => void;
  onCopySubmit: () => void;
  onOpenOfficial: () => void;
  onOpenLab: () => void;
  onToggleFeatures: () => void;
  onRunSemantic: () => void;
  onWeight: (v: number) => void;
}) {
  const r = rep.ratios;
  const parsed = paste.trim() ? parseOfficialResult(paste) : null;
  // 双层融合：表层（本地启发式）× 语义层（LLM 检测员）
  const fused: FusedResult | null = fuseLayers(rep.composite, sem, weight);
  const top = fused ?? {
    composite: rep.composite,
    label: rep.label,
    labelText: rep.labelText,
    verdict: rep.verdict,
    confidence: rep.confidence,
  };
  return (
    <div className="bench">
      <div className="bench-head">
        朱雀检测（本地近似 · 非官方实现）
        <button className="ghost sm" style={{ marginLeft: 10 }} onClick={onToggleFeatures}>
          {showFeatures ? "收起特征" : "看 12 维特征"}
        </button>
      </div>

      <div className="zq-head">
        <div className="zq-main">
          <div className="zq-big" style={{ color: ZQ_COLOR[top.label] }}>
            {fused ? fused.composite.toFixed(2) : rep.probability.toFixed(2)}%
          </div>
          <div className="zq-sub">
            {ZQ_MARK[top.label]} <b style={{ color: ZQ_COLOR[top.label] }}>{top.labelText}</b>
            <span style={{ color: "var(--muted)", marginLeft: 8 }}>{top.verdict}</span>
          </div>
          <div className="zq-sub" style={{ marginTop: 4 }}>
            {fused ? (
              <>
                融合 AI 度 {fused.composite}%（表层 {rep.composite} ×{" "}
                {Math.round((1 - weight) * 100)}% + 语义 {sem?.score} × {Math.round(weight * 100)}
                %） · 置信 {fused.confidence}%
              </>
            ) : (
              <>
                AI 特征占比 {rep.probability}% · 综合 {rep.composite}% · 置信 {rep.confidence}%
              </>
            )}
            {rep.officialEstimate !== null && (
              <>
                {" "}
                · 校准后估官方分 <b>{rep.officialEstimate}%</b>
              </>
            )}
          </div>
          <div className="zq-sub">
            {rep.stats.chars} 字 / {rep.stats.sentences} 句 · 命中 {rep.stats.aiSentences} 句 AI
            特征
          </div>
          {fused && fused.divergence >= 30 && (
            <div className="zq-sub" style={{ color: "#ffb454" }}>
              两层分歧 {fused.divergence} 分（表层 {rep.composite} vs 语义 {sem?.score}
              ）——分歧越大越不可信， 建议以官方送检为准
            </div>
          )}
        </div>

        <div className="zq-bar">
          <span
            style={{ width: `${r.human}%`, background: ZQ_COLOR.human }}
            title={`人工特征 ${r.human}%`}
          />
          <span
            style={{ width: `${r.suspected}%`, background: ZQ_COLOR.suspected }}
            title={`疑似AI ${r.suspected}%`}
          />
          <span style={{ width: `${r.ai}%`, background: ZQ_COLOR.ai }} title={`AI特征 ${r.ai}%`} />
        </div>
      </div>

      <div className="bench-row" style={{ gap: 16 }}>
        <span style={{ color: ZQ_COLOR.human, fontSize: 12 }}>🟢 人工特征 {r.human}%</span>
        <span style={{ color: ZQ_COLOR.suspected, fontSize: 12 }}>🟡 疑似AI {r.suspected}%</span>
        <span style={{ color: ZQ_COLOR.ai, fontSize: 12 }}>🔴 AI特征 {r.ai}%</span>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          官方口径：AI 特征占比 &gt;60% 高风险，&lt;20~30% 相对安全
        </span>
      </div>

      {rep.warnings.map((w, k) => (
        <div className="bench-row" key={"w" + k} style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "#ffb454", fontSize: 12 }}>· {w}</span>
        </div>
      ))}

      {rep.pplLayer && (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            🧠 困惑度层已融合（权重 {Math.round(PPL_FUSE_WEIGHT * 100)}%）：{rep.pplLayer.note}
          </span>
        </div>
      )}

      {genreEstimate && (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            📐 体裁线预测（v3 18 点 OLS · 官方实测校准）：
            <b
              style={{
                color:
                  genreEstimate.pct >= 60
                    ? "#ff5d6c"
                    : genreEstimate.pct >= 30
                      ? "#ffb454"
                      : "#3ddc97",
              }}
            >
              {" "}
              {genreEstimate.pct}%
            </b>{" "}
            · {genreEstimate.tag}
          </span>
        </div>
      )}

      {rep.spans.length > 0 ? (
        <>
          <div className="bench-row" style={{ justifyContent: "flex-start" }}>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>
              标注 {rep.spans.length} 处（鼠标悬停看原因）：
            </span>
          </div>
          <ZhuqueHighlight text={text} spans={rep.spans} />
          <div className="zq-spans">
            {rep.topSpans.map((s, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <span style={{ color: ZQ_COLOR[s.label], fontSize: 12, marginRight: 6 }}>
                  [{s.risk}]
                </span>
                <span>{s.text.length > 60 ? s.text.slice(0, 60) + "…" : s.text}</span>
                <span style={{ color: "var(--muted)", fontSize: 11, marginLeft: 6 }}>
                  （{s.reasons.join("、")}）
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="bench-tip">未标出可疑片段，全篇落人工特征档。</div>
      )}

      {showFeatures && (
        <>
          <div className="bench-row" style={{ justifyContent: "flex-start" }}>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>
              12 维特征（条越长越像 AI）：
            </span>
          </div>
          {rep.features.map((f, i) => (
            <div className="bench-row" key={i} style={{ gap: 8 }}>
              <span
                style={{
                  fontSize: 12,
                  minWidth: 150,
                  color: f.value > 0.55 ? "#ff5d6c" : "var(--muted)",
                }}
              >
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
              <span style={{ fontSize: 11, color: "var(--muted)", minWidth: 210 }}>{f.hint}</span>
            </div>
          ))}
        </>
      )}

      <div className="modal-divider" style={{ marginTop: 14 }}>
        语义层（朱雀检测员 · 补本地盲区）
      </div>
      <div className="bench-tip">
        本地引擎只看得见词汇/句法/格式，而朱雀主要看语义与篇章（论点骨架、指代链、因果推进、
        段落节奏）。这一层用按官方实测抓法定制的「朱雀检测员」篇章层提示词让 LLM 补位——
        但不同模型评分会漂移（实测同一文本 20~80），所以只作为第二层证据参与加权，不单独定档。
      </div>
      <div className="bench-row">
        <button
          className="ghost sm"
          onClick={onRunSemantic}
          disabled={!canRunSemantic || semLoading}
          title={canRunSemantic ? "" : "需要启用 API 且已填 Key（设置里配置）"}
        >
          {semLoading ? "评判中…" : sem ? "重跑语义层" : "用 LLM 补语义层"}
        </button>
        {sem && (
          <>
            <span className="tag">语义层 {sem.score} 分</span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{sem.source}</span>
          </>
        )}
        {!canRunSemantic && (
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            未启用 API：语义层不可用，当前只有本地表层结果
          </span>
        )}
      </div>
      {sem && sem.critique.length > 0 && (
        <div className="bench-row" style={{ flexWrap: "wrap" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            语义/篇章层痕迹：{sem.critique.join("；")}
          </span>
        </div>
      )}
      <div className="bench-row" style={{ gap: 10 }}>
        <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
          语义层权重 <b style={{ color: "var(--accent)" }}>{Math.round(weight * 100)}%</b>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={weight}
          onChange={(e) => onWeight(parseFloat(e.target.value))}
          style={{ flex: 1, minWidth: 160, accentColor: "var(--accent)" }}
        />
        <span style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>
          默认 {Math.round(DEFAULT_SEMANTIC_WEIGHT * 100)}%（经验值，需用官方真值校准）
        </span>
      </div>

      <div className="modal-divider" style={{ marginTop: 14 }}>
        官方送检与校准
      </div>
      <div className="bench-tip">
        朱雀没有公开 API，官方结果只能走网页：{ZHUQUE_URL}（≥350 字，建议 ≤2000 字）。
        把官方回来的一行结果粘到下面，就能把本地分校准到官方分（存本机
        localStorage，样本越多越准）。
      </div>
      <div className="bench-row">
        <button className="ghost sm" onClick={onCopySubmit}>
          复制送检文本
        </button>
        <button className="ghost sm" onClick={onOpenOfficial}>
          打开朱雀官网
        </button>
        <button
          className="ghost sm"
          onClick={onOpenLab}
          title="批量生成样本、逐条回填官方结果、自动重拟映射与权重"
        >
          校准实验室（攒真值）
        </button>
        <input
          value={paste}
          onChange={(e) => onPaste(e.target.value)}
          placeholder="粘贴官方结果，如「AI生成 99.99%」"
          style={{
            flex: 1,
            minWidth: 220,
            background: "rgba(8,12,22,0.7)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "7px 10px",
            fontSize: 12,
          }}
        />
        <button className="primary sm" onClick={onSaveCalib} disabled={!parsed?.ok}>
          记为校准点
        </button>
        <button className="ghost sm" onClick={onClearCalib} disabled={calib.n === 0}>
          清空校准（{calib.n}）
        </button>
      </div>
      {parsed && (
        <div className="bench-tip" style={{ color: parsed.ok ? "var(--accent2)" : "#ffb454" }}>
          {parsed.ok
            ? `解析成功：${parsed.labelText} ${parsed.probability}% —— 将按「本地综合分 ${rep.composite} → 官方 ${parsed.probability}%」记录`
            : parsed.note}
        </div>
      )}
      <div className="bench-tip">
        当前映射：
        {calib.n === 0
          ? "未校准（本地分与官方分不是同一把尺子，误差可能很大）"
          : `官方分 ≈ ${calib.a} × 本地综合分 ${calib.b >= 0 ? "+" : "−"} ${Math.abs(calib.b)}（${calib.n} 个实测点，最小二乘拟合）`}
      </div>
      {msg && (
        <div className="bench-tip" style={{ color: "var(--accent)" }}>
          {msg}
        </div>
      )}
    </div>
  );
}
