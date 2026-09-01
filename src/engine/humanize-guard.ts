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

/* ---------------- 剧本场景块全格式保真护栏（P8） ---------------- */
/**
 * 剧本【场景/人物/角色/地点/时间/背景/旁白/简介】块头行判定。
 * 块头是元数据不是行文：relaxColon 会把它改成【场景，…】、injectParentheticals 会
 * 往里塞"——真要说起来——"、injectDialect 会把"从早上八点"改成"打从早上八点"、
 * injectHumanTypos 会单字替换——任何注入/机械改写都应跳过整行。
 * 判定口径：行首为【 且行内含场景块关键字（无锚，行内包含）。
 */
const SCENE_BLOCK_LINE_RE =
  /【[^】]{0,80}(?:场景|人物|角色|地点|时间|背景|旁白|简介)[^】]{0,80}】/;

export function isSceneBlockLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("【") && SCENE_BLOCK_LINE_RE.test(t);
}
