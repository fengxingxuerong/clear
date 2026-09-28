import { humanize, aiScore } from "../src/engine/humanize.ts";

const NARR = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。`;

console.log("叙事 0.40 档各 seed：");
for (let seed = 1; seed <= 5; seed++) {
  const out = humanize(NARR, { intensity: 0.4, zhuqueMode: true, genre: "narrative", seed });
  const s = aiScore(out);
  console.log(`  seed=${seed} → ${s.score} (句式${s.structureHits} 病词${s.brokenHits} avgLen${s.avgLen})`);
  if (s.score > 20) console.log(`     ${out.replace(/\n+/g, " / ").slice(0, 200)}`);
}

console.log("\n叙事 0.35 档各 seed（对照）：");
for (let seed = 1; seed <= 5; seed++) {
  const out = humanize(NARR, { intensity: 0.35, zhuqueMode: true, genre: "narrative", seed });
  const s = aiScore(out);
  console.log(`  seed=${seed} → ${s.score} (句式${s.structureHits})`);
}
