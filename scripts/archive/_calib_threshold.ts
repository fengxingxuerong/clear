/**
 * 密度阈值扫描：找出能分开 HUMAN / MACHINE 的垫词密度阈值。
 * 关键假设：真人写的垫词是"点缀"，引擎是"堆砌"——差异在密度。
 */
import { ALL_SAMPLES } from "./_calib_corpus.ts";

const PAD = [
  "说真的", "其实", "说实话", "老实讲", "讲真", "说白了", "你别说", "要我说",
  "平心而论", "客观讲", "往实了说", "不瞒你说", "按我的经验", "话又说回来",
  "说到底", "总的来说", "具体来说", "换句话说", "简单说", "总体而言",
  "坦白讲", "说句实在话", "你懂的", "差不多得了", "就这样", "是啊", "哦对",
];

function padCount(text: string) {
  let n = 0;
  for (const p of PAD) n += text.split(p).length - 1;
  return n;
}

console.log("逐样本的「垫词数 / 每百字」：");
console.log("-".repeat(64));
const rows: { id: string; expect: string; n: number; len: number; per100: number }[] = [];
for (const s of ALL_SAMPLES) {
  const n = padCount(s.text);
  const per100 = Number(((n / s.text.length) * 100).toFixed(2));
  rows.push({ id: s.id, expect: s.expect, n, len: s.text.length, per100 });
  console.log(
    s.id.padEnd(24),
    s.expect === "human" ? "人写" : "引擎",
    `垫词=${n}`,
    `字数=${s.text.length}`,
    `密度=${per100}`,
  );
}

console.log("\n阈值扫描（密度 >= T 判为引擎）：");
console.log("阈值".padEnd(8), "人写误伤", "引擎命中", "综合错判");
console.log("-".repeat(48));
const H = rows.filter((r) => r.expect === "human");
const M = rows.filter((r) => r.expect === "machine");
for (const T of [1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]) {
  const hErr = H.filter((r) => r.per100 >= T).length;
  const mHit = M.filter((r) => r.per100 >= T).length;
  const mMiss = M.length - mHit;
  console.log(
    `>= ${T}`.padEnd(8),
    String(hErr).padStart(7),
    `${mHit}/${M.length}`.padStart(8),
    String(hErr + mMiss).padStart(8),
  );
}

console.log("\n只看「垫词绝对数 >= N 且密度 >= T」的组合：");
for (const N of [2, 3, 4]) {
  for (const T of [1.0, 2.0, 3.0]) {
    const hErr = H.filter((r) => r.n >= N && r.per100 >= T).length;
    const mHit = M.filter((r) => r.n >= N && r.per100 >= T).length;
    const mMiss = M.length - mHit;
    console.log(`  N>=${N} 且 密度>=${T}: 误伤=${hErr}  命中=${mHit}/${M.length}  综合错判=${hErr + mMiss}`);
  }
}
