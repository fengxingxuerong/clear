/** 验证"删连接词"是否真的破坏了句子 */
import { readFileSync } from "node:fs";
import { humanize } from "../../src/engine/humanize.ts";
const m = JSON.parse(readFileSync("artifacts/human-corpus/manifest.json", "utf8")) as {
  items: { title: string; file: string }[];
};
const it = m.items.find((i) => i.title === "疫苗")!;
const prose = readFileSync(it.file, "utf8").split("\n\n").slice(1).join("\n\n");
const out = humanize(prose, { intensity: 0.9, seed: 20260905 });
const P0 = prose.slice(0, 400);
const i0 = out.indexOf(prose.slice(20, 40));
console.log("=== 原文前 400 字 ===\n" + P0);
console.log("\n=== 产出对应段 ===\n" + out.slice(Math.max(0, i0), i0 + 400));
