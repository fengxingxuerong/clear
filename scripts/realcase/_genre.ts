/** 真实案例：体裁判定与 formal 还原门控为什么没生效（诊断用） */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyGenre } from "../../src/engine/classify-genre.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(path.join(HERE, "cases.json"), "utf8")).cases;

for (const c of cases) {
  const g = classifyGenre(c.text);
  const name = String(g.genre);
  // humanize.ts:987 —— 只有 main / academic 才会走 guardFormalRegister
  const formal = name === "main";
  console.log(
    `${c.id.padEnd(22)} genre=${name.padEnd(10)} conf=${String(g.confidence).padEnd(6)} rule=${String(g.ruleHit).padEnd(3)} guardFormalRegister=${formal ? "生效" : "❌ 不生效"}`,
  );
}
