/**
 * 拆解「句式分」的来源：50 分到底由哪几个 3a~3e 子项贡献？
 * 不搞清这个就改注入，等于闭眼开枪。
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";

const EXPO = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元，占 GDP 的比重达到了 41.8%。

综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等领域的研发投入；其次，企业需要重视数据资产的治理与运营；最后，企业需要培养复合型数字化人才。

最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有真正把数字化战略上升到企业核心战略层面，并脚踏实地去落地执行的企业，才能始终立于不败之地。`;

const NARR = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。走到半路，遇见隔壁的小女孩蹲在水坑边叠纸船，裙角湿了一大片。

回到家，我妈正站在厨房窗前看雨。她头也没回，只说了句锅里热着汤。我把湿外套挂在门后，听见雨点砸在雨棚上的声音，忽然觉得这个下午格外安静。`;

// --- 复刻 aiScore 各子项的计数逻辑（只算次数，不算分）---
const PAD_SENTENCE_WORDS = ["就这样", "怎么说呢", "反正就那样", "你懂的", "没别的意思", "话是这么说", "道理是这个道理", "也不是不行", "差不多得了", "懂的都懂", "你别不信", "这谁说得准呢", "也不是没有道理", "行吧", "随你怎么说", "反正我信了", "无话可说", "是啊", "哦对"];

function breakdown(text: string) {
  // 3a 句尾语气词
  const tail = (text.match(/[\d%．.、，]?[嗯啊哦嗨咳呣啧诶哈]{1,2}[。！？]/g) ?? []).length;
  // 3b 连接词孤立
  const ORPHAN = /(?:说到底|具体来说|总的来说|换句话说|简单说|总体而言|归根到底|归根结底|一言以蔽之|综上所述|由此可见|值得一提的是|换言之|简而言之|与此同时|在此基础上|从长远来看|本质上|核心在于)[。！？]/g;
  const orphan = (text.match(ORPHAN) ?? []).length;
  // 3c 错别字
  let typo = 0;
  for (const re of [/再去年/g, /再上个/g, /是实上/g, /大这?家/g, /时候候/g]) typo += (text.match(re) ?? []).length;
  // 3d 垫词独句
  let padSent = 0;
  for (const w of PAD_SENTENCE_WORDS) {
    const re = new RegExp(`(?:^|[。！？!?\\n]\\s*)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[。！？]`, "g");
    padSent += (text.match(re) ?? []).length;
  }
  // 3e 句级污染率
  const PAD = ["说真的", "说实话", "讲真", "要我说", "说白了", "我寻思", "老实讲", "不瞒你说", "你别说", "按我的经验", "反正", "所以说", "总之", "总的来说", "反过来看", "平心而论", "其实", "说到底", "具体来说", "换句话说", "简单说", "总体而言", "坦白讲", "老实说", "严格来说", "客观来讲", "有一说一", "不吹不黑", "往深了说", "简单来说", "你细品", "凭良心说", "说句实在话", "往实了说", "话又说回来", "我琢磨着", "我寻思着", "我觉得", "我认为", "在我看来", "以我的经验", "据我观察", "按我的理解", "我的看法是", "我感觉", "要我说", "这么说吧"];
  const PART = ["嗯", "啊", "哦", "嗨", "咳", "呣", "啧", "诶", "哈", "嗼", "呵"];
  const FRAG = ["就这样", "怎么说呢", "反正就那样", "你懂的", "没别的意思", "话是这么说", "道理是这个道理", "也不是不行", "差不多得了", "懂的都懂", "你别不信", "这谁说得准呢", "也不是没有道理", "行吧", "随你怎么说", "反正我信了", "无话可说", "是啊", "哦对"];
  const ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const PAD_ALT = PAD.map(ESC).join("|");
  const FRAG_ALT = FRAG.map(ESC).join("|");
  const PART_ALT = PART.map(ESC).join("|");
  const HEAD = new RegExp(`^(?:${PAD_ALT})[，,]`);
  const MID = new RegExp(`^.{4,}?(?:${PAD_ALT})[，,]`);
  const STACK = new RegExp(`(?:${PAD_ALT})[，,]\\s*(?:${PAD_ALT})[，,]`);
  const PARTRE = new RegExp(`[\\u4e00-\\u9fa5](?:${PART_ALT})[，,。！？]`);
  const FRAGRE = new RegExp(`^(?:${FRAG_ALT})[。！？]?$`);

  const sents = text.split(/(?<=[。！？])|\n+/).map((s) => s.trim()).filter((s) => s.length > 0);
  let polluted = 0;
  const pollutedSents: string[] = [];
  const reasons: Record<string, number> = { head: 0, mid: 0, stack: 0, part: 0, frag: 0 };
  for (const s of sents) {
    const bare = s.replace(/[。！？]+$/, "");
    const h = HEAD.test(s), m = MID.test(bare), st = STACK.test(s), pt = PARTRE.test(s), fr = FRAGRE.test(bare);
    if (h) reasons.head++;
    if (m) reasons.mid++;
    if (st) reasons.stack++;
    if (pt) reasons.part++;
    if (fr) reasons.frag++;
    if (h || m || st || pt || fr) { polluted++; pollutedSents.push(s.slice(0, 30)); }
  }
  return { tail, orphan, typo, padSent, total: sents.length, polluted, ratio: polluted / sents.length, reasons, pollutedSents };
}

for (const [name, src, genre] of [
  ["叙事", NARR, "narrative"],
  ["论说", EXPO, "main"],
] as const) {
  console.log(`\n${"=".repeat(74)}\n【${name}】`);
  for (const [label, text] of [
    ["原文", src],
    ["casual 0.9", humanize(src, { intensity: 0.9, zhuqueMode: true, genre, style: "casual", seed: 7 })],
    ["plain 0.9", humanize(src, { intensity: 0.9, zhuqueMode: true, genre, style: "plain", seed: 7 })],
  ] as const) {
    const b = breakdown(text);
    console.log(`\n${label}: aiScore=${aiScore(text).score}  句式分=${aiScore(text).structureHits}`);
    console.log(`  3a句尾语气=${b.tail}  3b连接词孤立=${b.orphan}  3c错别字=${b.typo}  3d垫词独句=${b.padSent}`);
    console.log(`  3e污染句=${b.polluted}/${b.total} (${b.ratio.toFixed(2)})  命中原因: 句首垫词=${b.reasons.head} 句中垫词=${b.reasons.mid} 堆叠=${b.reasons.stack} 语气词=${b.reasons.part} 碎片=${b.reasons.frag}`);
    if (b.pollutedSents.length) console.log(`  污染句样本: ${b.pollutedSents.slice(0, 3).join(" | ")}`);
  }
}
