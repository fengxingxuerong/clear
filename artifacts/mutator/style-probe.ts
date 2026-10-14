/**
 * mutator/style-probe.ts —— 干净的「纯语体书面化」实验（确定性、零 LLM 调用）
 *
 * ## 为什么必须重做这个实验
 *
 * heavyB 档（LLM 版）想验证"aiScore 对句式/语体无感"，但**样本不干净**：
 * LLM 把「改工整」理解成了「精简」，dialogue 从 668 字掉到 482（**删掉 28% 内容**）。
 * 样本里混进了内容删减 ⇒ 用它判"语体维度有没有被覆盖"**不成立**。
 *
 * 这次改用**确定性替换**：一张「口语 → 等义书面词」的小表，**不删字、不加套话、
 * 不改事实**，只换词面。零 LLM 调用、零额度、完全可审计。
 *
 * 判据：纯语体书面化后，aiScore 与句式工整度各怎么动？
 *   · aiScore 明显上升 → 语体维度其实被覆盖了，之前 heavyB 的结论要推翻
 *   · aiScore 不动/反降 → 盲区确认，新指标有存在价值
 */
import { readFileSync } from "node:fs";
import { aiScore } from "../../src/engine/humanize.ts";
import { syntaxRegularity } from "../../src/engine/humanize-syntax.ts";

/**
 * 口语 → 等义书面词。刻意**不含任何套话**（不得出现 值得注意的是/综上所述/不仅…而且
 * 等），否则就退化成 heavyA 那种"靠套话拉分"的样本，测不到纯语体维度。
 * 全部是**等义替换**：不改变信息量、不改变句子成分。
 */
const STYLE_MAP: [RegExp, string][] = [
  // 高频口语标记 → 书面等义
  [/挺多/g, "较多"],
  [/挺累/g, "较为疲惫"],
  [/挺好的?/g, "尚可"],
  [/好多/g, "大量"],
  [/特别/g, "尤其"],
  [/差不多/g, "大致"],
  [/想起来/g, "回忆起"],
  [/的事儿/g, "事宜"],
  [/差不多吧/g, "大致如此"],
  [/压根/g, "根本"],
  [/这家伙/g, "该个体"],
  [/还挺/g, "尚属"],
  [/不过吧/g, "不过"],
  [/挺好玩/g, "颇具趣味"],
  [/好像/g, "似乎"],
  [/差不多就/g, "大致即"],
  [/一边/g, "一面"],
  [/赶紧/g, "随即"],
  [/连忙/g, "当即"],
  [/折腾/g, "反复处置"],
  [/掏出/g, "取出"],
  [/瞅/g, "看"],
  [/顺手/g, "随手"],
  [/超了/g, "超出"],
  [/一瓶/g, "一瓶"],
  [/一盒/g, "一盒"],
  [/攒/g, "积蓄"],
  [/搁/g, "放置"],
  [/一小/g, "一少"],
  [/磨/g, "消耗"],
  [/划得来/g, "值得"],
  [/挤/g, "拥挤"],
  [/挑/g, "选择"],
  [/翻/g, "翻动"],
  [/到底/g, "究竟"],
  [/用不着/g, "不需要"],
  [/一堆/g, "一批"],
  [/等我/g, "待我"],
  [/哦对/g, "此外"],
  [/对了/g, "补充一句"],
  [/还没/g, "尚未"],
];

const all = JSON.parse(readFileSync("scripts/calibration-data-v2-genres.json", "utf8")) as {
  genre: string;
  level: string;
  text: string;
}[];
const humans = all.filter((r) => r.level.includes("原文") || r.level.includes("无处理"));
const byGenre = new Map<string, string>();
for (const r of humans) if (!byGenre.has(r.genre)) byGenre.set(r.genre, r.text);

function toFormal(t: string): { out: string; hits: number } {
  let out = t;
  let hits = 0;
  for (const [re, to] of STYLE_MAP) {
    out = out.replace(re, () => {
      hits++;
      return to;
    });
  }
  return { out, hits };
}

console.log("纯语体书面化（确定性替换，零 LLM 调用）\n");
console.log("体裁        字数(人→书)  替换处  aiScore(人→书)    Δ   │  工整度(人→书)    Δ");
console.log("─".repeat(82));
const deltas: number[] = [];
const synDeltas: number[] = [];
for (const [genre, text] of byGenre) {
  const { out, hits } = toFormal(text);
  const ha = aiScore(text);
  const va = aiScore(out);
  const hs = syntaxRegularity(text);
  const vs = syntaxRegularity(out);
  const d = va.score - ha.score;
  const sd = vs.score - hs.score;
  deltas.push(d);
  synDeltas.push(sd);
  console.log(
    `${genre.padEnd(11)} ${String(text.length).padStart(4)}→${String(out.length).padEnd(5)} ${String(hits).padStart(5)}  ` +
      `${String(ha.score).padStart(4)}→${String(va.score).padEnd(5)}` +
      `${(d >= 0 ? "+" : "") + d}`.padStart(6) +
      `   │  ${hs.score.toFixed(1).padStart(5)}→${vs.score.toFixed(1).padEnd(5)}` +
      `${(sd >= 0 ? "+" : "") + sd.toFixed(1)}`.padStart(7),
  );
}
console.log(`\naiScore Δ 均值 ${(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(1)}`);
console.log(
  `工整度 Δ 均值  ${(synDeltas.reduce((a, b) => a + b, 0) / synDeltas.length).toFixed(1)}`,
);

// 抽一段改写后的样例给人眼看
const sample = [...byGenre][0];
if (sample) {
  const { out } = toFormal(sample[1]);
  const a = sample[1].slice(0, 160);
  const b = out.slice(0, 160);
  console.log(`\n━━━ 改写样例（${sample[0]}）━━━\n人写：${a}\n书面：${b}`);
}
