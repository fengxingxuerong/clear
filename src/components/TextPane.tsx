import { memo, KeyboardEvent } from "react";

interface TextPaneProps {
  label: string;
  value: string;
  placeholder: string;
  /** 输入变化（传 setState 本身即可，引用天然稳定） */
  onChange: (v: string) => void;
  /** 快捷键动作（如 Ctrl+Enter）；引用需稳定，否则 memo 失效 */
  onHotkey?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** 输入面板：受控 textarea + 字数统计。memo 化——value 未变的面板在另一侧
 *  输入时跳过重渲染（引用稳定的 props 才能生效）。 */
export const TextPane = memo(function TextPane({
  label,
  value,
  placeholder,
  onChange,
  onHotkey,
}: TextPaneProps) {
  return (
    <section className="pane">
      <div className="pane-head">
        <span>{label}</span>
        <span className="count">{value.length} 字</span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onHotkey}
        placeholder={placeholder}
      />
    </section>
  );
});
