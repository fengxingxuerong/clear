import { explainSummary, type ExplainItem } from "../engine/explain";

/** 类别的人话标签（不改引擎里 ExplainKind 的英文键：那是规则表层面的名字） */
const KIND_LABEL: Record<string, string> = {
  cliche: "套话改写",
  vocab: "词表替换",
  connector: "连接词",
  pad: "垫词",
  formulaic: "公式化表达",
  trim: "删冗余",
  inject: "口语注入",
  structure: "结构重写",
  other: "未归类",
};

function arrowOf(it: ExplainItem): string {
  if (it.before && it.after) return `${it.before} → ${it.after}`;
  return it.before ? `删「${it.before}」` : `增「${it.after}」`;
}

/**
 * 「为什么这么改」面板。
 *
 * ⚠️ 头部那行免责不是客气话：清单是**事后比对**（原文 vs 去味稿的句级 diff 再反查规则表），
 * 引擎自己没有 trace。所以每条都标确定/推断 —— 推断类（trim/inject/structure/other）
 * 只看得出"形态像"，面板里必须让用户看得见这个区别。
 */
export function ExplainPanel({ items, onClose }: { items: ExplainItem[]; onClose: () => void }) {
  const summary = explainSummary(items);
  const kinds = Object.keys(summary);
  const certainCount = items.filter((i) => i.certain).length;
  const guessCount = items.length - certainCount;

  return (
    <div className="bench">
      <div className="bench-head">
        为什么这么改（句级 diff 反查规则表 · 事后归因，不是引擎自述）
        <button className="ghost sm" style={{ marginLeft: 10 }} onClick={onClose}>
          收起
        </button>
      </div>

      {items.length === 0 ? (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>（两稿一致，没有改动）</span>
        </div>
      ) : (
        <>
          <div className="bench-row" style={{ justifyContent: "flex-start" }}>
            <span style={{ fontSize: 12 }}>
              确定归因 <b style={{ color: "#3ddc97" }}>{certainCount}</b> 处
              {kinds.length > 0 &&
                `（${kinds.map((k) => `${KIND_LABEL[k] ?? k}×${summary[k]}`).join("、")}）`}
              {" · 推断 "}
              <b style={{ color: "#ffb454" }}>{guessCount}</b> 处
            </span>
          </div>

          <div className="diff-box" style={{ maxHeight: 300 }}>
            {items.map((it, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div>
                  <span
                    style={{
                      fontSize: 11,
                      marginRight: 6,
                      padding: "0 5px",
                      borderRadius: 3,
                      border: `1px solid ${it.certain ? "rgba(61,220,151,0.5)" : "rgba(255,180,84,0.5)"}`,
                      color: it.certain ? "#3ddc97" : "#ffb454",
                    }}
                  >
                    {it.certain ? (KIND_LABEL[it.kind] ?? it.kind) : "推断"}
                  </span>
                  <span>{arrowOf(it)}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                  {it.reason}｜依据：{it.basis}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
