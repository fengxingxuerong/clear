/** 坐实"语体书面化"维度：对比人写稿与变异稿的口语/书面标记密度，与 aiScore 的变化方向对照 */
import { readFileSync } from "node:fs";
import { aiScore } from "../../src/engine/humanize.ts";

const COLLOQ =
  /(?:就|还挺|结果|顺手|赶紧|好像|折腾|不太|没喝完|唉|吧|呢|啊|呀|啥|妥了|一逛|停不下来)/g;
const FORMAL = /(?:之后|随后|于是|便|对|道谢|似乎|较为|正在|随后|一种|一位|一支|不太健康|较为)/g;
const count = (s: string, re: RegExp) => (s.match(re) || []).length;

const j = JSON.parse(readFileSync("artifacts/mutator/pairs.json", "utf8"));
console.log("体裁/档      口语标记 书面标记   aiScore   aiScore 方向");
for (const p of j.pairs) {
  if (!p.variant) continue;
  const hc = count(p.human, COLLOQ),
    vc = count(p.variant, COLLOQ);
  const hf = count(p.human, FORMAL),
    vf = count(p.variant, FORMAL);
  const hs = aiScore(p.human).score,
    vs = aiScore(p.variant).score;
  const style = vf > hf && vc < hc ? "书面化↑口语↓" : "语体未变";
  const dir = vs > hs ? "分数↑一致" : vs < hs ? "分数↓矛盾" : "分数持平";
  console.log(
    `${(p.genre + "/" + p.level).padEnd(13)} ${String(hc).padStart(3)}→${String(vc).padEnd(3)} ${String(hf).padStart(4)}→${String(vf).padEnd(4)}   ${String(hs).padStart(3)}→${String(vs).padEnd(3)}   ${style} ｜ ${dir}`,
  );
}
