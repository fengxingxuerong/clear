/**
 * human-corpus/audit.ts —— 审计外部抓来的"真人语料"是否真的像人写的 + 建立真人基线分布
 *
 * 用法：npx tsx artifacts/human-corpus/audit.ts
 *
 * ## 为什么必须审
 *
 * `calibration-data-v2-genres.json` 的教训：那里 3 段标为「原文」的样本，
 * 审计后发现**2 段本身就是 AI 腔**（套话 3~5 处、口语标记 0~3）。
 * 外部语料同样不能免审——**抓来的 ≠ 干净的**。
 *
 * ## 产出什么
 *
 * ① 每篇的套话密度 / 口语标记 / aiScore → 判定"像不像人写"
 * ② **真人基线的分布**（N 个数据点，取代此前"只有 1 段 381 字"的脆弱基线）
 * ③ 人读抽样（便于肉眼复核清洗质量）
 */
import { readFileSync } from "node:fs";
import { aiScore } from "../../src/engine/humanize.ts";

const DIR = "artifacts/human-corpus";
const CLICHE =
  /值得注意的是|综上所述|与此同时|不仅|而且|具有重要意义|进一步地?|需要指出的是|赋能|闭环|底层逻辑|总而言之|由此可见|毋庸置疑|不言而喻|在[^，。]{1,8}的背景下/g;
const COLLOQ =
  /(?:挺|好多|特别|好像|差不多|赶紧|连忙|顺手|折腾|掏出|瞅|搁|攒|磨|划得来|挤|翻|到底|用不着|一堆|还没|这事儿|什么鬼|一群|一股|立马|居然|竟然|愣是|非得)/g;

const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8")) as {
  items: { genre: string; title: string; file: string; chars: number }[];
};

interface Row {
  genre: string;
  title: string;
  chars: number;
  cliche: number;
  colloq: number;
  score: number;
  paras: number;
}

const rows: Row[] = [];
for (const it of manifest.items) {
  const raw = readFileSync(it.file, "utf8");
  // 去掉前 4 行头部（来源/URL/许可/抓取日期）
  const prose = raw.split("\n\n").slice(1).join("\n\n");
  rows.push({
    genre: it.genre,
    title: it.title,
    chars: prose.length,
    cliche: (prose.match(CLICHE) || []).length,
    colloq: (prose.match(COLLOQ) || []).length,
    score: aiScore(prose).score,
    paras: prose.split(/\n\s*\n/).filter((p) => p.trim().length > 40).length,
  });
}

console.log(`语料：${rows.length} 篇（中文维基百科 CC BY-SA 4.0）\n`);
console.log("体裁            条目        字数  段落  套话 口语/千字  aiScore  判定");
console.log("─".repeat(86));
let suspect = 0;
for (const r of rows) {
  const q = r.chars ? (r.colloq / r.chars) * 1000 : 0;
  const v = r.cliche >= 3 ? "⚠️ 套话过多" : r.colloq === 0 && r.cliche > 0 ? "⚠️ 偏规范化" : "✅";
  if (r.cliche >= 3) suspect++;
  console.log(
    `${r.genre.padEnd(14)} ${r.title.padEnd(10)} ${String(r.chars).padStart(5)} ${String(r.paras).padStart(4)} ` +
      `${String(r.cliche).padStart(4)} ${q.toFixed(1).padStart(7)} ${String(r.score).padStart(8)}  ${v}`,
  );
}

const sc = rows.map((r) => r.score);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sorted = [...sc].sort((a, b) => a - b);
console.log(`\n━━━ 真人基线分布（${rows.length} 个数据点）━━━`);
console.log(
  `  aiScore：均值 ${avg(sc).toFixed(1)}｜中位 ${sorted[Math.floor(sorted.length / 2)]}｜范围 ${sorted[0]} ~ ${sorted[sorted.length - 1]}`,
);
console.log(
  `  四分位：Q1 ${sorted[Math.floor(sorted.length * 0.25)]}｜Q2 ${sorted[Math.floor(sorted.length * 0.5)]}｜Q3 ${sorted[Math.floor(sorted.length * 0.75)]}`,
);
console.log(
  `  套话合计 ${rows.reduce((a, b) => a + b.cliche, 0)} 处｜口语合计 ${rows.reduce((a, b) => a + b.colloq, 0)} 处`,
);
console.log(`  套话密度 ≥3 处/篇的可疑篇数：${suspect}/${rows.length}`);

const first = manifest.items[0];
if (first) {
  const prose = readFileSync(first.file, "utf8").split("\n\n").slice(1).join("\n\n");
  console.log(`\n━━━ 人读抽样（${first.title}）━━━\n${prose.slice(0, 320)}`);
}
