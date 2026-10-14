/** 真实案例：把每篇的四个 dialogue 特征摊开，定位误判到底由哪一项撑起来 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyGenre } from "../../src/engine/classify-genre.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(path.join(HERE, "cases.json"), "utf8")).cases;

for (const c of cases) {
  const r = classifyGenre(c.text);
  const f = r.features;
  console.log(
    `${c.id.padEnd(22)} → ${String(r.genre).padEnd(10)} ` +
      `quote=${f.dlgQuoteRatio.toFixed(4)} colon=${f.dlgColonRatio.toFixed(4)} ` +
      `scene=${f.dlgSceneBlockRatio.toFixed(4)} short=${f.dlgShortTurn.toFixed(4)} ` +
      `expo=${f.expoScore.toFixed(3)} past=${f.narPastRatio.toFixed(4)} sceneN=${f.narSceneRatio.toFixed(4)}`,
  );
}
