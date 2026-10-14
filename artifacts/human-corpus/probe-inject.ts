/**
 * human-corpus/probe-inject.ts —— 判别力实验（20 个真人样本 × 确定性套话注入，零 LLM 调用）
 *
 * 用法：npx tsx artifacts/human-corpus/probe-inject.ts
 *
 * ## 为什么这个实验现在才做得起
 *
 * 此前所有判别力结论都压在 **1 段 381 字**的真人文本上，一个数据点撑不住任何统计。
 * 抓来 20 篇（17 万字）中文维基百科正文后，才有样本量做这件事。
 *
 * ## 为什么用「确定性注入」而不是 LLM 变异
 *
 * LLM 反向 AI 化会**偷偷删内容**（实测 dialogue 被删 28% 字）——样本不干净，
 * 结论不成立（这个坑已经踩过一次）。确定性注入可控、可复现、零额度。
 *
 * ## 回答的问题
 *
 * 在**真实的、体裁多样的**真人文本上，注入 AI 特征后 aiScore 是否系统性升高？
 *   · 升高且一致 → aiScore 对真人语料有判别力
 *   · 不一致/不升高 → 分数不由"像不像 AI 写"决定（那 aiScore 到底在测什么？）
 *
 * 顺带测第二个维度：**注入语体书面化**（另一组对照），验证两类特征是否都被覆盖。
 */
import { readFileSync } from "node:fs";
import { aiScore } from "../../src/engine/humanize.ts";

const DIR = "artifacts/human-corpus";

/** AI 套话：插到段首，模拟"AI 加了总结/过渡" */
const CLICHES = [
  "值得注意的是，",
  "综上所述，",
  "与此同时，",
  "不仅如此，",
  "需要指出的是，",
  "进一步地看，",
];
/** 语体书面化：口语 → 等义书面词（确定性、只换词面） */
const STYLE_MAP: [RegExp, string][] = [
  [/挺多/g, "较多"],
  [/挺好的?/g, "尚可"],
  [/好多/g, "大量"],
  [/特别/g, "尤其"],
  [/差不多/g, "大致"],
  [/好像/g, "似乎"],
  [/赶紧/g, "随即"],
  [/连忙/g, "当即"],
  [/顺手/g, "随手"],
  [/折腾/g, "反复处置"],
  [/瞅/g, "看"],
  [/到底/g, "究竟"],
  [/用不着/g, "不需要"],
  [/一堆/g, "一批"],
  [/还没/g, "尚未"],
];

function injectCliche(text: string, perPara: number): string {
  const paras = text.split(/\n\s*\n/);
  let k = 0;
  return paras
    .map((p) => {
      const t = p.trim();
      if (t.length < 40) return p;
      const n = Math.min(perPara, Math.max(0, Math.floor(t.length / 200)));
      let out = t;
      for (let i = 0; i < n; i++) out = CLICHES[k++ % CLICHES.length] + out;
      return out;
    })
    .join("\n\n");
}

function toFormal(text: string): { out: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const [re, to] of STYLE_MAP) {
    out = out.replace(re, () => {
      hits++;
      return to;
    });
  }
  return { out, hits };
}

const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8")) as {
  items: { genre: string; title: string; file: string }[];
};

interface Row {
  title: string;
  genre: string;
  chars: number;
  base: number;
  withCliche: number;
  dCliche: number;
  formalHits: number;
  formal: number;
  dFormal: number;
}

const rows: Row[] = [];
for (const it of manifest.items) {
  const raw = readFileSync(it.file, "utf8");
  const prose = raw.split("\n\n").slice(1).join("\n\n");
  const base = aiScore(prose).score;
  const cText = injectCliche(prose, 1);
  const cScore = aiScore(cText).score;
  const { out: fText, hits } = toFormal(prose);
  const fScore = aiScore(fText).score;
  rows.push({
    title: it.title,
    genre: it.genre,
    chars: prose.length,
    base,
    withCliche: cScore,
    dCliche: cScore - base,
    formalHits: hits,
    formal: fScore,
    dFormal: fScore - base,
  });
}

console.log(`确定性注入实验｜${rows.length} 篇真人文本（中文维基百科 CC BY-SA 4.0）\n`);
console.log("体裁            条目        字数  基线  注入套话后  Δ  │ 书面化替换  Δ");
console.log("─".repeat(80));
for (const r of rows) {
  console.log(
    `${r.genre.padEnd(14)} ${r.title.padEnd(10)} ${String(r.chars).padStart(5)} ${String(r.base).padStart(5)} ${String(r.withCliche).padStart(11)} ` +
      `${(r.dCliche >= 0 ? "+" : "") + r.dCliche}`.padStart(4) +
      `  │${String(r.formalHits).padStart(7)}处 ${(r.dFormal >= 0 ? "+" : "") + r.dFormal}`.padStart(
        5,
      ),
  );
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const dc = rows.map((r) => r.dCliche);
const df = rows.map((r) => r.dFormal);
const upC = dc.filter((x) => x > 0).length;
const upF = df.filter((x) => x > 0).length;

console.log(`\n━━━ 判别力（注入后分数升高 = 判对）━━━`);
console.log(
  `  套话注入     ${upC}/${rows.length} = ${((upC / rows.length) * 100).toFixed(0)}% 方向正确`,
);
console.log(
  `               Δ 均值 ${avg(dc).toFixed(1)}｜范围 ${Math.min(...dc)} ~ ${Math.max(...dc)}`,
);
console.log(
  `  语体书面化   ${upF}/${rows.length} = ${((upF / rows.length) * 100).toFixed(0)}% 方向正确（仅 ${rows.reduce((a, b) => a + b.formalHits, 0)} 处命中，口语标记本就极少）`,
);
console.log(
  `               Δ 均值 ${avg(df).toFixed(1)}｜范围 ${Math.min(...df)} ~ ${Math.max(...df)}`,
);

console.log(`\n━━━ 真人基线的关键事实 ━━━`);
const bases = rows.map((r) => r.base).sort((a, b) => a - b);
console.log(`  真人文本 aiScore：${bases.join(", ")}`);
console.log(
  `  ⇒ 真人写的文本分数中位 ${bases[Math.floor(bases.length / 2)]}，最高 ${bases[bases.length - 1]}（${rows.find((r) => r.base === bases[bases.length - 1])?.title}）`,
);
console.log(
  `  ⇒ **"低分=像人写"是错的**：真人语料里就有 ${bases.filter((b) => b > 40).length}/${rows.length} 篇超过 40 分。`,
);
console.log(
  `  ⇒ 分数高低更多由**体裁与长度**决定（百科长文/列表化天然高分），而非"像不像 AI 写"。`,
);
