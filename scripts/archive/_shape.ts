import { humanize } from "../src/engine/humanize.ts";

const P1 = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。`;
const P2LONG = `我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。走到半路，遇见隔壁的小女孩蹲在水坑边叠纸船，裙角湿了一大片。`;

const n = (t: string) => t.split(/\n{2,}/)[0].split(/(?<=[。！？])/).filter(Boolean).length;

console.log("同一段文本 · 不同调用形态：");
for (const it of [0.3, 0.5, 0.6, 0.9]) {
  const a = humanize(P1, { intensity: it, zhuqueMode: false, genre: "narrative", seed: 1 });
  const b = humanize(P1 + "\n\n" + P2LONG, { intensity: it, zhuqueMode: false, genre: "narrative", seed: 1 });
  console.log(`  ${it.toFixed(1)}: 单段第1段=${n(a)}句   双段第1段=${n(b)}句`);
}
console.log("\n无 genre（自动识别）双段：");
const c = humanize(P1 + "\n\n" + P2LONG, { intensity: 0.9, zhuqueMode: false, seed: 1 });
console.log(`  自动识别第1段=${n(c)}句`);
