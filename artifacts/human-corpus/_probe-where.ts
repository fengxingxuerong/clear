import { readFileSync } from "node:fs";
import { humanize } from "../../src/engine/humanize.ts";
import { splitSentences } from "../../src/engine/humanize-text.ts";
const m = JSON.parse(readFileSync("artifacts/human-corpus/manifest.json", "utf8")) as { items: { title: string; file: string }[] };
const it = m.items.find(i => i.title === "疫苗")!;
const prose = readFileSync(it.file, "utf8").split("\n\n").slice(1).join("\n\n");
const out = humanize(prose, { intensity: 0.9, seed: 20260905 });
const oS = splitSentences(out), pS = splitSentences(prose);
console.log("原文里本来就有语气词的句子数:", pS.filter(s => /[吧嘛呢哈呀啊][。！]?$/.test(s.trim())).length);
let n = 0;
for (const s of oS) {
  const t = s.trim();
  const mm = t.match(/([^\n。！？]{6,})([吧嘛呢哈呀啊])([。！]?)$/);
  if (!mm || /[？?]$/.test(t)) continue;
  // 原文里是否已有这句话的主体
  const core = mm[1].slice(-10);
  const inOrig = prose.includes(core);
  if (n++ < 8) console.log(`${inOrig ? "[原文有主体]" : "[凭空]"} 「${mm[1].slice(-22)}${mm[2]}」`);
}
