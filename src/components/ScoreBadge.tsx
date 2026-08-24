import type { ScoreBreakdown } from "../engine/humanize";

/** 本地代理分明细（与 aiScore 返回结构一致） */
export type Score = ScoreBreakdown;

function toneColor(score: number): string {
  return score >= 60 ? "#ff5d6c" : score >= 35 ? "#ffb454" : "#3ddc97";
}

export function ScoreBadge({
  label,
  s,
  tone,
}: {
  label: string;
  s: Score;
  tone: "before" | "after";
}) {
  return (
    <div className={`score-badge ${tone}`}>
      <div className="score-label">{label}</div>
      <div className="score-value" style={{ color: toneColor(s.score) }}>
        {s.score}
      </div>
      <div className="score-sub">
        套话 {s.formulaicHits} · 跳脱 {s.burstiness} · 均长 {s.avgLen}
      </div>
    </div>
  );
}
