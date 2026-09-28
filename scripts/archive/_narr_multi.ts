import { humanize, aiScore } from "../src/engine/humanize.ts";

const NARR_MULTI = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。走到半路，遇见隔壁的小女孩蹲在水坑边叠纸船，裙角湿了一大片。

回到家，我妈正站在厨房窗前看雨。她头也没回，只说了句锅里热着汤。我把湿外套挂在门后，听见雨点砸在雨棚上的声音，忽然觉得这个下午格外安静。`;

const before = aiScore(NARR_MULTI);
console.log(`原文 score=${before.score} avgLen=${before.avgLen} 句式=${before.structureHits} 病词=${before.brokenHits}`);
const out = humanize(NARR_MULTI, { intensity: 0.9, zhuqueMode: true, genre: "narrative", seed: 7 });
const after = aiScore(out);
console.log(`\n输出 score=${after.score} avgLen=${after.avgLen} 句式=${after.structureHits} 病词=${after.brokenHits}`);
console.log(out.replace(/\n+/g, " ⏎ "));
