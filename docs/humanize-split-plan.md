# humanize.ts 拆分方案（2026-10-17 立）

> 起因：工程体检发现 `src/engine/humanize.ts` **2,477 行**，是全仓最大的源文件，
> 且 1,907 条用例围着它——改一行、全部门禁响。这是发布成本螺旋的物理根源。
> 本文只做**方案与边界划定**，不动代码。执行前需确认（见第 5 节）。

## 1. 现状实测（2026-10-17）

| 项 | 值 |
|---|---|
| `humanize.ts` | 2,477 行 |
| 直接 import 它的文件 | 36 处（src/ 20+ 个文件 + scripts/） |
| 相关测试文件 | 16 个（`humanize*.test.ts`） |
| 已拆出去的数据层 | `humanize-data.ts`（聚合桶）→ `humanize-zhuque.ts`(167) / `humanize-vocab.ts`(889) / `humanize-vocab-extra.ts`(139) |

**关键结论：数据层已经拆好了，剩下的是逻辑层。** `humanize.ts` 通过 `humanize-data.ts`
转导入 `DIALECT_VOCAB` / `PARENTHETICALS` / `SENTENCE_FRAGMENTS` / `OPINION_PHRASES` / `PARENTHETIC_NOTES`，
不存在双源定义。

## 2. 内部区块实测边界

| 行段 | 行数 | 内容 | 拆分判定 |
|---|---|---|---|
| 149–294 | 146 | 常量/阈值/强度斜坡/`getGenreKnobs` | 留（被主流程密集引用） |
| 295–491 | 197 | 替换规则、`wouldCascade`、`FORMAL_FORBIDDEN_SUBSTITUTES`、`DIR_MODIFIER_VERB_CLASH_RE` | **拆 → `humanize-rules.ts`** |
| 492–994 | 503 | 守卫正则（`PURPOSE_LE_RE` / `NORMATIVE_LE_RE` 一族） | 留（第 2 阶段再议，风险最高） |
| 995–1040 | 46 | trace 发射器 | 留 |
| 1041–1581 | 541 | **`humanize()` 主流程** | 留（这是本体） |
| 1582–2263 | 682 | **`applyZhuqueFeatures()`** | **拆 → `humanize-zhuque-apply.ts`** |
| 2264–2429 | 166 | `injectDialect()` | **跟着搬**（被 `applyZhuqueFeatures` 调 4 次，见下） |
| 2430–2477 | 48 | `adviceFor` / `humanizeWithScore` | 留 |

### 为什么 `injectDialect` 必须跟着搬

实测 `applyZhuqueFeatures` 内部调用 `injectDialect` **4 次**。若只搬前者，
新文件要反向 import 原文件的 `injectDialect`，而原文件又要 import 新文件的
`applyZhuqueFeatures` ⇒ **循环依赖**。连带搬走可保依赖单向。

## 3. 目标结构（两阶段，顺序不能反）

```
阶段 1a：humanize-rules.ts（~200 行）
  搬 295–491：替换规则 + FORMAL_FORBIDDEN_SUBSTITUTES + wouldCascade + DIR_MODIFIER_VERB_CLASH_RE
  为什么先拆它：FORMAL_FORBIDDEN_SUBSTITUTES 被 applyZhuqueFeatures 用 1 次，
  也被 vocab-formal-substitutes.test.ts 直接 import。先把它变成独立模块，
  阶段 1b 的新文件才能单向 import 它，不必碰循环依赖。

阶段 1b：humanize-zhuque-apply.ts（~850 行）
  搬 1582–2429：applyZhuqueFeatures + injectDialect
```

拆完：`humanize.ts` 2,477 → **约 1,430 行**，仍是最大文件但不再离谱。

### 依赖方向（拆完后）

```
humanize.ts ──┬─→ humanize-rules.ts        （替换规则）
              ├─→ humanize-zhuque-apply.ts （朱雀增强注入）
              └─→ humanize-data.ts ──→ humanize-zhuque.ts（数据）

humanize-zhuque-apply.ts ──→ humanize-rules.ts
humanize-zhuque-apply.ts ──→ humanize-primitives.ts（pick / isCJK / splitSentences）
humanize-zhuque-apply.ts ──→ humanize-vocab.ts（SOFT_ENDINGS / SOFT_TAIL_VARIANTS）
humanize-zhuque-apply.ts ──→ anti-fingerprint.ts / classify-genre.ts / detector.ts
```

**无环。** 已逐个核对待搬符号的来源：`pick` / `isCJK` / `splitSentences` 在
`humanize-primitives.ts`，`SOFT_ENDINGS` / `SOFT_TAIL_VARIANTS` 在 `humanize-vocab.ts`，
都不是 humanize.ts 自家产物——这是能干净拆开的前提。

## 4. 外部兼容：零改动

`humanize.ts` 继续 re-export 全部既有符号（`applyZhuqueFeatures` / `injectDialect` /
`FORMAL_FORBIDDEN_SUBSTITUTES` / …），36 处 import 与 16 个测试文件**一行都不用改**。
`scripts/gen-skill-rules.ts` 的 import 也不动。

判据（拆完必须仍为真）：

```bash
cd /d/projects
env -u NODE_OPTIONS node D:/projects/quaiwei/node_modules/vitest/vitest.mjs run --root D:/projects/quaiwei src/ scripts/
# 期望：96 files / 1926 tests 全绿，且**不许改任何测试文件**
```

**"不许改测试文件"是硬约束**——如果拆分需要动测试才能绿，说明边界划错了，回退。

## 5. 风险与前置确认

| 风险 | 缓解 |
|---|---|
| 搬移时漏掉某个内部符号（编译能抓） | `npx tsc -b` 是硬门禁 |
| 行为漂移（搬过去后逻辑等价但顺序变了） | 全量 1,926 条 + `npm run test:regress` + `realcase/run.ts` |
| `applyZhuqueFeatures` 内部有对 humanize.ts 模块级状态的隐式依赖 | 拆完先跑 `humanize-structure.test.ts`（13 条直调用例）与 `classify-genre.test.ts`（2 条直调） |
| 拆分后 `check:release` 的覆盖率门禁掉点 | 新文件必须有对应测试；`applyZhuqueFeatures` 已有直调用例覆盖，风险低 |

### 执行前需要你确认的两件事

1. **现在拆，还是等拿到朱雀 Key 之后拆？**
   拆分的收益是"改引擎变便宜"，而当前瓶颈是"没有人用"。两者不冲突，但都吃时间。
2. **要不要顺带把 492–994 的守卫正则（503 行）也拆出去？**
   那一步风险最高（`FORMULAIC` / `SKELETON` 一族被 `segmentRisk` 与 `detector.ts` 双向依赖），
   建议**单独一个版本**做，不要和 1a/1b 混。

## 6. 明确不建议现在做的

- **不要在拆分的同一个 commit 里改任何引擎行为。** 拆分必须是"零行为差异"的纯搬运，
  否则 1,926 条测试红了你也分不清是搬错了还是改错了。
- **不要顺手重命名** `applyZhuqueFeatures`（36 处 import + 测试 + gen-skill-rules 都会响）。

## 7. 执行记录

### 阶段 1a（2026-10-17，已完成）

| 项 | 结果 |
|---|---|
| 搬运区间 | 149–162（常量/阈值）+ 295–490（替换规则）→ `humanize-rules.ts`（226 行） |
| `humanize.ts` | 2,477 → 2,282 行（import 块修复后 2,296） |
| 字节级等价 | `scripts/realcase/report.json` 与拆分前**零 diff**（20 篇真实语料输出逐字节一致） |
| 测试 | 96 files / 1926 tests 全绿，**未改任何测试文件**；覆盖率 98.0/94.5/98.5/98.5 |
| tsc / eslint | 均通过 |

**踩坑记录**：`_split-1a.mjs` 搬运代码体是安全的（锚点校验 + 整块搬运），
但它重写文件时把原有的 5 段 import 合并成了单段坏块（82–90 行混入 `import {,` 垃圾行、
闭合行带尾逗号）——**字节级等价只覆盖被搬运的代码体，不覆盖 import 区**。
阶段 1b 执行后必须人工核对 import 块，或先跑 `humanize.test.ts`（esbuild 会秒级报语法错）。

**遗留**：`scripts/_split-1a-fix.mjs`（就是写出坏 import 块的那个修复脚本）**未提交**——
它对 1b 有害无益，留在工作区仅为留档。1b 应改用「搬完后按模块重建 import」的流程。
