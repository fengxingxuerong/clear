/**
 * 主界面文案组装的纯函数层（自 App.tsx 抽出，行为逐字保留）。
 *
 * 抽出动机：handleHumanize 的结果文案是「引擎产出如实标注」回归防护的核心
 * （v0.9.15 修的"假话文案"），此前埋在 1033 行组件里无法单测；纯函数化后
 * 四种引擎产出分支 + 拼接规则可直接锁死。
 */
import type { ScoreBreakdown } from "./engine/humanize";

/** 朱雀网页版检测文本长度门槛：送检前给出提示，去味本身不受影响 */
export const ZHUQUE_MIN_CHARS = 350;

/** handleHumanize 结果对象里文案需要的最小形状（避免耦合完整 RunResult 类型） */
export interface HumanizeNoteResult {
  engine?: string;
  usedApi?: boolean;
  note?: string;
  bestOf?: { tried: number; rejected: number; seed: number } | null;
  roundScores?: number[];
}

export interface BuildHumanizeNoteArgs {
  r: HumanizeNoteResult;
  input: string;
  /** 本地 AI 检测对照：原文 */
  din: { levelText: string; probability: number };
  /** 本地 AI 检测对照：去味稿 */
  dout: { levelText: string; probability: number };
  /** 朱雀口径报告（只取占比与档位文案） */
  zr: { ratios: { ai: number }; labelText: string };
  /** 外部检测器自动送检追加段（含前导 " · "），无则不追加 */
  detectorNote?: string;
}

/**
 * 去味完成后的完整提示文案。按**真实产出引擎**出文案：旧写法只看 usedApi，
 * 于是「API 调用失败回退本地」时界面写的是「使用本地引擎去味」——用户明明
 * 付了调用，看到的是假话；长文分块混拼时 usedApi 仍是 true，更分不出这稿
 * 是谁写的。engine 字段驱动（v0.9.15）。
 */
export function buildHumanizeNote({
  r,
  input,
  din,
  dout,
  zr,
  detectorNote,
}: BuildHumanizeNoteArgs): string {
  let msg: string;
  if (r.engine === "llm") {
    msg = r.roundScores?.length ? "已使用 API 深度去味" : "已使用 API（LLM）去味";
  } else if (r.engine === "mixed") {
    msg = "⚠️ 本稿是 LLM + 本地引擎混拼（部分块 LLM 未产出，已本地补位）";
  } else if (r.engine === "passthrough") {
    msg = "文本过短，未做去味处理";
  } else {
    msg = r.usedApi
      ? "⚠️ 调用过 API 但最终仍由本地引擎产出"
      : "使用本地引擎去味（未走 LLM）";
  }
  if (r.note) msg += " · " + r.note;
  if (r.bestOf) {
    msg += ` · 多候选择优：${r.bestOf.tried} 稿中挑最优（淘汰 ${r.bestOf.rejected} 稿，中选种子 ${r.bestOf.seed}）`;
  }
  const visibleLen = input.replace(/\s/g, "").length;
  if (visibleLen < ZHUQUE_MIN_CHARS) {
    msg += ` · 提示：朱雀检测要求不少于 ${ZHUQUE_MIN_CHARS} 字（当前 ${visibleLen} 字），去味本身不受影响`;
  }
  msg += ` · 本地检测：${din.levelText}(${din.probability}%) → ${dout.levelText}(${dout.probability}%)`;
  msg += ` · 朱雀口径：AI特征占比 ${zr.ratios.ai}%（${zr.labelText}）`;
  if (detectorNote) msg += detectorNote;
  return msg;
}

/**
 * 草稿恢复提示（挂载时一次性 effect 用）。
 * 原实现内联在 App.tsx effect 里：刚.restore 的稿按距今时长分三档描述。
 */
export function formatRestoredNote(ts: number | undefined, inputLen: number): string {
  const mins = ts ? Math.max(0, Math.round((Date.now() - ts) / 60000)) : 0;
  const when = mins < 1 ? "刚刚" : mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`;
  return `已恢复${when}未完成的稿（${inputLen} 字）。点「清空」可丢弃。`;
}

export type { ScoreBreakdown };
