/**
 * 句首垫词 vs 句中插话：谁的判别力更强？
 * 看真人写与引擎输出在「句首垫词密度」上的分布差异。
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";

const HEAD_PAD = /(?:^|[。！？\n]\s*)(?:说真的|说实话|讲真|要我说|说白了|我寻思|老实讲|不瞒你说|你别说|按我的经验|其实|说到底|具体来说|换句话说|简单说|总体而言|坦白讲|老实说|严格来说|客观来讲|有一说一|不吹不黑|平心而论|反正|所以说|总之|总的来说|反过来看)[，,]/g;

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

const HUMAN = `周末去了趟菜市场。西红柿涨到六块五一斤，摊主说连着下了半个月雨，大棚里光照不够。我挑了几个软硬适中的，又顺路买了半斤饺子皮。

回来的路上太阳出来了，晒得后背发烫。路过巷口，看见邻居家的猫趴在墙头打盹，尾巴有一搭没一搭地甩。我站了一会儿，才慢悠悠往家走。

到家把菜洗了，水龙头的水凉得扎手。窗户开着，能听见楼下小孩在吵，也不知道在争什么。我想，这样一下午，其实也挺好。`;

function countHead(text: string) {
  return (text.match(HEAD_PAD) ?? []).length;
}

console.log("句首垫词数量对比（引擎输出 vs 真人写）");
for (const [label, src, genre] of [
  ["论说", EXPO, "main"],
  ["对话", DIALOG, "dialogue"],
  ["人写", HUMAN, "humanHand"],
] as const) {
  const out = humanize(src, { intensity: 0.9, zhuqueMode: true, genre, seed: 7 });
  console.log(`  ${label}: 原文 ${countHead(src)} 处 → 引擎输出 ${countHead(out)} 处  (aiScore ${aiScore(src).score}→${aiScore(out).score})`);
}

console.log("\n不同 seed 下论说体裁的句首垫词数（看抖动范围）");
const counts: number[] = [];
for (let s = 1; s <= 30; s++) {
  const out = humanize(EXPO, { intensity: 0.9, zhuqueMode: true, genre: "main", seed: s });
  counts.push(countHead(out));
}
console.log(`  30 seeds: min=${Math.min(...counts)} max=${Math.max(...counts)} avg=${(counts.reduce((a, b) => a + b, 0) / 30).toFixed(1)}`);
console.log(`  分布:`, counts.join(","));
