/**
 * 趣AI味 · 流水线可观测聚合层
 *
 * 引擎侧只负责"每跑完一步喊一声"（humanize.ts 的 onStage 回调），
 * 这里负责把一堆零散事件整理成人能读的流水线：
 *
 *   事件流（逐段 × 逐步骤，几十到上百条）→ 按 id 归并 → 一屏看得完的阶段序列
 *
 * ⚠️ 设计红线：**只聚合，不加工**。
 *   - 不补任何"预计""置信度""命中率"这类估算数字；
 *   - 每个阶段展示的耗时/长度/快照都是引擎真实跑出来的；
 *   - 归并只做加法（耗时累加、段落快照拼接），不做平均与插值。
 *
 * 归并口径：
 *   耗时 ms      —— 各段累加（真实 CPU 时间总和，不是墙钟时间）
 *   字符 delta   —— 各段 (after − before) 累加。全文级阶段只跑一次，累加等价
 *   快照 snippet —— 只留前 MAX_SNIPPETS 段，够看清"这一步动了哪里"即可
 *   skipped      —— 只有**所有**段都跳过才标跳过（部分段跳过是体裁/内容差异，不该整条灰掉）
 */
import { humanize } from "./humanize.ts";
import type { HumanizeOptions, StageTrace } from "./humanize-primitives.ts";

/** 每个阶段最多保留几段快照：够定位问题，又不让 trace 体积随段落数线性膨胀 */
const MAX_SNIPPETS = 4;

/** 归并后的一个阶段 */
export interface PipelineStage {
  id: string;
  name: string;
  /** 这一步为什么存在 */
  why: string;
  /** 各段累计耗时（毫秒） */
  ms: number;
  /** 该阶段进入时的字符数（取首次事件） */
  charsBefore: number;
  /** 该阶段最后一次事件结束时的字符数 */
  charsAfter: number;
  /** 各段字符变化累加（正=变长，负=变短） */
  delta: number;
  /**
   * 相对**上一阶段结束**的字符变化。
   *
   * 为什么需要第二个 delta：收尾那一串全文级阶段的 charsBefore 都填的是原文长度
   * （它们拿不到"上一步的输出长度"，那是段落级合并后的结果），
   * 所以 delta 对它们都等于"相对原文的累计变化"，连着看不出每步改了多少。
   * 这个字段按流水线顺序做相邻差分，才是"这一步真正动了几字"。
   */
  deltaFromPrev: number;
  /** 跑过几次（多段文本 = 段落数，全文级 = 1） */
  runs: number;
  /** 全部跳过才为 true */
  skipped: boolean;
  /** 去重后的补充指标（每段一句） */
  metrics: string[];
  /** 各段输出快照 */
  snippets: { para?: number; text: string }[];
}

export interface PipelineTrace {
  stages: PipelineStage[];
  /** 各阶段耗时之和 */
  totalMs: number;
  inputChars: number;
  outputChars: number;
  /** 归并前的原始事件条数（= 段落数 × 段落级步骤数 + 全文级步骤数） */
  eventCount: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * 把引擎吐出的原始事件归并成流水线。
 * 单独导出是为了让聚合逻辑可以脱离 humanize 直接测（喂构造事件即可）。
 */
export function aggregateStages(
  events: readonly StageTrace[],
  inputChars: number,
  outputChars: number,
): PipelineTrace {
  const byId = new Map<string, PipelineStage>();
  const order: string[] = [];

  for (const e of events) {
    let st = byId.get(e.id);
    if (!st) {
      st = {
        id: e.id,
        name: e.name,
        why: e.why,
        ms: 0,
        charsBefore: e.charsBefore,
        charsAfter: e.charsAfter,
        delta: 0,
        deltaFromPrev: 0,
        runs: 0,
        skipped: true,
        metrics: [],
        snippets: [],
      };
      byId.set(e.id, st);
      order.push(e.id);
    }
    st.ms = round3(st.ms + e.ms);
    st.charsAfter = e.charsAfter;
    st.delta += e.charsAfter - e.charsBefore;
    st.runs += 1;
    // 只要有一段真跑了，整条阶段就不算跳过
    st.skipped = st.skipped && e.skipped === true;
    if (e.metric !== undefined && !st.metrics.includes(e.metric)) st.metrics.push(e.metric);
    if (st.snippets.length < MAX_SNIPPETS) {
      st.snippets.push(
        e.para === undefined ? { text: e.snippet } : { para: e.para, text: e.snippet },
      );
    }
  }

  const stages = order.map((id) => byId.get(id)!);
  let prevChars = inputChars;
  for (const s of stages) {
    s.deltaFromPrev = s.charsAfter - prevChars;
    prevChars = s.charsAfter;
  }
  return {
    stages,
    totalMs: round3(stages.reduce((s, x) => s + x.ms, 0)),
    inputChars,
    outputChars,
    eventCount: events.length,
  };
}

/**
 * 跑一次本地引擎，同时收集流水线 trace。
 *
 * 与直接调 humanize() 的输出**逐字相同**——onStage 是纯旁路，
 * 不参与 rng 序列、不改写任何中间结果（见 pipeline-trace.test.ts 的一致性用例）。
 */
export function runTracedHumanize(
  text: string,
  opts: Omit<HumanizeOptions, "onStage"> = {},
): { text: string; trace: PipelineTrace } {
  const events: StageTrace[] = [];
  const out = humanize(text, { ...opts, onStage: (s: StageTrace) => events.push(s) });
  return { text: out, trace: aggregateStages(events, text.length, out.length) };
}
