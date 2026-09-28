/**
 * scripts/_inj_ab.ts —— 注入器 A/B 归因（临时）
 *
 * 假设：论说体裁下的 18~39% 升分率来自四个口语注入器。
 * 手法：同一文本 × 同一 seed 序列，跑两组：
 *   A) style="casual"（注入器全开，默认）
 *   B) style="academic"（注入器关闭）
 * 若 B 组的升分率/最高分显著低于 A 组，则注入器是唯一元凶。
 * 注意：academic 还会顺带关掉其它东西，故额外加一组
 *   C) zhuqueMode=false（完全跳过朱雀层，注入器也不跑）作交叉验证。
 */
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";

const CASES: Array<{ id: string; text: string }> = [
  { id: "T1-垫词堆叠", text: "说白了，这个问题的本质其实就是利益分配。你懂的，大家都不傻。说到底，还是要看谁能扛住压力。话说回来，这事儿也不是一天两天了。说白了，谁都不想吃亏。" },
  { id: "T2-标准AI", text: "在当今时代背景下，数字化转型已经成为企业发展的必由之路。首先，它提升了效率。其次，它把握了需求。最后，它支撑了可持续发展。综上所述，这是战略选择。" },
  { id: "T4-连接词", text: "今天我们来讲讲这个话题。值得注意的是，这个问题很复杂。然而，我们不能忽视它。因此，我们需要认真对待。总的来说，这很重要。" },
];

type Cfg = { name: string; style?: "casual" | "plain" | "academic"; zh: boolean };
const CFGS: Cfg[] = [
  { name: "A:casual+朱雀", style: "casual", zh: true },
  { name: "B:plain+朱雀", style: "plain", zh: true },
  { name: "C:academic+朱雀", style: "academic", zh: true },
];

for (const c of CASES) {
  const before = aiScore(c.text).score;
  console.log(`\n===== ${c.id}  before=${before} =====`);
  for (const cfg of CFGS) {
    let up = 0,
      down = 0,
      flat = 0,
      max = -1;
    const arr: number[] = [];
    for (const it of [0.6, 0.7, 0.8, 0.9]) {
      for (let seed = 1; seed <= 20; seed++) {
        const out = humanize(c.text, { intensity: it, seed, genre: "main", style: cfg.style, zhuqueMode: cfg.zh });
        const a = aiScore(out).score;
        arr.push(a);
        if (a > before + 1) up++;
        else if (a < before - 1) down++;
        else flat++;
        if (a > max) max = a;
      }
    }
    const avg = arr.reduce((x, y) => x + y, 0) / arr.length;
    console.log(`  ${cfg.name.padEnd(16)} avg=${avg.toFixed(1).padStart(5)} max=${max.toFixed(0).padStart(3)}  升${String(up).padStart(2)}/80 平${String(flat).padStart(2)} 降${String(down).padStart(2)}`);
  }
}
