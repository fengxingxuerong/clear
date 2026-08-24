/**
 * 趣AI味 · 命中护栏：固定搭配守卫（GUARD_BEFORE/AFTER）与记忆化的判定入口。
 */
// 上下文守卫：命中词的紧邻前缀/后缀若在黑名单里，跳过替换，避免打断固定搭配
// 例如"价值最大化"里的"价值"换成"用处"会得到"用处最大化"这种怪话
export const GUARD_BEFORE: Record<string, string[]> = {
  显著: ["具有", "颇具", "甚"],
  价值: ["剩余", "创造", "交换"],
  持续: ["可"], // "可持续发展"内嵌"持续"，替换即崩
};
export const GUARD_AFTER: Record<string, string[]> = {
  价值: [
    "最大化",
    "化",
    "观",
    "链",
    "百",
    "千",
    "万",
    "亿",
    "元",
    "连城",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
  ],
  实现: ["最大化", "共赢"],
  提升: ["到了"], // "提升到了"已完成时态，别再动
  持续: ["性"], // "持续性"
  针对: ["性"], // "针对性"
  通过: ["了"], // "通过了考试"是动词义，"靠了考试"错义
};

const guardMemo = new Map<string, boolean>();

/** 带记忆化的命中护栏：同词+同上下文窗口直接复用判定（纯函数，热路径） */
export function guardBlocks(from: string, context: string, before: string): boolean {
  const key = from + "\u0000" + context + "\u0000" + before;
  const hit = guardMemo.get(key);
  if (hit !== undefined) return hit;
  const blocked = judgeGuardBlocks(from, context, before);
  guardMemo.set(key, blocked);
  return blocked;
}

function judgeGuardBlocks(from: string, context: string, before: string): boolean {
  const pre = GUARD_BEFORE[from];
  if (pre) {
    for (const g of pre) {
      if (before.endsWith(g)) return true;
    }
  }
  const post = GUARD_AFTER[from];
  if (post) {
    // 后缀守卫用窗口包含："实现阅读的价值最大化"里"最大化"离动词隔了几个字
    for (const g of post) {
      if (context.slice(0, 8).includes(g)) return true;
    }
  }
  return false;
}
