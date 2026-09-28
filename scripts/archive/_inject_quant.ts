/**
 * 注入源量化：逐个注入器单独跑，看它往正文里塞了多少东西。
 *
 * 方法：对同一段文本，逐个"只开一个注入器"跑（通过 monkey-patch 计数），
 * 统计每个注入器在 0.9 档的产出量与其对 aiScore 的贡献。
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";

const NARR = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。走到半路，遇见隔壁的小女孩蹲在水坑边叠纸船，裙角湿了一大片。

回到家，我妈正站在厨房窗前看雨。她头也没回，只说了句锅里热着汤。我把湿外套挂在门后，听见雨点砸在雨棚上的声音，忽然觉得这个下午格外安静。`;

const EXPO = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元，占 GDP 的比重达到了 41.8%。

综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等领域的研发投入；其次，企业需要重视数据资产的治理与运营；最后，企业需要培养复合型数字化人才。

最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有真正把数字化战略上升到企业核心战略层面，并脚踏实地去落地执行的企业，才能始终立于不败之地。`;

/** 统计一段文本里的污染痕迹 */
const PAD = ["说真的", "说实话", "讲真", "要我说", "说白了", "我寻思", "老实讲", "不瞒你说", "你别说", "按我的经验", "反正", "所以说", "总之", "总的来说", "反过来看", "平心而论", "其实", "坦白讲", "老实说", "严格来说", "客观来讲", "有一说一", "不吹不黑", "往深了说", "简单来说", "你细品", "凭良心说", "说句实在话"];
const FRAG = ["就这样", "怎么说呢", "你懂的", "差不多得了", "懂的都懂", "无话可说", "行吧", "是啊", "哦对", "没别的意思", "话是这么说", "道理是这个道理", "也不是不行", "你别不信", "反正我信了"];
const PART = ["嗯", "啊", "哦", "嗨", "咳", "呣", "啧", "诶", "哈", "嗼", "呵"];
const PAREN = ["说实话", "说句不好听的", "你想想", "客观来讲", "往好听了说", "说难听点", "不吹不黑", "有一说一", "你细品", "严格来说", "真要说起来", "往深了说", "简单来说", "夸张点说", "讲道理", "凭良心说", "这玩意儿吧"];

function count(text: string, list: string[]) {
  let n = 0;
  for (const w of list) n += text.split(w).length - 1;
  return n;
}

function report(label: string, text: string) {
  const r = aiScore(text);
  return {
    label,
    score: r.score,
    pad: count(text, PAD),
    frag: count(text, FRAG),
    part: count(text, PART),
    paren: count(text, PAREN),
    struct: r.structureHits,
    broken: r.brokenHits,
    len: text.length,
  };
}

console.log("=== 注入产出量化（0.9 档，seed=7）===\n");
for (const [gname, src, genre] of [
  ["叙事", NARR, "narrative"],
  ["论说", EXPO, "main"],
] as const) {
  console.log(`【${gname}】原文: score=${aiScore(src).score} 字数=${src.length}`);
  const out = humanize(src, { intensity: 0.9, zhuqueMode: true, genre, seed: 7 });
  const r = report("0.9档-casual", out);
  console.log(
    `  0.9档: score=${r.score} 字数=${r.len} ` +
      `垫词=${r.pad} 碎片=${r.frag} 语气词=${r.part} 插入语=${r.paren} 句式分=${r.struct} 病词=${r.broken}`,
  );
  // 逐档对比
  for (const i of [0.35, 0.4, 0.5, 0.7, 0.9]) {
    const o = humanize(src, { intensity: i, zhuqueMode: true, genre, seed: 7 });
    const rr = report(`i=${i}`, o);
    console.log(
      `  i=${i}: score=${String(rr.score).padStart(3)} 垫词=${rr.pad} 碎片=${rr.frag} 语气词=${rr.part} 插入语=${rr.paren} 句式分=${String(rr.struct).padStart(3)}`,
    );
  }
  console.log();
}

console.log("=== 注入器逐个关闭的效果（论说，0.9 档）===\n");
// 通过 style 间接控制：casual 开全部；plain 关方言/碎片/括号/自问自答；academic 只留最少
for (const style of ["casual", "plain", "academic"] as const) {
  const out = humanize(EXPO, { intensity: 0.9, zhuqueMode: true, genre: "main", style, seed: 7 });
  const r = report(style, out);
  console.log(
    `  ${style.padEnd(9)}: score=${String(r.score).padStart(3)} 垫词=${r.pad} 碎片=${r.frag} 语气词=${r.part} 插入语=${r.paren} 句式分=${String(r.struct).padStart(3)}`,
  );
}
