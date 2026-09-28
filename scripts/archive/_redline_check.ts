/**
 * 红线检查：收敛后是否损失了「去套话能力」？是否引入新误伤？
 * 1. 套话清除能力：AI 套话原文 vs 0.9 档输出，套话项必须能降到接近 0
 * 2. 25 标定样本复验：真人写必须仍 < 29，引擎污染必须仍 >= 29
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";
import { ALL_SAMPLES } from "./_calib_corpus.ts";

console.log("=".repeat(76));
console.log("红线 1：去套话能力（AI 套话原文 → 0.9 档输出，formulaicHits 应趋零）");
console.log("=".repeat(76));

const AI_TEXTS: Array<[string, string]> = [
  ["论说·典型套话", `在当今社会，随着信息技术的迅猛发展，数字化转型已经成为企业发展的重要趋势。值得注意的是，这一趋势不仅改变了企业的运营模式，也深刻影响了整个行业的竞争格局。综上所述，企业必须积极拥抱数字化，才能在激烈的市场竞争中立于不败之地。`],
  ["公文·套话密集", `为进一步贯彻落实相关文件精神，切实提升工作效率，现就有关事项通知如下。首先，各部门要高度重视此项工作，充分认识其重要性与紧迫性。其次，要明确责任分工，确保各项措施落到实处。最后，要加强督促检查，及时发现并解决存在的问题。`],
  ["报告·套话+排比", `本年度工作取得了显著成效。一是业务规模稳步扩大，二是盈利能力持续提升，三是团队建设不断加强，四是风险管控更加有力。总的来看，各项指标均达到预期目标，为下一阶段发展奠定了坚实基础。`],
];

for (const [label, text] of AI_TEXTS) {
  const before = aiScore(text);
  const out = humanize(text, { intensity: 0.9, zhuqueMode: true, genre: "main", seed: 7 });
  const after = aiScore(out);
  const ok = after.formulaicHits <= Math.max(1, Math.floor(before.formulaicHits * 0.3));
  console.log(`  ${label}: 套话 ${before.formulaicHits} → ${after.formulaicHits}  ${ok ? "✅" : "⚠️"}   (aiScore ${before.score}→${after.score})`);
}

console.log("\n" + "=".repeat(76));
console.log("红线 2：25 标定样本复验（判定线 29）");
console.log("=".repeat(76));

const CUTOFF = 29;
let falsePos = 0, falseNeg = 0;
const humans: number[] = [], machines: number[] = [];
for (const s of ALL_SAMPLES) {
  const sc = aiScore(s.text).score;
  if (s.expect === "human") {
    humans.push(sc);
    if (sc >= CUTOFF) { falsePos++; console.log(`  ❌ 真人写被判机器: ${s.id} = ${sc}`); }
  } else {
    machines.push(sc);
    if (sc < CUTOFF) { falseNeg++; console.log(`  ❌ 机器稿被判真人: ${s.id} = ${sc}`); }
  }
}
console.log(`\n  真人写 (${humans.length}): max=${Math.max(...humans)} min=${Math.min(...humans)}`);
console.log(`  引擎污染 (${machines.length}): min=${Math.min(...machines)} max=${Math.max(...machines)}`);
console.log(`  分离间隙: [${Math.max(...humans)}, ${Math.min(...machines)}]`);
console.log(`  误判: 假阳性=${falsePos} 假阴性=${falseNeg}  →  ${falsePos + falseNeg === 0 ? "✅ 零错判" : "⚠️ 有错判"}`);
