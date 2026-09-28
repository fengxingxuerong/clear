/**
 * 分层归因 2：把「本地引擎层」的垫词注入单独量化。
 * 本地引擎的注入点：
 *   - replaceOpener（OPENERS 表）→ 句首改写成口语引导词
 *   - INTERJECTIONS（INTERJECTION_RATE=0.22）→ 句首硬插垫词
 *   - splitOnConnectors → 拆句可能产生孤立连接词
 * 手法：逐行调用这些函数，对比原文/输出。
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";
import { INTERJECTIONS } from "../src/engine/humanize-vocab.ts";
import { PAD_WORDS } from "../src/engine/humanize-text.ts";

const NARR = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。走到半路，遇见隔壁的小女孩蹲在水坑边叠纸船，裙角湿了一大片。

回到家，我妈正站在厨房窗前看雨。她头也没回，只说了句锅里热着汤。我把湿外套挂在门后，听见雨点砸在雨棚上的声音，忽然觉得这个下午格外安静。`;

const EXPO = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元，占 GDP 的比重达到了 41.8%。

综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等领域的研发投入；其次，企业需要重视数据资产的治理与运营；最后，企业需要培养复合型数字化人才。

最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有真正把数字化战略上升到企业核心战略层面，并脚踏实地去落地执行的企业，才能始终立于不败之地。`;

/** 句首垫词检测：句子以垫词 + 逗号开头 */
const HEAD_PAD = /^(?:说真的|说实话|讲真|要我说|说白了|我寻思|老实讲|不瞒你说|你别说|按我的经验|反正|所以说|总之|总的来说|反过来看|平心而论|其实|说到底|具体来说|换句话说|简单说|总体而言|坦白讲|老实说|严格来说|客观来讲|有一说一|不吹不黑|往深了说|简单来说|你细品|凭良心说|说句实在话|往实了说|话又说回来|我琢磨着|我寻思着|我觉得|我认为|在我看来|以我的经验|据我观察|按我的理解|我的看法是|我感觉|这么说吧|客观讲|细想下|说句掏心窝的)[，,]/;

function countHeadPad(text: string): { n: number; total: number; words: string[] } {
  const sents = text.split(/(?<=[。！？])|\n+/).map((s) => s.trim()).filter(Boolean);
  const words: string[] = [];
  let n = 0;
  for (const s of sents) {
    const m = s.match(HEAD_PAD);
    if (m) { n++; words.push(m[0]); }
  }
  return { n, total: sents.length, words };
}

console.log("本地引擎层垫词注入量化\n" + "=".repeat(76));

for (const [name, src, genre] of [
  ["叙事", NARR, "narrative"],
  ["论说", EXPO, "main"],
] as const) {
  const o = countHeadPad(src);
  console.log(`\n【${name}】原文: 句首垫词 ${o.n}/${o.total}`);
  for (const style of ["casual", "plain", "academic"] as const) {
    // 关掉朱雀层，只看本地引擎
    const localOnly = humanize(src, { intensity: 0.9, zhuqueMode: false, genre, style, seed: 7 });
    const l = countHeadPad(localOnly);
    const s = aiScore(localOnly);
    console.log(`  ${style.padEnd(9)} 本地引擎: 句首垫词 ${l.n}/${l.total}  aiScore=${String(s.score).padStart(3)} 句式=${String(s.structureHits).padStart(3)} 病词=${s.brokenHits}`);
    console.log(`            ${l.words.join(" ")}`);
  }

  // INTERJECTIONS 表命中统计
  const localCasual = humanize(src, { intensity: 0.9, zhuqueMode: false, genre, style: "casual", seed: 7 });
  const hit = INTERJECTIONS.filter((w) => localCasual.includes(w));
  console.log(`  INTERJECTIONS 命中: ${hit.length}/${INTERJECTIONS.length}  ${hit.join("/")}`);
  const padHit = PAD_WORDS.filter((w) => localCasual.includes(w));
  console.log(`  PAD_WORDS 命中:      ${padHit.length}/${PAD_WORDS.length}  ${padHit.join("/")}`);
}
