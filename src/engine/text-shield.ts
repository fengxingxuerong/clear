/**
 * 结构化串（URL / 邮箱）的**区间表**——切句时用来跳过串内部的标点。
 *
 * ## 为什么不用占位符
 *
 * v0.9.24 ⑩ 曾用「U+E000~U+E00F 占位符 + 还原」修 URL 腰斩，实测有两个坑：
 *
 * 1. **槽位上限 16**：`String.fromCharCode(0xe000 + n)` 在第 17 个结构化串处溢出到
 *    U+E010，超出还原正则 `[\uE000-\uE00F]` ⇒ 该串**永久丢失**、原位留下私用区乱码。
 *    实测（`artifacts/_probe-shield-cap.ts`）：40 个 URL 只剩 16 个，24 个变乱码。
 * 2. **破坏原文偏移**：`zhuque.ts` 的切句要保留 `start/end` 供 UI 高亮，
 *    占位符把多字符压成 1 字符，偏移全乱。
 *
 * 区间表两个问题都没有：它**不改动原文本**，只告诉调用方「哪些下标在串内部」。
 *
 * ## 用法
 *
 * - 需要保留偏移的切句（`zhuque.ts`）：拿 `structuredSpans()` + `spanGuard()`，
 *   遇到切点时先问 `guard(idx)`。
 * - 不需要偏移的切句（`detector.ts` / `classify-genre.ts`）：同样用 guard，
 *   只跳过落在串内的切点，其余语义一字不动。
 *
 * ⚠️ 判据刻意**只覆盖 URL 与邮箱**：版本号、时间、数字里没有切句标点，
 * 纳入只会让判据变宽、误伤正常句子（v0.9.24 ⑩ 的教训）。
 */

/** 结构化串区间，左闭右开 `[start, end)`，按起点升序、互不重叠 */
export interface TextSpan {
  start: number;
  end: number;
}

/**
 * 与 v0.9.24 ⑩ 的屏蔽正则**逐字一致**——保持行为不变，只换掉承载方式。
 * - `(?:https?:\/\/|www\.)[!-~]+`：URL，`[!-~]` 是 ASCII 可打印区，遇空格/中文自然止步
 * - `[\w.+-]+@[\w.-]+\.\w+`：邮箱
 */
const STRUCTURED_RE = /(?:https?:\/\/|www\.)[!-~]+|[\w.+-]+@[\w.-]+\.\w+/g;

/** 文本里所有 URL / 邮箱的区间。无匹配时返回空数组（调用方可放心遍历）。 */
export function structuredSpans(text: string): TextSpan[] {
  if (!text) return [];
  const out: TextSpan[] = [];
  STRUCTURED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRUCTURED_RE.exec(text)) !== null) {
    // 零宽匹配防御：正则两段都要求 ≥1 字符，理论上不可能，但 exec 循环里
    // 一旦出现零宽就会死循环，所以显式推进一次
    if (m[0].length === 0) {
      STRUCTURED_RE.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * 造一个「下标是否落在结构化串内部」的判定器（二分，O(log n)）。
 *
 * 传 `null`/空数组时返回恒 false —— 让调用方不需要写分支。
 */
export function spanGuard(spans: TextSpan[] | null | undefined): (idx: number) => boolean {
  if (!spans || spans.length === 0) return () => false;
  const starts = spans.map((s) => s.start);
  return (idx: number): boolean => {
    // 找最后一个 start <= idx 的区间
    let lo = 0;
    let hi = spans.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= idx) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return false;
    return idx < spans[found].end;
  };
}

/** 一步到位：`structuredSpans(text)` + `spanGuard(...)` */
export function guardFor(text: string): (idx: number) => boolean {
  return spanGuard(structuredSpans(text));
}
