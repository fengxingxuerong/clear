import { useMemo } from "react";
import { diffInline, diffStats, DiffPart } from "../engine/diff";

interface DiffViewProps {
  before: string;
  after: string;
  onClose: () => void;
}

function Column({ title, parts }: { title: string; parts: DiffPart[] }) {
  return (
    <div className="diff-col">
      <div className="diff-col-head">{title}</div>
      <div className="diff-col-body">
        {parts.map((p, i) => (
          <span key={i} className={`diff-${p.type}`}>
            {p.text}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 去味前后对比视图：只把真正改动的那几个字画红/标绿，句子其余部分保持原样 */
export function DiffView({ before, after, onClose }: DiffViewProps) {
  const { left, right } = useMemo(() => diffInline(before, after), [before, after]);
  const stat = useMemo(() => diffStats(before, after), [before, after]);
  const spots = left.filter((p) => p.type === "del").length;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>
            去味前后对比 ·{" "}
            {stat.removed + stat.added > 0
              ? `改动了 ${spots} 处 · ${stat.removed + stat.added}/${stat.total} 字（${stat.ratio}%）`
              : "无改动"}
          </span>
          <button onClick={onClose}>✕</button>
        </div>
        <p className="modal-tip">
          只有底色标注的部分是实际改动的字，其余为原样保留；整句被替换或删除时才会整句标色。
          数字与专名经忠实度校验，不会丢失。
        </p>
        <div className="diff-grid">
          <Column title="原文（AI 稿）" parts={left} />
          <Column title="去味后" parts={right} />
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
