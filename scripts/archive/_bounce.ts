/**
 * scripts/_bounce.ts —— 补偿性反弹量化（临时）
 *
 * 观察：_ceiling.ts 里「论说-垫词友好」原文 56 分（已远超判定线 29），
 * 跑完引擎反而升到 82 分。这不是"没改好"，是"越改越差"。
 * 本脚本量化反弹的规模与分布：
 *   - 原文分档位 × 改后分档位，看反弹发生在哪些区间
 *   - 反弹增量（after - before）
 *   - 统计"原文已超标（>=29）却被改得更高"的比例
 */
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";

const TEXTS: Array<{ id: string; before: number; genre: "main" | "narrative" | "dialogue" | "humanHand"; raw: string }> = [];
const RAW: Array<{ text: string; genre: "main" | "narrative" | "dialogue" | "humanHand" }> = [
  { text: "说白了，这个问题的本质其实就是利益分配。你懂的，大家都不傻。说到底，还是要看谁能扛住压力。话说回来，这事儿也不是一天两天了。说白了，谁都不想吃亏。", genre: "main" },
  { text: "在当今时代背景下，数字化转型已经成为企业发展的必由之路。首先，它提升了效率。其次，它把握了需求。最后，它支撑了可持续发展。综上所述，这是战略选择。", genre: "main" },
  { text: "那是一个阳光明媚的下午，我漫步在熟悉的街道上。街道两旁的老树依然挺立。我不知不觉走到了那家老书店门前。店主是一位慈祥的老人。", genre: "narrative" },
  { text: "今天我们来讲讲这个话题。值得注意的是，这个问题很复杂。然而，我们不能忽视它。因此，我们需要认真对待。总的来说，这很重要。", genre: "main" },
];
for (let i = 0; i < RAW.length; i++) TEXTS.push({ id: `T${i + 1}`, before: aiScore(RAW[i].text).score, genre: RAW[i].genre, raw: RAW[i].text });

console.log("原文分:", TEXTS.map((t) => `${t.id}(${t.genre})=${t.before.toFixed(0)}`).join("  "));
console.log("");

for (const t of TEXTS) {
  const raw = t.raw;
  let up = 0;
  let down = 0;
  let flat = 0;
  let maxAfter = -1;
  let worstSeed = 0;
  let worstIt = 0;
  const afters: number[] = [];
  for (const it of [0.6, 0.7, 0.8, 0.9]) {
    for (let seed = 1; seed <= 20; seed++) {
      const out = humanize(raw, { intensity: it, seed, genre: t.genre, zhuqueMode: true });
      const a = aiScore(out).score;
      afters.push(a);
      if (a > t.before + 1) up++;
      else if (a < t.before - 1) down++;
      else flat++;
      if (a > maxAfter) {
        maxAfter = a;
        worstSeed = seed;
        worstIt = it;
      }
    }
  }
  const avg = afters.reduce((x, y) => x + y, 0) / afters.length;
  console.log(
    `${t.id}(${t.genre})  before=${t.before.toFixed(0)}  after(avg)=${avg.toFixed(1)}  max=${maxAfter.toFixed(0)}(i=${worstIt},seed=${worstSeed})` +
      `  升${up}/80 平${flat} 降${down}`,
  );
}
