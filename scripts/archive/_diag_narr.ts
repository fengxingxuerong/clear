import { humanize } from "../src/engine/humanize.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";

const NARR = `老城区那条巷子，我小时候天天走。石板路被踩得发亮，墙角长着青苔，一到梅雨季就滑得很。
巷口有家修鞋铺，老师傅姓周，戴副老花镜，手里的锥子来回穿梭。他修一双鞋收五块，从不还价。
后来巷子拆了。周师傅的铺子搬到了三条街外，我去看过一次，门口挂着新招牌，字还是他自己写的。他抬头看我，愣了一下，说，长这么大了。`;

for (const [n, o] of [["原文", null], ["0.5", 0.5], ["0.7", 0.7], ["0.9", 0.9]] as Array<[string, number | null]>) {
  const t = o === null ? NARR : humanize(NARR, { intensity: o, zhuqueMode: true, style: "casual", seed: 20260826 } as never);
  const s = aiScore(t);
  console.log(`\n===== ${n}  score=${s.score} n=${s.sentenceCount} broken=${s.brokenHits} struct=${s.structureHits} =====`);
  console.log(t);
}
