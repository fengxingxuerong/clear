import { readFileSync } from "node:fs";
import { humanize } from "../../src/engine/humanize.ts";
import { splitSentences } from "../../src/engine/humanize-text.ts";
const m = JSON.parse(readFileSync("artifacts/human-corpus/manifest.json", "utf8")) as {
  items: { title: string; file: string }[];
};
console.log("条目        字数   句数  陈述句尾语气词  处/百句");
let tn = 0,
  ts = 0;
for (const it of m.items) {
  const prose = readFileSync(it.file, "utf8").split("\n\n").slice(1).join("\n\n");
  const out = humanize(prose, { intensity: 0.9, seed: 20260905 });
  const sents = splitSentences(out);
  const tail = sents.filter((s) => {
    const x = s.match(/([^\n。！？]{6,})([吧嘛呢哈呀啊])([。！]?)$/);
    return x && !/[？?]$/.test(s);
  });
  tn += tail.length;
  ts += sents.length;
  if (tail.length)
    console.log(
      `${it.title.padEnd(12)} ${String(prose.length).padStart(6)} ${String(sents.length).padStart(5)} ${String(tail.length).padStart(12)} ${((tail.length / sents.length) * 100).toFixed(1).padStart(8)}`,
    );
}
console.log(`\n合计 ${tn} 处 / ${ts} 句 = 每百句 ${((tn / ts) * 100).toFixed(1)} 处`);
// 对照：语体是书面还是口语
const bookish = m.items.filter((i) =>
  /地理|科技|历史|生物|医学|法律|艺术|人物/.test(i.genre),
).length;
console.log(`其中书面体裁（百科/人物/科技/历史等）占 ${bookish}/${m.items.length} 篇`);
