/**
 * 趣AI味 v0.8 · 机械扰动层：反指纹规则 + 节奏增强 + 跨块清理 + 结构级去味（新增）
 *
 * v0.8 重大增强（针对朱雀结构特征的四大核心杠杆 + 两大句式级 + 两大反检测）：
 *  P0 shuffleSentencesSafe           段内句序安全重排（无承接依赖的自由句两两交换）
 *  P0 breakEnumerationStructure      首先/其次/最后 第一/第二/第三 列举结构打散
 *  P0 breakSummaryTail               总-分-总 尾总结句移位 + 可选拆段
 *  P0 resegmentParagraphsAggressive  AI 典型段（2-4句/极度均匀）激进重切
 *  P1 deParallelizeStructure         排比/对仗结构破坏（同头同长同结构连续 3+ 句）
 *  P1 injectSelfQA                   自问自答注入（AI 极少写，人类极常用）
 *  P2 injectHumanTypos               极低概率错别字（全文 <= 2 处，打字手滑痕迹）
 *  P2 injectDialect 多命中修复       原函数只改第一个命中 → 现多命中上限每词 3 处
 *  P3 FORMULAIC/连接词/LE_VERBS 扩充（配套 humanize-vocab-extra.ts）
 *
 * 2026-08-26 v2 新增（针对论说体「本地 aiScore=0 但官方仍 45%」的语义结构瓶颈）：
 *  P3-1 dismantleExpositionTrilogy      论述"三部曲"语义结构拆毁（去词 + 打乱顺序 + 第一人称经验插叙 + 半否定）
 *  P3-2 hardNumberedEnumerationShuffle  硬编号列举(1./2./3.)倒装打散2.0（删编号 + 插叙括号 + 反问 + 段尾补充）
 *  P3-3 enforceParagraphLeadSentVariance  段首句长强制方差（短/中/长 2:3:5 硬分布）
 *  P3-4 injectFirstPersonAnchorPoints    300字≥1 处第一人称经验锚点（论说专属「人写语义锚」）
 *  + 预检 preDetectHumanFingerprint    纯人写原稿命中则自动降级，修复"H0→H1/H2越去味越差"负收益
 *
 * 2026-09-29 拆层：本文件原为 2011 行单文件，现按职责族拆为 src/engine/shuffle/ 子包
 * （primitives 标点与套话清理 / burstiness 节奏 / structure 结构级 / typos 错别字 /
 *   fingerprint 预检与体裁分 / orchestrator 主编排），此处保留为**门面**——
 * 全部导出经 re-export 聚合，`from "./humanize-shuffle"` 的既有导入面 100% 兼容，
 * 函数体逐字搬移、行为零变化（标定棘轮 Δmax 35/35 与 12 样本回归作为守卫）。
 */

export * from "./shuffle/primitives.ts";
export * from "./shuffle/burstiness.ts";
export * from "./shuffle/structure.ts";
export * from "./shuffle/typos.ts";
export * from "./shuffle/fingerprint.ts";
export * from "./shuffle/orchestrator.ts";
