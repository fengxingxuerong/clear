/** 「但」被删的 179 处到底是什么形态？孤立连接词 vs 句中转折 */
import { readFileSync } from "node:fs";
import { humanize } from "../../src/engine/humanize.ts";
import { splitSentences } from "../../src/engine/humanize-text.ts";
const m = JSON.parse(readFileSync("artifacts/human-corpus/manifest.json", "utf8")) as {
  items: { title: string; file: string }[];
};
const CONN = ["但", "但是", "因此", "所以", "然而", "而且", "同时", "此外", "另外", "不过", "可是"];
let iso = 0,
  mid = 0;
const samples: string[] = [];
for (const it of m.items) {
  const prose = readFileSync(it.file, "utf8").split("\n\n").slice(1).join("\n\n");
  const out = humanize(prose, { intensity: 0.9, seed: 20260905 });
  for (const s of splitSentences(out)) {
    const t = s.trim();
    // 句首即连接词且后面没内容 → 孤立连接词
    for (const c of CONN) {
      if (new RegExp(`^${c}[，,。！]`).test(t)) {
        iso++;
        if (samples.length < 4) samples.push(`[孤立] ${t.slice(0, 26)}`);
      }
    }
  }
  // 原文句中有「但/然而」而产出里没有了
  for (const c of ["但", "然而"]) {
    const inOrig = (prose.match(new RegExp(c, "g")) || []).length;
    const inOut = (out.match(new RegExp(c, "g")) || []).length;
    if (inOrig > inOut) mid += inOrig - inOut;
  }
}
console.log(`产出里仍存在的「孤立连接词」句：${iso} 句`);
samples.forEach((s) => console.log("  " + s));
console.log(`\n原文有但产出没有的连接词（转折类）：${mid} 处`);
console.log(`—— 即引擎把句中/转折连接词删掉了`);
