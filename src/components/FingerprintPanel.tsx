/**
 * 趣AI味 · 指纹体检报告面板：本地体检结论 + 忠实度问题列表
 */
import type { FingerprintReport } from "../engine/humanize";

interface FingerprintPanelProps {
  fingerprint: FingerprintReport | null;
  fidelity: { pass: boolean; problems: string[] } | null;
  /** 是否已有去味结果（决定体检对象文案） */
  checkingOutput: boolean;
}

export function FingerprintPanel({ fingerprint, fidelity, checkingOutput }: FingerprintPanelProps) {
  if (!fingerprint) return null;
  return (
<div className="bench">
  <div className="bench-head">
    指纹体检（本地，不联网）· {checkingOutput ? "检查去味结果" : "检查原文"}
    {fingerprint.pass
      ? ` — ✅ 未检出指纹，句长CV ${fingerprint.sentenceCV}${fingerprint.sentenceStd != null ? ` / 标准差 ${fingerprint.sentenceStd}` : ""}`
      : ` — ${fingerprint.issues.length} 项指纹`}
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
