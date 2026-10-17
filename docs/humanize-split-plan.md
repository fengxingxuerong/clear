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

### 阶段 1b（2026-10-17，已完成；**边界按实测修正，选项 A**）

> ⚠️ 原文档第 2/3 节的 1b 边界**作废**：它假设 `applyZhuqueFeatures` 是 682 行的大函数、
> 且"待搬符号都不是 humanize.ts 自家产物"。实测两条都错——
> ① `applyZhuqueFeatures` 只有 **130 行**，真正调用替换层的是其后没人提到的
> `humanizeSingle()`（538 行，本地引擎单遍主体）；
> ② 替换层 27 个符号 / 589 行是 humanize.ts 自家产物，只被这两个函数调用。

**修正后的架构实测**（v0.9.53，1737 行态）：

| 函数 | 行段 | 行数 | 真实职责 |
|---|---|---|---|
| `humanize()` | 304–839 | 538 | 编排入口：调 `humanizeSingle` + `applyZhuqueFeatures` |
| `applyZhuqueFeatures()` | 842–971 | 130 | 朱雀特征注入 |
| `humanizeSingle()` | 972–1509 | 538 | 本地引擎主体，替换层唯一调用方 |
| `injectDialect` 家族 | 1510–1688 | 179 | 已停用，留档 |

**执行顺序（三步三 commit，每步全量门禁 + realcase 字节级比对）**：

| 步 | 内容 | 结果 |
|---|---|---|
| 1 | `emitStage`/`nowMs`/`TRACE_SNIPPET_LEN` → `humanize-primitives.ts`（两边共用，留主文件会成环） | 2296→2260 |
| 2 | 替换层（`replaceVocab` 家族 + 私有守卫正则，原 301–823）→ `humanize-replace.ts`（565 行） | 2260→1737 |
| 3 | RAMP 斜坡 + `applyZhuqueFeatures` + `humanizeSingle` + `injectDialect` 家族 → `humanize-zhuque-apply.ts`（885 行） | **1737→853** |

**最终形态**：`humanize.ts` **853 行**（只剩编排入口 `humanize()` + genre knobs + 建议/评分门面 +
公开 API 面）；`humanize-replace.ts` 565 行；`humanize-zhuque-apply.ts` 885 行。

**外部兼容零改动**：`applyZhuqueFeatures` / `injectDialect` 经 humanize.ts re-export；
`PURPOSE_LE_RE` / `NORMATIVE_LE_RE`（scan-bugs.ts 依赖）同样 re-export；
`getGenreKnobs` / `EffectiveGenre` / `GenreKnobs`（gen-skill-rules.ts 依赖）留主文件。

**验证**：每步 tsc / eslint / prettier + 96 files / 1926 tests 全绿 + realcase 20 篇
`report.json` 零 diff；三步完成后 `check:release` 全通过。

**踩坑记录（供以后拆分参考）**：

1. **搬运脚本的"字节级等价"只覆盖被搬运的代码体**。1a 坏在 import 块，1b 坏在
   `export` 修饰符——`humanizeSingle` 搬过去忘了加 export，`humanize()` 主流程
   立刻两处 TS2304。**搬完必须 tsc，且必须想到"谁调用被搬走的函数"**。
2. **扫描 import 依赖的正则必须覆盖单行 import**（`import { x } from "..."`）。
   1b 扫描漏了 `keepOnlyIfDetectDrops` / `suppressSelfQA`（单名单行/单行多名），
   靠 tsc 兜底抓出。更稳的做法：搬完后直接 tsc，把 TS2304/TS6133 当清单逐项清。
3. **注释里/字符串字面量里的标识符会污染依赖扫描**（`humanize` 出现在 trace 的
   `why` 字符串里被误报为外部依赖）。剥注释要按块剥，且字符串内容要排除。
4. `humanize.ts` 最终 **807 行**，不再是最大文件；守卫正则区的后续评估见第 8 节。

## 8. 后续评估结论（2026-10-17 傍晚，1b 完成后）

### 问题 2「拆 492–994 守卫正则区」——**已变成伪命题，不做**

1b 的边界修正把该区域的大部分内容**已经搬走了**。实测各守卫正则的现居地：

| 符号 | 现居 | 说明 |
|---|---|---|
| `PURPOSE_LE_RE` / `NORMATIVE_LE_RE` / `LE_RE` | `humanize-replace.ts` | 1b-2 随替换层整体迁入（消费者就在同文件） |
| `PASSIVE_REWRITES` / `INTENSIFIER_*` / `RELAX_REDUNDANT_RES` / `ACADEMIC_FROZEN` | `humanize-replace.ts` | 同上 |
| `GUARD_BEFORE/AFTER` / `VERB_PHRASE_AFTER` / `guardBlocks` / `isSceneBlockLine` | `humanize-guard.ts`（v0.9.43 老模块） | 从未在 humanize.ts 里 |
| `FORMULAIC` / `SKELETON` / `segmentRisk` | `detector.ts` / `humanize-vocab*.ts` | 方案担心的"双向依赖"双方都不在 492–994 区，风险从未存在 |

⇒ 原问题的前提（守卫正则堆在 humanize.ts 里且与 detector 双向依赖）在 1b 后已不成立。
**无需再拆**。已知遗留小味：`SCENE_BLOCK_LINE_RE` 在 `humanize-replace.ts`（导出）与
`humanize-guard.ts`（私有）各有一份同文正则——此重复先于拆分存在（guard.ts 自 v0.9.43），
且**不可简单去重**：guard.ts 若改为 import replace.ts 会成环
（guard → replace → humanize-data → guard）。留待将来重构 data 层时再收。

### `humanize()` 本体（540 行）——**评估后决定不拆**

结构实测（808 行态）：32 个局部声明、31 个条件分支、19 处 `emitStage` 埋点、
4 个 return；是一条**共享可变状态**（`result` / `skipped` / `zqRan` / `effectiveGenre` /
`knobs`）贯穿的线性流水线（体裁判定 → 逐段 humanizeSingle → 朱雀特征 → 结构 passes →
去重 → 节奏 → 派生精修 → 清尾）。

不拆的理由：

1. **拆它 = 拆行为本身**。这个函数就是产品行为，抽stage 出去要传递/返回上述共享状态，
   签名膨胀、回归风险实打实；与 1a/1b"纯搬运、输出逐字节不变"的可验证性完全不同类。
2. **trace 埋点与流水线交织**（19 处 emitStage 的顺序与内容是 trace 测试的断言对象），
   搬移极易改变可观测行为。
3. 模块级拆分的核心收益（改一处不加载全部）已由 1a/1b 达成：humanize.ts 808 行、
   最大模块 humanize-zhuque-apply.ts 973 行，都在合理区间。
4. 真要动它，正确的形态不是拆模块而是**拆 stage 函数 + 显式状态对象**，属引擎重构，
   需单独版本 + 单独的验收方案（含 trace 顺序断言），不塞进任何拆分尾巴里。
