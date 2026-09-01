# 技术复盘：P7 体裁联动改造中两个隐藏缺陷的发现与修复

> 适用版本：v0.7.x-dev　|　日期：2026-08-26
> 涉及代码：`src/engine/humanize.ts`、`src/engine/humanize-shuffle.ts`、`src/engine/classify-genre.test.ts`
> 触发场景：为 P6/P7 行为固化编写单元测试时，两个缺陷被失败的断言逐一暴露。
> 性质：两处均为**静默失效**型缺陷——功能看起来在工作，回归套件全绿，但特定输入下承诺的行为并未发生。

---

## TL;DR

| # | 缺陷 | 根因一句话 | 危害 |
|---|------|-----------|------|
| 1 | 场景块保护被前置注入击穿 | `^` 锚定的段首正则依赖"段落开头干净"这一隐含前提，而同一函数内的前置注入恰恰破坏了这个前提 | 对话体剧本台词区被塞入违和的自问自答，`skipSceneInject` 承诺形同虚设 |
| 2 | 多段落文本静默合并成一段 | `splitSentences()` 把 `\n\n` 当分隔符拼回上一句后又被 `.trim()` 剥掉，所有「切句→改→join」的全文本级函数都会丢段落结构 | **任何**多段落输入在 intensity≥0.4 时段落结构必然丢失，用户排版被静默摧毁 |

两者的共同教训：**单元级正确 ≠ 组合级正确**。每个函数单独看都没问题，组合起来承诺就破了。

---

## 缺陷一：场景块保护被前置注入击穿

### 1.1 缘起

为 P7-E（对话体剧本跳过自问自答注入）写行为固化测试。第一版断言很朴素：

```typescript
it("对话体剧本场景块：applyZhuqueFeatures 跳过自问自答注入", () => {
  const withSkip = applyZhuqueFeatures(DIALOG_SCRIPT, 0.9, 42, "casual", { skipSceneInject: true });
  expect(withSkip).toContain("【场景：公司会议室，下午三点】");
  expect(withSkip.split("\n").length).toBe(linesBefore);   // 行数守恒
});
```

**第一次失败**：输出从 6 行变成 1 行。这揭示了一个中间事实——`injectSelfQA` 内部 `sents.join("")` 会吃掉所有换行，把剧本折叠成一个巨型段落。行数守恒假设不成立，断言改为扫描自问自答语料库的特征词（QA_MARKERS）：

```typescript
const QA_MARKERS = ["为啥这么说", "真的假的", "你可能会问", /* ... */];
for (const m of QA_MARKERS) expect(skipped).not.toContain(m);
```

**第二次失败才是真正的金子**。`skipSceneInject: true` 的情况下，输出里赫然出现：

```
坦白讲，【场景：公司会议室，下午三点】张总（项目经理）：……真的假的？
这事儿还真不是我瞎编。不信？那你自己试试就知道了。……
```

保护开关开着，自问自答照样进来了。

### 1.2 根因链

完整的失效链条由四环扣成：

```
① 前置注入污染段首          ② ^ 锚定正则失配           ③ 保护失效            ④ 折叠放大
injectDialect 等 casual    SCENE_BLOCK_PARA_RE       整段被当作普通段落    injectSelfQA 的
注入在段首垫词             = /^\s*【[^】]{0,80}      进入 injectSelfQA     join("") 吞掉全部
「坦白讲，」               (场景|人物|…)…】/          （句子数 ≥5 满足）    换行 → 结构级扫荡
        │                        │                       │                再次尝试注入
        ▼                        ▼                       ▼                     ▼
   段落开头不再              检测不到场景块            台词区被塞 QA      二次击穿同款检测
   以【场景开头             → 返回 false                                  （structuralShuffle-
                                                                          Paragraph 内部还有一份）
```

关键洞察：**检测器依赖的特征（段首位置）不是它声称要检测的对象（场景块内容）的稳定属性**。「坦白讲」这个垫词来自 `PAD_WORDS` 词表（humanize-zhuque.ts），它本该出现在任何位置——但一旦出现在段首，就把一个合法的场景块"伪装"成了普通段落。

更隐蔽的是第④环：`applyZhuqueFeatures` 和 `structuralShuffleParagraph` 各自维护了一份场景块检测逻辑（后者还带着自己的 `^` 锚定正则副本）。即使修好了前者，后者依然会漏。

### 1.3 修复方案的两次迭代

**v1（不彻底）**：跳过判定改看原始文本——

```typescript
const origHasSceneBlock =
  skipScene && text.split(/\n\n+/).some((p) => SCENE_BLOCK_PARA_RE.test(p));
```

能挡住当前用例，但有两个问题：被 `skipScene &&` 门控意味着强制 `genre=main` 的含场景块文本失去保护；且逐段检查仍可能被污染击穿。

**v2（语义错误）**：改成文档级 OR 判定 `(opts.skipSceneInject ?? false) || text含场景块`。跑正向对照时才发现副作用——**没有开关时含场景块的文本也全篇跳过了**，注入机制对这类文本永久沉默，测试写成了"永真"。这违背了 P7-E 的设计意图：保护应该是"对话体裁全跳过 + 其他体裁逐段保护"两层语义。

**v3（最终版）**，三个动作：

1. 正则去掉 `^` 锚定，改名 `SCENE_BLOCK_LINE_RE`，语义从"段首匹配"变为"行内包含"；
2. QA 步骤重构为两层判定：`skipFlag` 开 → 全文跳过（体裁级承诺）；未开 → 逐段扫描，任一行含场景块头的段落原样保留，其余照常注入；
3. `structuralShuffleParagraph` 内部的第二份检测替换为新的辅助函数，按行扫描：

```typescript
/** P7-E：段落内任一行含剧本【场景/人物/背景】块头即视为场景块段落 */
function paraHasSceneBlock(paragraph: string): boolean {
  return paragraph.split(/\n/).some(
    (ln) => /【[^】]{0,80}(?:场景|人物|角色|地点|时间|背景|旁白|简介)[^】]{0,80}】/.test(ln),
  );
}
```

选择本地私有函数而非跨模块导出共享正则，是为了不加深 humanize.ts ↔ humanize-shuffle.ts 既有的循环依赖。

### 1.4 断言设计的同步演进

测试本身也经历了三轮校准，这个过程和修 bug 同样有价值：

| 版本 | 断言 | 问题 |
|------|------|------|
| 初版 | 行数守恒 + 场景头逐字相等 | 行数会被 `join("")` 合法地改变；场景头会被插入语函数合法地改写（如【场景：公司会议室**——真要说起来，**下午三点】） |
| 中版 | 扫描 QA_MARKERS 不出现 | 方向对了，但正向对照用了同一个剧本样本——v3 之后剧本自身就被逐段保护，对照组永远阴性，测试退化为永真 |
| 终版 | 负向：多种子 × QA_MARKERS 全不命中；正向：**另造一份无场景块的普通多句文本**证明注入机制活着 | 双向对照，既防"没保护住"也防"全关掉了" |

---

## 缺陷二：多段落文本静默丢失段落结构

### 2.1 缘起

C 项收尾后的全量验证中，vitest 首次以全量模式跑（此前只抽跑新测试文件），55 个用例里 1 个失败——而且是**仓库里早就存在的既有测试**：

```typescript
it("多段文本保留段落换行", () => {
  const para = "第一段第一句，说点事情。\n\n第二段第一句，再说点别的。";
  const out = humanize(para, { intensity: 0.6, seed: 3 });
  expect(out).toContain("\n");
});
```

实际输出：

```
第一段第一句，说点事情嘛行。呵。。第二段第一句，再说点别的诶诶。。对哦。。
```

两段被焊成了一行。排除法很快锁定范围：该样本未开 `zhuqueMode`，当天改动的人设增强路径根本不会执行——这是一个**更早引入、从未被全量测试覆盖过的历史缺陷**。输出中的「呵。」「对哦。」正是 `boostBurstinessIfLow` 的极短锚词表成员，顺带指认了凶手。

### 2.2 根因：共享原语的隐性契约

[splitSentences](file:///D:/deep/quaiwei/src/engine/humanize-text.ts) 的实现：

```typescript
export function splitSentences(text: string): string[] {
  const parts = text.split(/([。！？!?；;\n]+)/);   // \n 属于分隔符
  ...
  return out.map((s) => s.trim()).filter((s) => s.length > 0);   // ← 破坏点
}
```

`\n\n` 作为分隔符的一部分被拼回上一句尾部，随后 `.trim()` 把它剥掉。于是任何遵循「`splitSentences()` → 逐句修改 → `join("")` 重组」模式的**全文本级**函数，都会把段落边界无声抹平：

```
"……说点事情。\n\n第二段……"
        │ splitSentences
        ▼
["……说点事情。\n\n", "第二段……"]     ← 分隔符挂在上一句尾巴上
        │ .trim()
        ▼
["……说点事情。", "第二段……"]         ← \n\n 消失了
        │ join("")
        ▼
"……说点事情。第二段……"               ← 两段焊死
```

### 2.3 影响面审计

修复前逐一排查了 humanize 主管线 intensity≥0.4 时会经过的全部全文级步骤：

| 函数 | 模式 | 是否丢段落 |
|------|------|-----------|
| `dedupePadWords` / `limitPunctuation` / `ensureEmDashCountHardCap` | 纯字符串 indexOf/replace | 安全 |
| `replaceGuardedFormulaicDerivs` | 纯正则替换 | 安全 |
| `sentenceStats` 及统计类 | 只读统计（字长计算本就剥离 `\s`） | 安全 |
| **`clampAvgSentenceLenUnder25`** | splitSentences → splice → join("") | **丢失** |
| **`boostBurstinessIfLow`** | splitSentences → 插锚 → join("") | **丢失** |

`boostBurstiness`（非 IfLow 版）早已自带 `\n\n` 分段分发逻辑，说明这个问题在代码库历史上被意识到过一次——但没有沉淀为共享模式，后来的新函数又踩了同一个坑。

### 2.4 修复决策：为什么不动共享原语

理论上"最根治"的做法是让 `splitSentences` 保留句尾换行。但它被逐句处理路径（humanizeSingle 主循环等）大量依赖，这些调用方默认"句子是干净的"，保留 `\n\n` 会把污染扩散到几十个下游。权衡后选择**局部包裹**：给两个元凶函数加段落分发层，复用 `boostBurstiness` 已验证的模式——

```typescript
export function clampAvgSentenceLenUnder25(text: string, targetAvg = 25, maxCuts = 6): string {
  if (!text.includes("\n\n")) return clampAvgSentencesInBlock(text, targetAvg, maxCuts);
  return text
    .split(/\n\n+/)
    .map((p) => clampAvgSentencesInBlock(p, targetAvg, maxCuts))
    .join("\n\n");
}
// clampAvgSentencesInBlock = 原函数体原样降级为私有 core
```

代价是未来新增全文级函数仍需自觉遵守该模式——已在两处补丁注释中标注「与 boostBurstiness 相同的分段模式」作为路标。

### 2.5 为什么 24 项回归套件没拦住它

12 样本回归（A.Metrics + B.E2E）的样本恰好全部是单段文本。单段输入下 `text.includes("\n\n")` 为 false，缺陷完全不触发。指标层面 aiScore 变化率 0%，一切正常。**回归套件保护的是已知的数值漂移，不保护未被样本覆盖的结构维度**。段落结构正是朱雀检测的语义指纹维度之一，此缺陷意味着线上所有多段落用户的输出都在被静默压扁。

---

## 验证结果

修复完成后四道关全绿：

```
ESLint (--max-warnings=0)     0 error / 0 warning
tsc (strict + noUnusedLocals) 0 error
vitest 全量                   55/55 passed（含 classify-genre.test.ts 新增 10 例）
12 样本回归                   A 套件 12/12 + B 套件 12/12，O2/O3 论说档 aiScore 92→0
```

其中 O2/O3 从基线 92 分降到 0 且与 lock 基线一致，确认段落感知改造未引起指标漂移（单段路径行为逐位不变，多段路径仅恢复应有的分段）。

---

## 经验教训

**1. "我以为它在保护"和"它真的在保护"之间，隔着一个失败的测试。**
两个缺陷都不是 code review 发现的——它们各自都通过了人工检查（功能存在、调用正确、回归全绿），直到把承诺写成可执行断言才现形。行为固化测试的成本集中在编写那一刻，收益却覆盖此后每一次改动。

**2. 防御性检测应绑定对象的稳定特征，而非易被上游污染的位置特征。**
`^` 锚定检测的是"段落开头"，而段落开头恰恰位于多个主动改写器的必经之路上。当检测器和改写器共存于同一管线时，要么让检测先于一切改写执行，要么改用内容特征（行内包含）而非位置特征（段首锚定）。同类错误在同一次改造中出现两份拷贝，说明复制粘贴防御逻辑时，缺陷也被复制了一份。

**3. 断言要双向对照，否则容易写成永真。**
"坏东西不出现"（负向）必须搭配"机制确实活着"（正向），且两者不能用同一个样本——修复后样本自身进入保护范围，正向对照就静默失效了。正向对照样本应刻意避开触发保护的条件。

**4. 共享原语的每个"清理动作"（如 trim）都是一份隐式契约。**
`splitSentences` 的调用方分两类：逐句加工型（受益于 trim）和重组回写型（被 trim 破坏）。当原语同时服务两类语义相反的调用方时，任何一侧的需求变更都会击穿另一侧的假设。审计影响面时要按"调用模式"分组，而不是按"调用了谁"。

**5. 抽样验证存在结构性盲区。**
回归套件绿 ≠ 没有回归，只能说明"样本覆盖到的维度没有回归"。本次的段落维度、此前的体裁维度，都是在扩充测试矩阵时才暴露的。每新增一类能力（如结构改写），都应同步问一句：现有样本库是否覆盖了它能破坏的每一个输入形态？

---

*本文档由 P7 体裁联动改造（A/B/C 三项优化实施）过程中的真实调试记录整理而成，所有失败输出均摘自当日 vitest 运行日志。*
