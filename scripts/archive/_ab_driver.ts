import { readFileSync, writeFileSync } from "node:fs";

/**
 * A/B 实验驱动器：临时改 humanize.ts 的注入器门控，跑分，再还原。
 * 每轮只改一行，测量该注入器对叙事/论说/对话三个体裁的边际贡献。
 */
const FILE = "src/engine/humanize.ts";
const original = readFileSync(FILE, "utf8");

const NARR = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。走到半路，遇见隔壁的小女孩蹲在水坑边叠纸船，裙角湿了一大片。

回到家，我妈正站在厨房窗前看雨。她头也没回，只说了句锅里热着汤。我把湿外套挂在门后，听见雨点砸在雨棚上的声音，忽然觉得这个下午格外安静。`;

const EXPO = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元，占 GDP 的比重达到了 41.8%。

综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等领域的研发投入；其次，企业需要重视数据资产的治理与运营；最后，企业需要培养复合型数字化人才。

最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有真正把数字化战略上升到企业核心战略层面，并脚踏实地去落地执行的企业，才能始终立于不败之地。`;

const DIALOG = `【场景：公司会议室，下午三点】
张总（项目经理）：这个季度的指标完成得怎么样了？
李工（前端负责人）：主流程已经联调完毕，还差两个边界用例。

张总（项目经理）：那明天能不能提测？客户那边催得挺紧。
李工（前端负责人）：可以，今晚我加个班收个尾，明早第一件事就同步给你。

【场景：测试工位，第二天上午】
王姐（测试主管）：提测之后记得同步一份变更清单给我，别又像上次漏了字段。
张总（项目经理）：收到，我让李工整理好发群里。`;

const CASES: Array<[string, string, string]> = [
  ["叙事", NARR, "narrative"],
  ["论说", EXPO, "main"],
  ["对话", DIALOG, "dialogue"],
];

async function measure(label: string) {
  // 每轮重新 import（清缓存）
  const mod = await import(`../src/engine/humanize.ts?t=${Date.now()}`);
  const { humanize, aiScore } = mod;
  const parts: string[] = [];
  for (const [name, text, genre] of CASES) {
    const out = humanize(text, { intensity: 0.9, zhuqueMode: true, genre, seed: 7 });
    const s = aiScore(out);
    parts.push(`${name}=${String(s.score).padStart(3)}(句式${String(s.structureHits).padStart(2)})`);
  }
  console.log(`  ${label.padEnd(38)} ${parts.join("  ")}`);
}

async function withPatch(label: string, from: string, to: string) {
  if (!original.includes(from)) {
    console.log(`  [SKIP] ${label} —— 锚点未找到`);
    return;
  }
  writeFileSync(FILE, original.replace(from, to));
  try {
    await measure(label);
  } finally {
    writeFileSync(FILE, original);
  }
}

console.log("注入器边际贡献 A/B 实验（0.9 档 seed=7）\n" + "=".repeat(76));
await measure("【基线】当前代码");

// A. 关 injectParentheticals
await withPatch("A. 关 injectParentheticals",
  "    result = injectParentheticals(result, zrng, 0.15 * intensity);",
  "    // result = injectParentheticals(result, zrng, 0.15 * intensity);");

// B. 关 injectOpinion
await withPatch("B. 关 injectOpinion",
  "    result = injectOpinion(result, zrng, 0.12 * intensity);",
  "    // result = injectOpinion(result, zrng, 0.12 * intensity);");

// C. 两个都关
await withPatch("C. 关 插话+观点",
  `    result = injectParentheticals(result, zrng, 0.15 * intensity);
    result = injectOpinion(result, zrng, 0.12 * intensity);`,
  `    // result = injectParentheticals(result, zrng, 0.15 * intensity);
    // result = injectOpinion(result, zrng, 0.12 * intensity);`);

// D. 关 injectParentheticNotes
await withPatch("D. 关 injectParentheticNotes",
  "    result = injectParentheticNotes(result, zrng, 0.08 * intensity);",
  "    // result = injectParentheticNotes(result, zrng, 0.08 * intensity);");

// E. 关 injectFragments
await withPatch("E. 关 injectFragments",
  "    result = injectFragments(result, zrng, 0.06 * intensity);",
  "    // result = injectFragments(result, zrng, 0.06 * intensity);");

// F. 关 SOFT_TAIL 句尾收束
await withPatch("F. 关 SOFT_TAIL 句尾收束",
  "        } else if (r < SOFT_ENDING_PROB * intensity + SOFT_TAIL_PROB * intensity) {",
  "        } else if (false) {");

// G. 关句尾软化(两个分支)
await withPatch("G. 关 句尾软化全部",
  `      if (!formalityGuard) {
        if (r < SOFT_ENDING_PROB * intensity && isCasual) {`,
  `      if (!formalityGuard) {
        if (false) {`);

console.log("\n【还原确认】");
await measure("还原后（应与基线一致）");
