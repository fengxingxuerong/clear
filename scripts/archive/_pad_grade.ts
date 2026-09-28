/**
 * 垫词表分级验证：哪些垫词是「引擎专属指纹」，哪些是「真人也用」？
 * 判据：在标定语料 _calib_corpus 的 HUMAN_SAMPLES 里出现 = 中性（误伤风险）；
 *       只在 MACHINE_SAMPLES 里出现 = 引擎专属（可安全判分）。
 */
import { HUMAN_SAMPLES, MACHINE_SAMPLES } from "./_calib_corpus.ts";

const CANDIDATES = [
  "说真的", "说实话", "讲真", "要我说", "说白了", "我寻思", "老实讲", "不瞒你说",
  "你别说", "按我的经验", "其实", "说到底", "具体来说", "换句话说", "简单说",
  "总体而言", "坦白讲", "老实说", "严格来说", "客观来讲", "有一说一", "不吹不黑",
  "平心而论", "反正", "所以说", "总之", "总的来说", "反过来看", "客观讲", "往实了说",
  "话又说回来", "我寻思着", "我琢磨着", "我觉得", "我认为", "在我看来", "以我的经验",
  "据我观察", "按我的理解", "我的看法是", "我感觉", "这么说吧", "细想下", "说句掏心窝的",
];

const humanText = HUMAN_SAMPLES.map((s) => s.text).join("\n");
const machineText = MACHINE_SAMPLES.map((s) => s.text).join("\n");

console.log("垫词分级（score = 机器侧命中 - 人侧命中）");
console.log("=".repeat(72));
const rows: Array<[string, number, number, number]> = [];
for (const w of CANDIDATES) {
  const h = humanText.split(w).length - 1;
  const m = machineText.split(w).length - 1;
  rows.push([w, h, m, m - h]);
}
rows.sort((a, b) => b[3] - a[3]);
for (const [w, h, m, d] of rows) {
  const tag = h === 0 && m > 0 ? "引擎专属" : h > 0 && m === 0 ? "真人专属(误伤!)" : h > 0 && m > 0 ? "共用" : "双方均无";
  console.log(`  ${w.padEnd(12)} 人=${String(h).padStart(2)} 机=${String(m).padStart(2)} 差=${String(d).padStart(3)}  ${tag}`);
}
