import { useMemo } from "react";
import { diffSentences, DiffPart } from "../engine/diff";

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

/** 去味前后对比视图：左侧「原文」红色划除被改的句子，右侧「去味后」绿色标出新增句子 */
export function DiffView({ before, after, onClose }: DiffViewProps) {
  const { left, right } = useMemo(() => diffSentences(before, after), [before, after]);
  const unchanged = left.filter((p) => p.type === "same").length;
  const changed = left.length - unchanged;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>去味前后对比 · {changed > 0 ? `改动了 ${changed} 处` : "无改动"}</span>
          <button onClick={onClose}>✕</button>
        </div>
        <p className="modal-tip">
          左栏红色删除线 = 被替换/删除的句子，右栏绿色 =
          改写后的句子。数字与专名经忠实度校验，不会丢失。
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
