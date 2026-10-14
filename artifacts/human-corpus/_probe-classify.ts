import { readFileSync } from "node:fs";
import { classifyGenre } from "../../src/engine/classify-genre.ts";
const m = JSON.parse(readFileSync("artifacts/human-corpus/manifest.json", "utf8")) as { items: { title: string; file: string }[] };
const counts: Record<string, number> = {};
for (const it of m.items) {
  const prose = readFileSync(it.file, "utf8").split("\n\n").slice(1).join("\n\n");
  const g = classifyGenre(prose).genre;
  counts[g] = (counts[g] ?? 0) + 1;
  console.log(`${it.title.padEnd(12)} → ${g}`);
}
console.log("\n分布:", counts);
