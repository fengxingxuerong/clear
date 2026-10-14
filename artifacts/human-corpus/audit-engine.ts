/**
 * human-corpus/audit-engine.ts —— **引擎行为审计**：它到底改了什么，改得对不对
 *
 * 用法：npx tsx artifacts/human-corpus/audit-engine.ts
 *
 * ## 为什么在测完"分数"之后还要测这个
 *
 * 今天的实验全部围绕 aiScore 转了 4 圈，最后落到一句结论：
 * **分数只认词表命中的套话，不认语体**。可分数只是**代理指标**，
 * 用户真正关心的是另一件事——
 *
 *     引擎把这些真人文本改完之后，**读起来是不是真的更像人写的**？
 *
 * 这个问题的答案**不能从分数反推**（今天已经证过一次：分数涨/跌与质量不总是同向）。
 * 所以直接看改动清单：原词 → 新词，改了多少、有没有改坏。
 *
 * ## 输出
 *
 * ① 改动密度（每千字改了多少处）
 * ② 高频替换对 Top N（人工核对"这些替换自然吗"）
 * ③ 规则依据分布（哪些规则在起作用）
 * ④ 人读抽样：原文 vs 产出（同段并排，便于肉眼判断）
 * ⑤ **可疑改动**筛查：会让中文变别扭的几类模式（见 SUSPECT 注释）
 */
import { readFileSync } from "node:fs";
import { humanize } from "../../src/engine/humanize.ts";
import { explainChanges, type ExplainItem } from "../../src/engine/explain.ts";
import { aiScore } from "../../src/engine/humanize.ts";

const DIR = "artifacts/human-corpus";
const INTENSITY = Number(process.env.AUDIT_INTENSITY || "0.9");
const SEED = 20260905;

const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8")) as {
  items: { genre: string; title: string; file: string }[];
};

interface Stat {
  title: string;
  chars: number;
  before: number;
  after: number;
  changes: ExplainItem[];
}

const stats: Stat[] = [];
for (const it of manifest.items) {
  const raw = readFileSync(it.file, "utf8");
  const prose = raw.split("\n\n").slice(1).join("\n\n");
  const out = humanize(prose, { intensity: INTENSITY, seed: SEED });
  const changes = explainChanges(prose, out);
  stats.push({
    title: it.title,
    chars: prose.length,
    before: aiScore(prose).score,
    after: aiScore(out).score,
    changes,
  });
}

const all = stats.flatMap((s) => s.changes);
console.log(`引擎行为审计｜${stats.length} 篇真人文本｜intensity=${INTENSITY} seed=${SEED}\n`);

const totalChars = stats.reduce((a, b) => a + b.chars, 0);
console.log("体裁条目      字数  分数(前→后)   改动处数  处/千字");
console.log("─".repeat(70));
for (const s of stats) {
  if (!s.changes.length) continue;
  console.log(
    `${s.title.padEnd(12)} ${String(s.chars).padStart(6)} ${String(s.before).padStart(4)}→${String(s.after).padEnd(5)} ${String(s.changes.length).padStart(8)} ` +
      `${((s.changes.length / s.chars) * 1000).toFixed(2).padStart(9)}`,
  );
}
console.log(
  `\n合计：${totalChars} 字，改动 ${all.length} 处（${((all.length / totalChars) * 1000).toFixed(2)} 处/千字）`,
);

// 规则依据分布
const byBasis = new Map<string, number>();
for (const c of all) byBasis.set(c.basis, (byBasis.get(c.basis) ?? 0) + 1);
console.log("\n━━━ 规则依据分布（哪些规则在起作用）━━━");
for (const [b, n] of [...byBasis.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(5)}  ${b.slice(0, 78)}`);
}

// 高频替换对
const pairs = new Map<string, number>();
for (const c of all) {
  const k = `「${c.before.slice(0, 14)}」→「${c.after.slice(0, 14)}」`;
  pairs.set(k, (pairs.get(k) ?? 0) + 1);
}
console.log("\n━━━ 高频改动对 Top 25（人工核对自然度）━━━");
for (const [k, n] of [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}

/**
 * 可疑改动筛查：这几种模式容易让中文变别扭或改错意思。
 * 命中不等于错，只是**值得人看一眼**的东西。
 */
const SUSPECT: [string, RegExp][] = [
  ["替换后语气变重（书面化过头）", /^(了|着|过)$|^很|^挺/],
  ["可能换掉了具体量词/数字", /\d/],
  ["可能引入公文腔", /进一步|从而|进而|以此|基于|通过.{0,4}的方式/],
  ["可能过度替换虚词", /^[的地得]$|了$/],
];
console.log("\n━━━ 可疑改动筛查（命中≠有问题，只给人看）━━━");
for (const [label, re] of SUSPECT) {
  const hits = all.filter((c) => re.test(c.after ?? ""));
  console.log(`  ${label}：${hits.length} 处`);
  for (const h of hits.slice(0, 3))
    console.log(
      `      「${h.before.slice(0, 16)}」→「${h.after.slice(0, 16)}」｜${h.reason.slice(0, 30)}`,
    );
}

console.log("\n━━━ 人读抽样（原文 vs 产出，同段并排）━━━");
const sample = stats.find((s) => s.changes.length > 0);
if (sample) {
  const raw = readFileSync(
    `${DIR}/${manifest.items.find((i) => i.title === sample.title)!.file}`,
    "utf8",
  );
  const prose = raw.split("\n\n").slice(1).join("\n\n");
  const out = humanize(prose, { intensity: INTENSITY, seed: SEED });
  const i = sample.changes[0].before.length;
  const at = Math.max(0, prose.indexOf(sample.changes[0].before.slice(0, 6)) - 60);
  console.log(`【${sample.title}】改动处：`);
  console.log(`原文：…${prose.slice(at, at + 220)}…`);
  const oAt = Math.max(0, out.indexOf(sample.changes[0].after.slice(0, 6)) - 60);
  console.log(`产出：…${out.slice(oAt, oAt + 220)}…`);
}
