/**
 * 趣AI味 · 本地引擎数据词典与工具函数（兼容桶）
 *
 * 数据常量与共享原语已按域拆分到同目录模块：
 *   humanize-vocab.ts      规则词典 / 连接词 / 软化短语
 *   humanize-guard.ts      固定搭配命中护栏
 *   humanize-text.ts       切句工具与机械清理词表
 *   humanize-zhuque.ts     朱雀增强对抗特征
 *   humanize-primitives.ts RNG / 句长统计等共享原语
 *
 * 本文件仅做统一再导出，既有引用方（engine 三模块、scripts/*）无需改动。
 */
export * from "./humanize-vocab";
export * from "./humanize-guard";
export * from "./humanize-text";
export * from "./humanize-zhuque";
export * from "./humanize-primitives";
