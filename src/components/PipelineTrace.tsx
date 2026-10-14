import { useState } from "react";
import type { PipelineTrace } from "../engine/pipeline-trace";

/**
 * 流水线追踪面板：把本地引擎这次真的跑过的每一步摊开给人看。
 *
 * 设计取舍：
 *  - 「为什么有这一步」默认展开 —— 这是逻辑透明的核心诉求，藏起来等于没做；
 *  - 「这一步之后的文本快照」默认收起 —— 27 个阶段全展开会把页面撑爆，
 *    但留一个「全部展开」开关给想逐字核验的人；
 *  - 所有数字直接来自引擎 trace，本组件不做任何再加工（不平均、不估算、不补文案）。
 */

/** 耗时：小于 10ms 给两位小数（步骤都很短，四舍五入到整数就全是 0 了） */
function fmtMs(ms: number): string {
  return ms >= 10 ? `${Math.round(ms)}ms` : `${ms.toFixed(2)}ms`;
}

function fmtDelta(n: number): string {
  if (n === 0) return "±0";
  return n > 0 ? `+${n}` : `${n}`;
}

/** Δ 的配色：变长=青（补了内容）、变短=琥珀（删了内容）、不变=灰 */
function deltaClass(n: number): string {
  if (n === 0) return "zero";
  return n > 0 ? "plus" : "minus";
}

export function PipelineTracePanel({
  trace,
  bestOfTried,
  llmPath,
}: {
  trace: PipelineTrace | null;
  /** 多候选择优跑了几个候选（该模式不产出逐步 trace，如实说明原因） */
  bestOfTried?: number;
  /** 这一稿走的是 LLM 路径：执行过程在远端，本地没有逐步记录 */
  llmPath?: boolean;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [expandAll, setExpandAll] = useState(false);

  if (!trace) return null;

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="pipe">
      <div className="pipe-head">
        <span className="pipe-title">◈ 流水线追踪 · 本地引擎执行过程</span>
        <span className="pipe-meta">
          {trace.stages.length} 阶段 · {trace.eventCount} 条事件 · <b>{fmtMs(trace.totalMs)}</b> ·{" "}
          {trace.inputChars} → {trace.outputChars} 字
        </span>
      </div>
      <p className="pipe-tip">
        下面是引擎这一次真的跑过的每一步：耗时、字符变化、以及这一步结束时的文本快照
        （点任意一行展开快照）。数据全部来自引擎实时记录，没有估算值。
        {bestOfTried !== undefined && (
          <>
            {" "}
            本次开了多候选择优（{bestOfTried} 个候选并行跑完整条流水线），
            逐个候选的痕迹会互相穿插，所以这里只记录最终入选那一条。
          </>
        )}
        {llmPath && " 这一稿由 LLM 产出，执行过程在远端，本地无法逐步记录。"}
      </p>
      <div className="pipe-head" style={{ marginBottom: 6 }}>
        <button className="ghost sm" onClick={() => setExpandAll((v) => !v)}>
          {expandAll ? "收起全部快照" : "展开全部快照"}
        </button>
        <span className="pipe-meta">灰掉的步骤 = 被门控跳过（体裁/强度/开关不满足）</span>
      </div>
      <ol className="pipe-list">
        {trace.stages.map((s, i) => {
          const show = expandAll || open.has(s.id);
          return (
            <li key={s.id} className={`pipe-item${s.skipped ? " skip" : ""}`}>
              <button
                className="pipe-row"
                onClick={() => toggle(s.id)}
                aria-expanded={show}
                title={show ? "收起这一步的文本快照" : "展开这一步的文本快照"}
              >
                <span className="pipe-idx">{String(i + 1).padStart(2, "0")}</span>
                <span className="pipe-name">{s.name}</span>
                <span className="pipe-nums">
                  <span className="ms">{fmtMs(s.ms)}</span>
                  <span className={deltaClass(s.deltaFromPrev)}>
                    {fmtDelta(s.deltaFromPrev)} 字
                  </span>
                  {s.runs > 1 && <span>×{s.runs} 段</span>}
                </span>
              </button>
              <p className="pipe-why">{s.why}</p>
              {s.metrics.map((m) => (
                <p className="pipe-metric" key={m}>
                  ▸ {m}
                </p>
              ))}
              {show && (
                <div className="pipe-snips">
                  {s.snippets.map((sn, k) => (
                    <p className="pipe-snip" key={k}>
                      {sn.para === undefined ? (
                        <span className="pipe-snip-tag">全文</span>
                      ) : (
                        <span className="pipe-snip-tag">第 {sn.para + 1} 段</span>
                      )}
                      {sn.text || "（空）"}
                    </p>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
