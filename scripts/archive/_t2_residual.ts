/**
 * scripts/_t2_residual.ts —— T2 plain 档残留 16 分的精确定位（临时）
 *
 * _t2_plain.ts 显示剔除「哈」后，T2 最高分降到 30（句式 16）。
 * 30 分样本形如：
 *   「…它把握了需求呀。它支撑了可持续发展。说到底，这是战略选择。」
 * 需确认这 16 分来自哪一项：3a 语气词？3b 孤立连接词？3d 垫词独句？3e 污染率？
 * 手法：拿到高分样本后逐项打点（把 text 拆给 aiScore 的各检测器）。
 */
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";

const T2 = "在当今时代背景下，数字化转型已经成为企业发展的必由之路。首先，它提升了效率。其次，它把握了需求。最后，它支撑了可持续发展。综上所述，这是战略选择。";

const rows: Array<{ it: number; seed: number; sc: number; out: string }> = [];
for (const it of [0.6, 0.7, 0.8, 0.9]) {
  for (let seed = 1; seed <= 20; seed++) {
    const out = humanize(T2, { intensity: it, seed, genre: "main", style: "plain", zhuqueMode: true });
    rows.push({ it, seed, sc: aiScore(out).score, out });
  }
}
rows.sort((a, b) => b.sc - a.sc);

// 逐项手工检测
const tailParticleRe = /[\d%．.、，]?[嗯啊哦嗨咳呣啧诶哈]{1,2}[。！？]/g;
const orphanRe = /(?:说到底|具体来说|总的来说|换句话说|简单说|总体而言|归根到底|归根结底|一言以蔽之|综上所述|由此可见|值得一提的是|换言之|简而言之|与此同时|在此基础上|从长远来看|本质上|核心在于)[。！？]/g;
const padSoloRe = /(?:就这样|你懂的|说白了|讲真|说真的|老实讲|行吧|好吧|是啊|你说得对|是这个理|随你怎么说|反正|往实了说|往好听了说|说难听点|夸张点说|不瞒你说|这么说吧|差不多得了)[。！？]/g;

for (const r of rows.slice(0, 5)) {
  const bd = aiScore(r.out);
  const tp = (r.out.match(tailParticleRe) ?? []).length;
  const oc = (r.out.match(orphanRe) ?? []).length;
  const ps = (r.out.match(padSoloRe) ?? []).length;
  console.log(`i=${r.it} seed=${r.seed} score=${r.sc} [句式=${bd.structureHits}]`);
  console.log(`  ${r.out}`);
  console.log(`  3a语气词=${tp}  3b孤立连接=${oc}  3d垫词独句=${ps}  套话=${bd.formulaicHits} avgLen=${bd.avgLen.toFixed(1)}`);
  console.log("");
}
