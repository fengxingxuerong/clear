/**
 * 标定基线：在标定语料上跑当前 aiScore，看哪些样本越界。
 */
import { aiScore } from "../src/engine/humanize-metrics.ts";
import { ALL_SAMPLES } from "./_calib_corpus.ts";

let humanFail = 0;
let machineFail = 0;

console.log("ID".padEnd(26), "期望", "score", "套话", "病词", "句式", "burst", "avgLen", "结果");
console.log("-".repeat(104));

for (const s of ALL_SAMPLES) {
  const r = aiScore(s.text);
  const threshold = 29;
  const ok = s.expect === "human" ? r.score < threshold : r.score >= threshold;
  if (!ok) {
    if (s.expect === "human") humanFail++;
    else machineFail++;
  }
  console.log(
    s.id.padEnd(24),
    s.expect === "human" ? "人写" : "引擎",
    String(r.score).padStart(5),
    String(r.formulaicHits).padStart(4),
    String(r.brokenHits).padStart(4),
    String(r.structureHits).padStart(4),
    r.burstiness.toFixed(2).padStart(5),
    r.avgLen.toFixed(1).padStart(6),
    ok ? "  ✓" : "  ✗ 越界",
  );
}
console.log("-".repeat(104));
console.log(`真人写越界（误伤）= ${humanFail} / ${ALL_SAMPLES.filter((s) => s.expect === "human").length}`);
console.log(`引擎污染漏判 = ${machineFail} / ${ALL_SAMPLES.filter((s) => s.expect === "machine").length}`);
