/**
 * 趣AI味 · 指纹体检报告面板：本地体检结论 + 忠实度问题列表 + 困惑度特征（第 8 项）
 */
import type { FingerprintReport } from "../engine/humanize";
import type { PplFeature } from "../ppl/scorer-core";

export type PplIssueLite = { name: string; count: number; hint: string };
export type PplState =
  | "idle"
  | "need-download"
  | "downloading"
  | "loading"
  | "done"
  | "error"
  | "unsupported";

interface FingerprintPanelProps {
  fingerprint: FingerprintReport | null;
  fidelity: { pass: boolean; problems: string[] } | null;
  /** 是否已有去味结果（决定体检对象文案） */
  checkingOutput: boolean;
  pplEnabled: boolean;
  pplState: PplState;
  pplFeature: PplFeature | null;
  pplIssues: PplIssueLite[] | null;
  pplProgress: number | null;
  pplNote: string | null;
  onDownloadPpl: () => void;
}

export function FingerprintPanel({
  fingerprint,
  fidelity,
  checkingOutput,
  pplEnabled,
  pplState,
  pplFeature,
  pplIssues,
  pplProgress,
  pplNote,
  onDownloadPpl,
}: FingerprintPanelProps) {
  if (!fingerprint) return null;
  const pplSummary =
    pplState === "done" && pplFeature
      ? "（字均NLL " +
        pplFeature.meanNll.toFixed(2) +
        " nat · 窗间σ " +
        pplFeature.winStd.toFixed(2) +
        "）"
      : "";
  return (
<div className="bench">
  <div className="bench-head">
    指纹体检（本地，不联网）· {checkingOutput ? "检查去味结果" : "检查原文"}
    {fingerprint.pass
      ? " — ✅ 未检出指纹，句长CV " +
        fingerprint.sentenceCV +
        (fingerprint.sentenceStd != null ? " / 标准差 " + fingerprint.sentenceStd : "")
      : " — " + fingerprint.issues.length + " 项指纹"}
  </div>
  {!fingerprint.pass &&
    fingerprint.issues.map((i, k) => (
      <div className="bench-row" key={k} style={{ justifyContent: "flex-start" }}>
        <span style={{ color: "#ff5d6c", fontSize: 13 }}>
          · {i.name} ×{i.count}
        </span>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{i.hint}</span>
      </div>
    ))}
  {pplEnabled && (
    <>
      {pplState === "need-download" && (
        <div className="bench-row" style={{ justifyContent: "flex-start", gap: 10 }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            · 困惑度检查（第 8 项）需本地小模型
          </span>
          <button className="ghost sm" onClick={onDownloadPpl}>
            下载模型（约 100MB，仅一次，之后离线）
          </button>
        </div>
      )}
      {pplState === "downloading" && (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            · 正在下载模型 {pplProgress != null ? Math.round(pplProgress) : 0}%（仅此一次）
          </span>
        </div>
      )}
      {pplState === "loading" && (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            · 困惑度分析中…（本地推理，约几秒）
          </span>
        </div>
      )}
      {(pplState === "done" || pplState === "error") && pplIssues && pplIssues.length > 0 &&
        pplIssues.map((i, k) => (
          <div className="bench-row" key={"p" + k} style={{ justifyContent: "flex-start" }}>
            <span style={{ color: "#ff5d6c", fontSize: 13 }}>· {i.name}</span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{i.hint}</span>
          </div>
        ))}
      {pplState === "done" && pplIssues && pplIssues.length === 0 && (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "#3ddc97", fontSize: 13 }}>· 困惑度特征正常{pplSummary}</span>
        </div>
      )}
      {pplState === "error" && (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            · 困惑度检查本次不可用（模型加载或推理失败），以上仅前 7 项结果
          </span>
        </div>
      )}
      {pplState === "unsupported" && (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            · 当前环境不支持困惑度检查
          </span>
        </div>
      )}
      {pplNote && (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>{pplNote}</span>
        </div>
      )}
    </>
  )}
  {fidelity &&
    !fidelity.pass &&
    fidelity.problems.map((p, k) => (
      <div className="bench-row" key={"f" + k} style={{ justifyContent: "flex-start" }}>
        <span style={{ color: "#ff5d6c", fontSize: 13 }}>· 忠实度：{p}</span>
      </div>
    ))}
</div>
  );
}
