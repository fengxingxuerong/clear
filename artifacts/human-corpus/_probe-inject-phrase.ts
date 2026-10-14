/** 量化四类真问题：凭空添加 / 陈述句尾语气词 / 删连接词 / 逻辑断裂 */
import { readFileSync } from "node:fs";
import { humanize } from "../../src/engine/humanize.ts";
import { splitSentences } from "../../src/engine/humanize-text.ts";
const m = JSON.parse(readFileSync("artifacts/human-corpus/manifest.json", "utf8")) as {
  items: { title: string; file: string }[];
};

let nAdd = 0,
  nTail = 0,
  nConn = 0,
  nTotal = 0;
const addSamples: string[] = [];
const tailSamples: string[] = [];
const CONN = /^(但|但是|因此|所以|然而|而且|同时|此外|另外|不过|可是|然后|于是)/;

for (const it of m.items) {
  const prose = readFileSync(it.file, "utf8").split("\n\n").slice(1).join("\n\n");
  const out = humanize(prose, { intensity: 0.9, seed: 20260905 });
  nTotal++;
  const oSents = splitSentences(out);
  // ① 凭空添加：产出里有、原文里没有的短句
  const pSents = splitSentences(prose);
  for (const s of oSents) {
    const t = s.trim();
    if (t.length < 16) continue;
    if (!prose.includes(t.slice(0, 10))) {
      nAdd++;
      if (addSamples.length < 6) addSamples.push(`${it.title}：${t.slice(0, 30)}`);
    }
  }
  // ② 陈述句尾语气词
  for (const s of oSents) {
    const m2 = s.match(/([^\n。！？]{6,})([吧嘛呢哈呀啊])([。！]?)$/);
    if (m2 && !/[？?]$/.test(s)) {
      nTail++;
      if (tailSamples.length < 6) tailSamples.push(`${it.title}：${m2[1].slice(-18)}${m2[2]}`);
    }
  }
  // ③ 产出句首出现连接词而原文无（说明连接词被移动/新增，逻辑被打乱）
  for (const s of oSents) {
    const t = s.trim();
    if (!CONN.test(t)) continue;
    const orig = pSents.find((x) => x.includes(t.slice(4, 16)));
    if (!orig) {
      nConn++;
    }
  }
}
console.log(`样本 ${nTotal} 篇\n`);
console.log(`① 凭空添加的句子   ${nAdd} 处（产出里有、原文里找不到对应）`);
addSamples.forEach((s) => console.log("    · " + s));
console.log(`\n② 陈述句尾被注入语气词 ${nTail} 处`);
tailSamples.forEach((s) => console.log("    · " + s));
console.log(`\n③ 连接词被移动/新增导致逻辑错位 ${nConn} 处`);
