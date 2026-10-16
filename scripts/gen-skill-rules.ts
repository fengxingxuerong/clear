/**
 * gen-skill-rules.ts —— 从引擎资产生成 agent skill 规则文档（v0.9.39）
 *
 * 背景（生态位）：2026 年主流「去 AI 味」用法是给 Claude Code / Cursor 装一份
 * Markdown 规则 skill（blader/humanizer 44k★ 那一类），而本项目的规则深度
 * （50+ 组替换词表、四体裁旋钮、守卫正则、朱雀标定依据）此前锁在 TypeScript
 * 引擎里，agent 零感知。本生成器把引擎资产渲染成 `skills/humanizer-rules/`
 * 下的 Markdown，让 agent 零安装直接按规则改。
 *
 * 设计纪律（继承本项目双向锁传统）：
 *  · **单一事实源**：规则文档全部从引擎生成，不手抄——引擎改了词表/旋钮，
 *    重跑本脚本即可；skill-rules.test.ts 逐字比对磁盘，手改或忘重新生成都会红。
 *  · 生成函数 `generateSkillRules()` 与写盘分离：测试 import 生成函数做断言，
 *    main 才落盘。
 *
 * 用法：npx tsx scripts/gen-skill-rules.ts [--check]
 *   --check 只比对不写盘（CI 模式：不一致退出 1）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VOCAB_ENTRIES,
  FORMULAIC,
  OPENERS,
  INTERJECTIONS,
  LEADING_CONNECTORS,
  SOFT_ENDINGS,
  SOFT_TAIL_VARIANTS,
} from "../src/engine/humanize-vocab.ts";
import { getGenreKnobs, type EffectiveGenre } from "../src/engine/humanize.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "skills", "humanizer-rules");

/** 守卫正则：同一正则引擎守卫与 skill 文档共用（v0.9.36 立下的规矩，别两边各写一份） */
const GUARDS: { name: string; bad: string; why: string }[] = [
  {
    name: "引述动词+语气词",
    bad: "「语气坚定地说道吧。」",
    why: "句尾软化撒语气词（吧/呢/嘛）时，若句尾是「X道/X表示」类引述标记，语气词会粘成「说道吧」这种不人不鬼的尾巴。含单字「说」的合法祈使（「就听他说吧」）放行。",
  },
  {
    name: "纯标点段误合并",
    bad: `"好，我这就去准备，"（句号被剥成逗号）`,
    why: "切分残余的纯标点段（如引号碎片）没有词字符，不能当过短残句合并——join 时原样拼回，别吞它的句号。",
  },
  {
    name: "从属从句残句",
    bad: "「如果你也在为选台灯发愁。不妨……」",
    why: "如果/假如/即使/虽然等从属连词开头的从句，未闭合（句中无逗号）时不能在此切句。含逗号的复合句是已闭合的，放行。",
  },
  {
    name: "引述结构收尾",
    bad: "「记者从相关部门了解到。我市……」",
    why: "表示/指出/了解到类引述动词收尾的句子，后面接的是引述内容，不能从动词后硬切。双 lookbehind 放行「我不这么认为」类否定自足式。",
  },
  {
    name: "方向修饰语动词撞车",
    bad: "「有效地提升了效率」→「真的提高了效率」",
    why: "方向修饰语（有效地/极大地）替换后与后续动词搭配可能崩。aiScore 看不见搭配病句，替换前必须过人耳。",
  },
  {
    name: "目的连词残句",
    bad: "「为了从根本上解决这一问题。我们……」",
    why: "「为了/以便/旨在」类目的连词引导的成分，未闭合时不能当独立句切开。",
  },
];

/** 四体裁展示名与判定线索（与 classify-genre.ts 的判定特征对应） */
const GENRE_META: Record<EffectiveGenre, { label: string; hint: string }> = {
  main: {
    label: "论说文（政论/产品/学术）",
    hint: "段落推进靠论证，多「首先/其次/综上所述」骨架词，长句规整三部曲——AI 重灾区",
  },
  narrative: {
    label: "叙事文",
    hint: "有场景/动作/时间线，天然短句多，节奏起伏大",
  },
  dialogue: {
    label: "对话体（剧本/访谈）",
    hint: "引号台词占比高，可能带【场景/人物/背景】块",
  },
  humanHand: {
    label: "人写原稿",
    hint: "纯人写。**负斜率**：越去味官方分反而升——轻度即可（≤0.48），或直接用原文",
  },
};

const GENRE_ORDER: EffectiveGenre[] = ["main", "narrative", "dialogue", "humanHand"];

function renderVocab(): string {
  const lines: string[] = [
    "# 套话替换表（VOCAB）",
    "",
    "> 由 scripts/gen-skill-rules.ts 从 src/engine/humanize-vocab.ts 生成，勿手改。",
    "> 每行：AI 套话 → 替身（按语气从轻到重选；空串替身 = 直接删）。",
    "",
    "| AI 套话 | 替身 |",
    "| --- | --- |",
  ];
  for (const [k, vs] of VOCAB_ENTRIES) {
    lines.push(`| ${k} | ${vs.map((v) => (v === "" ? "（删）" : v)).join(" / ")} |`);
  }
  lines.push(
    "",
    "## 引擎踩过的坑（替换前必读）",
    "",
    "- **搭配崩坏 aiScore 看不见**：「极大地提升了效率」换成「非常提高了效率」是病句",
    "  （「非常」不能修饰带「了」的动补），只能换「大大/明显」。中位 6 分的病句评分器抓不到。",
    "- **词性错位**：「致力于」后面接动词短语，替身必须是副词性（「一门心思服务用户」），",
    "  动词替身（「忙着」）会崩。v0.9.22 整组换过。",
    "- **技术文档豁免**：「基于浏览器原生 ESM」里的「基于」不是套话，只能换语序安全的「依托」。",
    "- **时态漂移**：「此刻抽不开身」类替身会把一般现在时拽走，已从词表移除。",
    "",
  );
  return lines.join("\n");
}

function renderFormulaic(): string {
  const lines: string[] = [
    "# 模板腔静态签名（FORMULAIC）",
    "",
    "> 由 scripts/gen-skill-rules.ts 生成，勿手改。命中以下任意一条即为强 AI 味信号：",
    "> 优先整句重写或删除，不要只做同义词互换。",
    "",
  ];
  for (const f of FORMULAIC) lines.push(`- ${f}`);
  lines.push(
    "",
    "## 骨架词密度（要闻体通稿特征）",
    "",
    "据悉 / 下一步 / 有关负责人 / 记者 / 截至目前 / 据悉——新闻通稿骨架词密度最高，",
    "密度超标的稿子按「要闻体」整体处理，别逐词替换。",
    "",
  );
  return lines.join("\n");
}

function renderMaterials(): string {
  // OPENERS 是分类映射（Record<分类, 词[]>），按分类展开成子节；其余是扁平数组
  const openerSections = Object.entries(OPENERS)
    .map(([cat, items]) => `#### ${cat}\n\n${items.map((i) => `- ${i}`).join("\n")}\n`)
    .join("\n");
  const list = (name: string, items: string[]) =>
    `### ${name}\n\n${items.map((i) => `- ${i}`).join("\n")}\n`;
  return [
    "# 改写素材库",
    "",
    "> 由 scripts/gen-skill-rules.ts 生成，勿手改。人味装置的弹药——按体裁取用，别全撒。",
    "",
    "### 口语开头词（OPENERS，按场景分类）",
    "",
    openerSections,
    list("插入语（INTERJECTIONS）", INTERJECTIONS),
    list("开头连接词（软化对象）", LEADING_CONNECTORS),
    list("句尾语气词（SOFT_ENDINGS）", SOFT_ENDINGS),
    list("句尾软化变体（SOFT_TAIL_VARIANTS）", SOFT_TAIL_VARIANTS),
    "",
    "## 使用纪律",
    "",
    "- 每稿软化语气词 ≤2 处：遍地「吧/呢」比 AI 腔更假。",
    "- 对话体场景块（【场景/人物/背景】）不塞自问自答与插话。",
    "- 人写原稿不注入任何插话（负斜率，越注越像 AI）。",
    "",
  ].join("\n");
}

function renderGenres(): string {
  const lines: string[] = [
    "# 四体裁旋钮（GenreKnobs）",
    "",
    "> 由 scripts/gen-skill-rules.ts 从 src/engine/humanize.ts 生成，勿手改。",
    "> 数值来自 v2/v3 OLS 12 点标定 + 朱雀对抗回放，不是拍的。",
    "",
    "| 体裁 | 判定线索 | 平均句长目标 | 节奏目标(burst) | 强度上限 | 朱雀增强 | 自问自答 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const g of GENRE_ORDER) {
    const k = getGenreKnobs(g);
    lines.push(
      `| ${GENRE_META[g].label} | ${GENRE_META[g].hint} | ${k.avgLenTarget} | ${k.burstTarget} | ` +
        `${k.intensityCap} | ${k.disableZhuque ? "强制关" : "按强度"} | ${k.skipSelfQA ? "禁" : "可"} |`,
    );
  }
  lines.push(
    "",
    "## 怎么读这张表",
    "",
    "- **avgLenTarget**：论说文压到 23 字是因为长句最容易出「规整三部曲」；叙事/对话天然短句多，",
    "  目标依次放宽；人写原稿设 36 = 基本不硬切，怕破坏原稿节奏。",
    "- **burstTarget**（句长变异系数下限）：越高越要求长短句交错。论说文要 ≥0.63 才过得去朱雀，",
    "  因为它最怕「句式高度均匀」。",
    "- **intensityCap**：只有人写原稿有 0.48 硬顶——v2 标定该体裁斜率为负，越改官方分越高。",
    "- **humanHand 不要自动判定**：纯人写稿必须用户显式声明，误判成 AI 稿去味等于帮倒忙。",
    "",
  );
  return lines.join("\n");
}

function renderGuards(): string {
  const lines: string[] = [
    "# 病句模式清单（守卫正则）",
    "",
    "> 由 scripts/gen-skill-rules.ts 生成，勿手改。这些是 v0.9.36 扩语料池时**实测抓到**的",
    "> 病句类型（旧探针 0 命中，人眼审查才发现）。改写时逐条自查。",
    "",
    "| # | 病句类型 | 反例 | 为什么错 |",
    "| --- | --- | --- | --- |",
  ];
  GUARDS.forEach((g, i) => {
    lines.push(`| ${i + 1} | ${g.name} | ${g.bad} | ${g.why} |`);
  });
  lines.push(
    "",
    "## 通用红线",
    "",
    "- **不丢字符**：改写前后非空白字符数一致（引号/数字/专有名词一个不能少）。",
    "- **不新增事实**：原文没有的信息不编——「润色」不是「扩写」。",
    "- **台词不搬家**：引号碎片不参与句序重排（奇数引号段整组跳过）。",
    "- **编号句式只认「二、」式**：引擎的编号正则不匹配「2.」式，遇到它别当编号处理。",
    "",
  );
  return lines.join("\n");
}

/** skill 入口：手写模板（frontmatter + 索引），规则本体在 rules/ 下生成 */
function renderSkillEntry(): string {
  return `---
name: humanizer-rules
description: 中文 AI 文本去味规则集。改写成人口语、消除 AI 腔（套话/模板腔/机械排比/升华腔/病句），适配论说/叙事/对话/人写四体裁。当用户要求去 AI 味、降 AI 率、拟人化、润色 AI 生成的文案/论文/通稿/公众号文时使用。规则来自 QuAiWei 引擎（朱雀标定）。
---

# 中文去 AI 味规则（QuAiWei 引擎规则集）

你是中文文本编辑。按本目录 rules/ 下的规则改写用户给的文本，消除 AI 腔，
让它读起来像人写的。**只改表达，不动事实**。

## 工作流程

1. **判体裁**：按 rules/genres.md 的线索判定论说/叙事/对话/人写四档
   （拿不准就问，或按论说文处理——旋钮差异见该文件表）。
2. **过签名**：按 rules/formulaic.md 扫模板腔，命中优先整句重写。
3. **换套话**：按 rules/vocab.md 的替换表处理，注意该文件末尾的踩坑清单。
4. **查病句**：按 rules/guards.md 的六类病句模式自查（引述粘语气词/从句残句/
   纯标点误合并/引述硬切/修饰语撞车/目的连词残句）。
5. **调节奏**：按 rules/genres.md 的句长与 burst 目标切长句、穿插短句；
   素材取 rules/materials.md，每稿软化 ≤2 处。
6. **交付**：先给改后终稿，再附 3 条以内的改动说明（哪几处 AI 味最重、怎么处理的）。

## 硬约束

- 非空白字符数不减少（引号、数字、专有名词一个不能丢）。
- 不新增原文没有的信息、观点、数据。
- 人写原稿（humanHand）只做轻度润色（强度 ≤0.48）——该体裁越改官方检测分越高。
- 对话体的【场景/人物/背景】块不塞自问自答与插话。

## 规则来源

本目录 rules/*.md 由 QuAiWei 仓库 \`scripts/gen-skill-rules.ts\` 从引擎源码
（词表/旋钮/守卫正则）**自动生成**，与引擎同源、随引擎更新。
引擎本体：https://github.com/fengxingxuerong/quaiwei （Electron 桌面 + CLI + Web 三端）。
`;
}

/** 生成全部文件：相对 OUT_DIR 的路径 → 内容。与写盘分离以便测试。 */
export function generateSkillRules(): Map<string, string> {
  const files = new Map<string, string>();
  files.set("SKILL.md", renderSkillEntry());
  files.set(path.join("rules", "vocab.md"), renderVocab());
  files.set(path.join("rules", "formulaic.md"), renderFormulaic());
  files.set(path.join("rules", "materials.md"), renderMaterials());
  files.set(path.join("rules", "genres.md"), renderGenres());
  files.set(path.join("rules", "guards.md"), renderGuards());
  return files;
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const files = generateSkillRules();
  let drift = 0;
  for (const [rel, content] of files) {
    const abs = path.join(OUT_DIR, rel);
    if (checkOnly) {
      const onDisk = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
      if (onDisk !== content) {
        console.error(`✗ ${rel} 与磁盘不一致（引擎已更新？重跑 gen-skill-rules.ts）`);
        drift++;
      }
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      console.log(`  ✍ ${rel}（${content.length} 字符）`);
    }
  }
  if (checkOnly) {
    if (drift > 0) {
      console.error(`✗ ${drift} 个文件漂移`);
      process.exit(1);
    }
    console.log(`✅ ${files.size} 个文件与引擎一致`);
  } else {
    console.log(`✅ skill 规则已生成 → ${OUT_DIR}`);
  }
}

/** 直接执行判定（tsx 直跑与测试 import 生成函数时都不误触发） */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) main();
