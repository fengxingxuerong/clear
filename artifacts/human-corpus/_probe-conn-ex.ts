/** 抓取转折词消失的具体上下文，判断是真断裂还是仅连接词消失 */
import { readFileSync } from "node:fs";
import { humanize } from "../../src/engine/humanize.ts";
const m = JSON.parse(readFileSync("artifacts/human-corpus/manifest.json", "utf8")) as {
  items: { title: string; file: string }[];
};
let shown = 0;
for (const it of m.items) {
  const prose = readFileSync(it.file, "utf8").split("\n\n").slice(1).join("\n\n");
  const out = humanize(prose, { intensity: 0.9, seed: 20260905 });
  for (const c of ["但", "然而"]) {
    if (shown >= 5) break;
    // 找原文里有、产出里没有的位置
    let idx = 0;
    while (shown < 5) {
      const i = prose.indexOf(c, idx);
      if (i < 0) break;
      idx = i + 1;
      const around = prose.slice(Math.max(0, i - 26), i + 26);
      // 该位置在产出里对应的内容
      const before = prose.slice(Math.max(0, i - 26), i).slice(-8);
      const after = prose.slice(i + 1, i + 26).slice(0, 8);
      const j = out.indexOf(before.slice(0, 4));
      if (j >= 0) {
        const outSeg = out.slice(j, j + 60).replace(/\n/g, "⏎");
        const stillHas = outSeg.includes(c);
        if (!stillHas) {
          shown++;
          console.log(`\n[${it.title}] 原文：…${around.replace(/\n/g, "⏎")}…`);
          console.log(`产出：…${outSeg}…`);
        }
      }
    }
  }
}
