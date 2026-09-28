/**
 * 段1 单段复现：为什么句号全被吃掉？
 * 用 humanizeSingle 无法直调（未导出），改为构造单段输入调 humanize（走 ≤1 段分支）。
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";

const P1 = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。`;

console.log(`原文：${P1}`);
console.log(`原文分句数：${P1.split(/(?<=[。！？])/).filter(Boolean).length}\n`);

for (const it of [0.6, 0.7, 0.8, 0.9, 1.0]) {
  for (let seed = 1; seed <= 3; seed++) {
    const out = humanize(P1, { intensity: it, zhuqueMode: true, genre: "narrative", seed });
    const n = out.split(/(?<=[。！？])/).filter(Boolean).length;
    const dots = (out.match(/。/g) || []).length;
    const commas = (out.match(/，/g) || []).length;
    console.log(`${it.toFixed(1)} seed=${seed}: 句数${n} 句号${dots} 逗号${commas} score=${aiScore(out).score}`);
    if (n === 1 && seed === 1) console.log(`   → ${out}`);
  }
}
