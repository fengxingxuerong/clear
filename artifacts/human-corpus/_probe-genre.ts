/** 语气词注入是否与 genre 参数有关？ */
import { readFileSync } from "node:fs";
import { humanize } from "../../src/engine/humanize.ts";
import { splitSentences } from "../../src/engine/humanize-text.ts";
const m = JSON.parse(readFileSync("artifacts/human-corpus/manifest.json", "utf8")) as { items: { title: string; file: string }[] };
const pick = ["疫苗", "北京市", "黄山", "细胞"];
const genres = [undefined, "main", "narrative", "dialogue", "humanHand"] as const;
console.log("条目      " + genres.map(g => (g ?? "(不传)").padStart(8)).join(""));
for (const title of pick) {
  const it = m.items.find(i => i.title === title)!;
  const prose = readFileSync(it.file, "utf8").split("\n\n").slice(1).join("\n\n");
  const cells: string[] = [];
  for (const g of genres) {
    const out = humanize(prose, { intensity: 0.9, seed: 20260905, genre: g as never });
    const sents = splitSentences(out);
    const tail = sents.filter(s => { const x = s.match(/([^\n。！？]{6,})([吧嘛呢哈呀啊])([。！]?)$/); return x && !/[？?]$/.test(s); }).length;
    cells.push(String(tail).padStart(8));
  }
  console.log(title.padEnd(10) + cells.join(""));
}
console.log("\n（数字 = 该篇产出的陈述句尾语气词处数）");
