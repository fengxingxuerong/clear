/**
 * mutator/measure-syntax.ts —— 验证新指标「句式工整度」能否补上 aiScore 的横向盲区
 *
 * 用法：
 *   npx tsx artifacts/mutator/measure-syntax.ts
 *   SYNTAX_PAIRS=artifacts/mutator/pairs-5lvl-27.json npx tsx artifacts/mutator/measure-syntax.ts
 *
 * ## 验收标准（事先定好，避免事后找理由）
 *
 * 关键数据集是 **heavyB**（只把句式改工整书面化、明令禁套话）——
 * 已知 aiScore 在这里**方向判反**（−21 ~ −36）。
 * 新指标如果在 heavyB 上方向正确（工整度升高），就是真的补上了盲区；
 * 如果它在 heavyB 上也判反，本指标就是废的，不能进产品。
 */
import { readFileSync } from "node:fs";
import { aiScore } from "../../src/engine/humanize.ts";
import { syntaxRegularity } from "../../src/engine/humanize-syntax.ts";

interface Pair {
  genre: string;
  level: string;
  run: number;
  human: string;
  variant: string;
  error?: string;
}

const FILES = (
  process.env.SYNTAX_PAIRS || "artifacts/mutator/pairs-ab.json,artifacts/mutator/pairs-5lvl-27.json"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const pairs: Pair[] = [];
const seen = new Set<string>();
for (const f of FILES) {
  const j = JSON.parse(readFileSync(f, "utf8")) as { pairs: Pair[] };
  for (const p of j.pairs) {
    if (!p.variant) continue;
    const k = `${p.genre}|${p.level}|${p.run}`;
    if (seen.has(k)) continue; // 两个文件里 light/medium/heavy 各有 3 run，重叠要去重
    seen.add(k);
    pairs.push(p);
  }
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const rows = pairs.map((p) => {
  const hs = aiScore(p.human).score;
  const vs = aiScore(p.variant).score;
  const hr = syntaxRegularity(p.human);
  const vr = syntaxRegularity(p.variant);
  return {
    genre: p.genre,
    level: p.level,
    aiDelta: vs - hs,
    synDelta: vr.score - hr.score,
    humanAi: hs,
    variantAi: vs,
    humanSyn: hr.score,
    variantSyn: vr.score,
  };
});

const groups = new Map<string, typeof rows>();
for (const r of rows) {
  const k = `${r.genre}|${r.level}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}

console.log(`样本 ${rows.length} 对（去重后）｜数据文件 ${FILES.join(", ")}\n`);
console.log(
  "体裁        档位    aiScore(人→AI)      Δ    │  句式工整度(人→AI)      Δ    │ ai判定 工整判定",
);
console.log("─".repeat(96));
for (const [k, rs] of groups) {
  const [g, lv] = k.split("|");
  const ai = avg(rs.map((r) => r.aiDelta));
  const sy = avg(rs.map((r) => r.synDelta));
  const aiOk = ai > 0;
  const syOk = sy > 0;
  console.log(
    `${g.padEnd(11)} ${lv.padEnd(7)} ${String(Math.round(avg(rs.map((r) => r.humanAi)))).padStart(3)}→${String(Math.round(avg(rs.map((r) => r.variantAi)))).padEnd(4)}` +
      `${(ai >= 0 ? "+" : "") + ai.toFixed(0)}`.padStart(6) +
      `   │  ${String(Math.round(avg(rs.map((r) => r.humanSyn)))).padStart(3)}→${String(Math.round(avg(rs.map((r) => r.variantSyn)))).padEnd(4)}` +
      `${(sy >= 0 ? "+" : "") + sy.toFixed(1)}`.padStart(7) +
      `   │  ${aiOk ? "✅" : "❌"}     ${syOk ? "✅" : "❌"}`,
  );
}

const aiOk = rows.filter((r) => r.aiDelta > 0).length;
const syOk = rows.filter((r) => r.synDelta > 0).length;
const either = rows.filter((r) => r.aiDelta > 0 || r.synDelta > 0).length;
console.log(`\n判别力（AI 化后指标升高 = 判对）`);
console.log(
  `  aiScore        ${aiOk}/${rows.length} = ${((aiOk / rows.length) * 100).toFixed(0)}%`,
);
console.log(
  `  句式工整度     ${syOk}/${rows.length} = ${((syOk / rows.length) * 100).toFixed(0)}%`,
);
console.log(
  `  两指标任一报警 ${either}/${rows.length} = ${((either / rows.length) * 100).toFixed(0)}%  ← 互补后的召回`,
);

// 假阳性检查：人写稿之间的分数波动（同为"人写"，工整度不该差太多）
const humanSyn = new Map<string, number>();
for (const r of rows) if (!humanSyn.has(r.genre)) humanSyn.set(r.genre, r.humanSyn);
const hv = [...humanSyn.values()];
console.log(
  `\n假阳性检查（同一段人写原文重复计算的波动应为 0）：${JSON.stringify(Object.fromEntries(humanSyn))}`,
);
console.log(`  极差 ${Math.max(...hv) - Math.min(...hv)}（不同体裁人写文本之间的差异，属正常）`);
