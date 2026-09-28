/**
 * 叙事高档位复扫 + 句中垫词归因。
 * 目的：确认斜坡后 0.60~1.00 档残余污染的真凶，并验证「是否该用 skipSelfQA 挡句中插话」。
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";

const NARR = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。`;

const PAD_INLINE = ["坦白讲", "在我看来", "我个人的看法", "往好听了说", "说真的", "讲真", "实话实说"];

console.log("叙事高清档 · 句中垫词归因（10 seed）\n" + "=".repeat(70));
for (const it of [0.6, 0.7, 0.8, 0.9, 1.0]) {
  let sum = 0;
  let max = 0;
  const hitWords: Record<string, number> = {};
  for (let seed = 1; seed <= 10; seed++) {
    const out = humanize(NARR, { intensity: it, zhuqueMode: true, genre: "narrative", seed });
    const s = aiScore(out);
    sum += s.score;
    if (s.score > max) max = s.score;
    for (const w of PAD_INLINE) {
      if (out.includes(w)) hitWords[w] = (hitWords[w] ?? 0) + 1;
    }
  }
  const hits = Object.entries(hitWords)
    .map(([w, c]) => `${w}×${c}`)
    .join(" ");
  console.log(`  ${it.toFixed(2)}: avg ${(sum / 10).toFixed(1)}  max ${max}  垫词: ${hits || "无"}`);
}
