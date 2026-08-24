/**
 * 去味历史记录（localStorage 持久化，最多 10 条）
 * 每次去味完成后自动保存，支持回看、一键复用
 */
import type { ScoreBreakdown } from "./engine/humanize";

export interface HistoryEntry {
  id: string;
  input: string;
  output: string;
  beforeScore: number;
  afterScore: number;
  intensity: number;
  usedApi: boolean;
  timestamp: number;
}

const K = "aihumanizer.history";
const MAX = 10;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(K);
    if (!raw) return [];
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.slice(0, MAX);
  } catch {
    return [];
  }
}

/** 单条历史含完整 input/output 全文，长文可能撑爆 localStorage 配额：
 *  写入失败时从最旧条目开始逐条丢弃重试，全丢仍失败则静默放弃（不影响去味主流程）。 */
export function saveHistory(entry: HistoryEntry): void {
  const list = loadHistory();
  // 去重：相同 input 的旧条目替换
  const idx = list.findIndex((e) => e.id === entry.id);
  if (idx >= 0) list.splice(idx, 1);
  list.unshift(entry);
  let keep = list.slice(0, MAX);
  for (;;) {
    try {
      localStorage.setItem(K, JSON.stringify(keep));
      return;
    } catch {
      if (!keep.length) return; // 只剩本条也写不下：放弃持久化
      keep = keep.slice(0, Math.max(1, keep.length - 1));
    }
  }
}

export function clearHistory(): void {
  localStorage.removeItem(K);
}

/** 从去味结果生成历史条目 */
export function makeHistoryEntry(
  input: string,
  output: string,
  before: ScoreBreakdown,
  after: ScoreBreakdown,
  intensity: number,
  usedApi: boolean,
): HistoryEntry {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    input,
    output,
    beforeScore: before.score,
    afterScore: after.score,
    intensity,
    usedApi,
    timestamp: Date.now(),
  };
}