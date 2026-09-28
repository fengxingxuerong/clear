/**
 * A/B：叙事高档位下，用 skipSelfQA 扩展挡住 injectParentheticals/injectOpinion（句中分支）是否净收益。
 * 关键：要同时看 aiScore 与 avgLen/句式，确认 boost 没有反扑。
 * 手法：不直接改源码，复刻 humanize 的调用序列做对照太重；
 *      改为临时改源码前先记录基线，改后对比。此脚本只输出基线。
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";

const NARR = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。`;

console.log("基线（当前实现）· 叙事 0.60~1.00 · 20 seed");
for (const it of [0.6, 0.8, 1.0]) {
  const rows: string[] = [];
  let sum = 0;
  let max = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const out = humanize(NARR, { intensity: it, zhuqueMode: true, genre: "narrative", seed });
    const s = aiScore(out);
    sum += s.score;
    if (s.score > max) {
      max = s.score;
      rows.splice(0, rows.length, `seed=${seed} score=${s.score} avgLen=${s.avgLen} 句式=${s.structureHits}`);
    }
  }
  console.log(`  ${it.toFixed(2)}: avg ${(sum / 20).toFixed(1)}  max ${max}  最差样本: ${rows[0]}`);
}
