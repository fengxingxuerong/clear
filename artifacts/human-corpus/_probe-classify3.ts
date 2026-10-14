import { readFileSync } from "node:fs";
import { classifyGenre } from "../../src/engine/classify-genre.ts";
const src = readFileSync("scripts/scan-bugs.ts", "utf8");
// 取 scan-bugs 里的对话体语料
const i = src.indexOf("张总放下手里的茶杯");
const j = src.indexOf('"', i - 30);
const k = src.indexOf('"', j + 1);
const line = src.slice(j, k + 1);
const corpus = eval(line);
const r = classifyGenre(corpus.replace(/\\n/g, "\n"));
console.log("v8.0 对话体语料 →", r.genre, "置信度", r.confidence.toFixed(3));
console.log("features:", JSON.stringify(r.features, null, 1));
