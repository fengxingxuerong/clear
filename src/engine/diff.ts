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
