/**
 * 全档位稳定性：收敛后，各 intensity × 各体裁 × 多 seed 是否有异常点？
 * 关注：① 单调性（强度越高不该越干净）② 极值（有无突然爆分）③ 去套话能力是否全档保持
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";
type GenreLike = "main" | "narrative" | "dialogue" | "humanHand";

const SAMPLES: Array<[string, string, GenreLike]> = [
  ["论说", `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元，占 GDP 的比重达到了 41.8%。

综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等领域的研发投入；其次，企业需要重视数据资产的治理与运营；最后，企业需要培养复合型数字化人才。`, "main"],
  ["叙事", `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。`, "narrative"],
  ["人写", `周末去了趟菜市场。西红柿涨到六块五一斤，摊主说连着下了半个月雨，大棚里光照不够。我挑了几个软硬适中的，又顺路买了半斤饺子皮。

回来的路上太阳出来了，晒得后背发烫。路过巷口，看见邻居家的猫趴在墙头打盹，尾巴有一搭没一搭地甩。`, "humanHand"],
];

const INTENSITIES = [0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

console.log("全档位 × 5 seed 扫描（输出 score 区间 + 均值）\n" + "=".repeat(78));
for (const [name, text, genre] of SAMPLES) {
  const base = aiScore(text);
  console.log(`\n【${name}】原文 aiScore=${base.score}  套话=${base.formulaicHits}`);
  for (const it of INTENSITIES) {
    const scores: number[] = [];
    const fHits: number[] = [];
    for (let seed = 1; seed <= 5; seed++) {
      const out = humanize(text, { intensity: it, zhuqueMode: true, genre, seed });
      const s = aiScore(out);
      scores.push(s.score);
      fHits.push(s.formulaicHits);
    }
    const min = Math.min(...scores), max = Math.max(...scores);
    const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
    const fAvg = (fHits.reduce((a, b) => a + b, 0) / fHits.length).toFixed(1);
    const flag = max > base.score + 20 ? " ⚠️ 爆分" : max <= base.score ? " ✅" : "";
    console.log(`  ${it.toFixed(2)}: score ${String(min).padStart(3)}~${String(max).padStart(3)} (avg ${avg.padStart(4)})  套话均值=${fAvg}${flag}`);
  }
}
