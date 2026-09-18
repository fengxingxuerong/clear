/**
 * 分句粒度 Diff：将原文与改写稿按句切分，LCS 求保留/删除/新增块，
 * 给出双栏可读的 diff 视图数据。零依赖，纯 JS。
 *
 * 复杂度：句子级 O(m×n)（m,n = 句数，通常 <200，安全）。
 */

export interface DiffPart {
  type: "same" | "del" | "ins";
  text: string;
}

/** 将文本切分为"句+标点"单元（保留分隔符，边界干净） */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const parts = text.split(/([。！？!?\n]+)/);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].trim();
    if (!seg) continue;
    if (/^[。！？!?\n]+$/.test(seg)) {
      if (tokens.length) tokens[tokens.length - 1] += seg;
      else tokens.push(seg);
    } else {
      tokens.push(seg);
    }
  }
  return tokens.filter((t) => t.trim().length > 0);
}

/** 完整 DP 表 + 回溯，返回分别落在 LCS 中的两序列索引集合 */
function lcsMaps(a: string[], b: string[]): { la: Set<number>; lb: Set<number> } {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // 回溯
  const la = new Set<number>();
  const lb = new Set<number>();
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      la.add(i - 1);
      lb.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return { la, lb };
}

/** 对双方做 LCS 分句 diff，生成左右两栏对齐的 DiffPart 数组 */
export function diffSentences(
  before: string,
  after: string,
): { left: DiffPart[]; right: DiffPart[] } {
  const a = tokenize(before);
  const b = tokenize(after);
  const { la, lb } = lcsMaps(a, b);

  const left: DiffPart[] = a.map((text, idx) => ({ type: la.has(idx) ? "same" : "del", text }));
  const right: DiffPart[] = b.map((text, idx) => ({ type: lb.has(idx) ? "same" : "ins", text }));
  return { left, right };
}

/** 句子内前后缀裁切：把变更的中间段单独标出，便于行内高亮 */
export function trimCommon(
  full: string,
  changed: string,
): { pre: string; midOld: string; midNew: string; post: string } {
  let pre = "";
  let post = "";
  const minLen = Math.min(full.length, changed.length);
  let i = 0;
  while (i < minLen && full[i] === changed[i]) {
    pre += full[i];
    i++;
  }
  let si = full.length - 1,
    sj = changed.length - 1;
  while (si >= i && sj >= i && full[si] === changed[sj]) {
    post = full[si] + post;
    si--;
    sj--;
  }
  return {
    pre,
    midOld: full.slice(i, si + 1),
    midNew: changed.slice(i, sj + 1),
    post,
  };
}

function pushIf(arr: DiffPart[], type: DiffPart["type"], text: string) {
  if (text) arr.push({ type, text });
}

/**
 * 字符级 LCS 上限：DP 表是 O(m×n)，单边 1500 字约 9MB / 225 万次比较，
 * 再往上就会卡住主线程；超限退回 trimCommon（只裁一段），宁可标注粗糙也不能冻界面。
 */
const CHAR_DIFF_MAX = 1500;

function coalesce(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.type === p.type) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/** 逐字符 LCS，返回两侧对齐的 same/del/ins 块——一句里有多处小改动时才能分开标出 */
function charParts(a: string, b: string): { left: DiffPart[]; right: DiffPart[] } {
  const m = a.length;
  const n = b.length;
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * w);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i * w + j] =
        a[i - 1] === b[j - 1] ? dp[(i - 1) * w + j - 1] + 1 : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1]);
    }
  }
  const revL: DiffPart[] = [];
  const revR: DiffPart[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      revL.push({ type: "same", text: a[i - 1] });
      revR.push({ type: "same", text: b[j - 1] });
      i--;
      j--;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) {
      revL.push({ type: "del", text: a[i - 1] });
      i--;
    } else {
      revR.push({ type: "ins", text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    revL.push({ type: "del", text: a[i - 1] });
    i--;
  }
  while (j > 0) {
    revR.push({ type: "ins", text: b[j - 1] });
    j--;
  }
  return { left: coalesce(revL.reverse()), right: coalesce(revR.reverse()) };
}

/**
 * 字符粒度 diff：在句级 LCS 之上，把成对出现的「删除段 / 新增段」再做一次逐字符 LCS，
 * 只把真正变化的字标成 del/ins。
 *
 * 为什么不在句子层直接收工：去味改写的常态是一句里只换两三个词（"值得注意的是"→"说白了"
 * 与"非常"→"挺"同处一句），整句划除会让用户以为内容被大段动过，反而看不出到底改了哪个字
 * ——而"改动率"要回答的恰恰是"这稿被动了多少"。
 */
export function diffInline(before: string, after: string): { left: DiffPart[]; right: DiffPart[] } {
  const { left: L, right: R } = diffSentences(before, after);
  const left: DiffPart[] = [];
  const right: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < L.length || j < R.length) {
    if (i < L.length && j < R.length && L[i].type === "same" && R[j].type === "same") {
      left.push(L[i]);
      right.push(R[j]);
      i++;
      j++;
      continue;
    }
    let di = i;
    while (di < L.length && L[di].type === "del") di++;
    let ij = j;
    while (ij < R.length && R[ij].type === "ins") ij++;
    const delText = L.slice(i, di).map((p) => p.text).join("");
    const insText = R.slice(j, ij).map((p) => p.text).join("");
    if (delText && insText) {
      if (delText.length <= CHAR_DIFF_MAX && insText.length <= CHAR_DIFF_MAX) {
        const cp = charParts(delText, insText);
        left.push(...cp.left);
        right.push(...cp.right);
      } else {
        const { pre, midOld, midNew, post } = trimCommon(delText, insText);
        pushIf(left, "same", pre);
        pushIf(left, "del", midOld);
        pushIf(left, "same", post);
        pushIf(right, "same", pre);
        pushIf(right, "ins", midNew);
        pushIf(right, "same", post);
      }
    } else if (delText) {
      left.push({ type: "del", text: delText });
    } else if (insText) {
      right.push({ type: "ins", text: insText });
    } else {
      // 只剩一侧的 same：直接搬运，避免死循环
      if (i < L.length) left.push(L[i++]);
      if (j < R.length) right.push(R[j++]);
      continue;
    }
    i = di;
    j = ij;
  }
  return { left, right };
}

export interface DiffStats {
  /** 未变字符数 */
  kept: number;
  /** 原文中被替换/删除的字符数 */
  removed: number;
  /** 改写稿新增的字符数 */
  added: number;
  /** 原文参与比对的字符总数 */
  total: number;
  /** 改动率 %（相对原文规模，四舍五入到整数） */
  ratio: number;
}

/** 改动率统计：让用户一眼看出"这稿被动了多少"，而不是只看到"改了 N 处" */
export function diffStats(before: string, after: string): DiffStats {
  const { left, right } = diffInline(before, after);
  const sum = (parts: DiffPart[], type: DiffPart["type"]) =>
    parts.reduce((n, p) => n + (p.type === type ? p.text.length : 0), 0);
  const kept = sum(left, "same");
  const removed = sum(left, "del");
  const added = sum(right, "ins");
  const total = kept + removed;
  return { kept, removed, added, total, ratio: total ? Math.round(((removed + added) / total) * 100) : 0 };
}
