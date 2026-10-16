v0.9.52：审题模式（detector-only）+ 开源对标表刷新 + 发现性基建

起因：对 GitHub 同类做了一轮实测复查（scripts/scan-github-sector.mjs）。
结论是引擎侧仍是能力超集，差距在发现性与分发，按优先级补四条。

一、detector-only 审题模式（对标 no-ai-slop 的 detect 模式）
- src/engine/review.ts（新）：逐句出「第几句/风险/命中特征/建议怎么动」
- src/components/ReviewPanel.tsx（新）+ 界面「审题」按钮（不藏进简洁档）
- CLI --detect-only（位置同 --dry-run：在 Key 校验与建目录之前返回）
- 复用 detector.ts 的 segmentRisk，不另写一套打分（防两处漂移）
- 按文档顺序输出而非按风险排序；正向特征只解释分数、不给建议

二、开源对标表刷新到 2026-10-17 实测
- 补 4 个漏项；作废「没有面向用户的为什么这么改清单」这条过时口径
- 更正上一版诊断：topics 早已就位，真没开的是 has_pages / has_discussions

三、发现性基建
- .github/workflows/pages.yml：在线试玩（concurrency 只排队不取消）
- .github/ISSUE_TEMPLATE/：去味缺陷模板（强制带原文/产物/参数 + 要求脱敏）
- CONTRIBUTING.md：把 CI 管不了的硬纪律写实
- README_EN.md + README 顶部双语入口

四、纪律
- 新增 14 条用例，两处变异检验均报红
- 加 CLI 参数同步 SKILL.md（skill-md.test.ts 双向锁）
- tsc / eslint / prettier 全绿；src 全量 1580/1580
