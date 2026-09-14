/**
 * scripts/calib-sanity.ts —— 标定数据源自检
 * ---------------------------------------------------------
 * 1) 参数一致性：calibration-data.json tracks 与 zhuque-calib.ts CALIB 是否一致
 * 2) 锚点拟合误差：用 tracks 参数预测 18 点官分，|残差| ≤ 8pp 才算自洽
 * 3) x 轴漂移报告：用 rebuild 参数重建文本 → 当前引擎重算 aiScore，
 *    与数据源 x 对比，|Δ| > 3 标红（= 引擎改动导致校准线过时信号）
 *
 * 用法：npx tsx scripts/calib-sanity.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiScore } from "../src/engine/humanize-metrics";
import { humanize } from "../src/engine/humanize";
import { CALIB, predictOfficialPct, type CalibTrack } from "../src/engine/zhuque-calib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "calibration-data.json"), "utf8"));
const V2_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, "calibration-data-v2-genres.json"), "utf8"));
const SEED = 20260826;

function v2Text(genre: string, level: string): string {
  const row = V2_JSON.find((r: any) => r.genre === genre && r.level === level);
  if (!row) throw new Error(`v2 找不到 ${genre}/${level}`);
  return row.text;
}

const EXPO = fs.readFileSync(path.join(__dirname, "archive", "EXPO_O1_RAW.txt"), "utf8");
const SRC: Record<string, string> = {
  EXPO: EXPO,
  V2_NAR: v2Text("narrative", "原文"),
  V2_DIA: v2Text("dialogue", "原文"),
  V2_HUMAN: v2Text("humanHand", "纯人写稿(无处理)"),
};

function rebuild(src: string, intensity: number, zhuqueMode: boolean, seed: number): string {
  if (intensity === 0) return src;
  let upload = humanize(src, { intensity, zhuqueMode, seed });
  let round = 1;
  while (upload.replace(/\s/g, "").length < 400) {
    upload = upload + "\n\n" + humanize(src, { intensity, zhuqueMode, seed: seed + round });
    round++;
  }
  return upload;
}

console.log("══════════ 标定数据源自检 ══════════");
console.log(`版本：${DATA.version}  数据点：${DATA.points.length}`);

// 1) 参数一致性
console.log("\n【1】tracks vs zhuque-calib.ts 参数一致性");
let paramOk = true;
for (const [tk, tr] of Object.entries(DATA.tracks) as [string, any][]) {
  const cur = CALIB[tk as CalibTrack];
  if (!cur) { console.log(`  ❌ zhuque-calib.ts 缺少 track=${tk}`); paramOk = false; continue; }
  const da = Math.abs(cur.a - tr.a), db = Math.abs(cur.b - tr.b);
  const ok = da <= 0.001 && db <= 0.01;
  if (!ok) paramOk = false;
  console.log(`  ${tk}: data(a=${tr.a},b=${tr.b}) vs code(a=${cur.a},b=${cur.b}) ${ok ? "✅" : "❌ 不一致"}`);
}

// 2) 锚点拟合误差
console.log("\n【2】锚点官分预测误差（阈值 8pp）");
const genreTrack: Record<string, CalibTrack> = { expository: "main", narrative: "narrative", dialogue: "dialogue", humanHand: "human" };
let maxErr = 0;
for (const p of DATA.points) {
  const pred = predictOfficialPct(p.x, genreTrack[p.genre]);
  const err = Math.abs(pred - p.y);
  maxErr = Math.max(maxErr, err);
  if (err > 8) console.log(`  ❌ ${p.id} 官=${p.y}% 预测=${pred.toFixed(1)}% 误差=${err.toFixed(1)}pp`);
}
console.log(`  最大误差 ${maxErr.toFixed(1)}pp ${maxErr <= 8 ? "✅" : "❌"}`);

// 3) x 轴漂移报告
console.log("\n【3】x 轴漂移报告（rebuild → 当前引擎重算 vs 数据源 x，阈值 3）");
const DRIFT_THRESHOLD = 3;
const driftList: { id: string; srcX: number; curX: number; delta: number }[] = [];
for (const p of DATA.points) {
  const r = p.rebuild;
  const text = rebuild(SRC[r.src], r.intensity, r.zhuqueMode, SEED);
  const curX = aiScore(text).score;
  const delta = curX - p.x;
  driftList.push({ id: p.id, srcX: p.x, curX, delta });
  const flag = Math.abs(delta) > DRIFT_THRESHOLD ? "🔴 漂移" : "✅";
  console.log(`  ${p.id.padEnd(8)} 数据源x=${String(p.x).padStart(3)}  当前引擎=${String(curX).padStart(3)}  Δ=${delta >= 0 ? "+" : ""}${delta}  ${flag}`);
}

// 汇总
console.log("\n══════════ 汇总 ══════════");
console.log(`参数一致性：${paramOk ? "✅" : "❌"}`);
console.log(`锚点误差：最大 ${maxErr.toFixed(1)}pp（≤8 ✅）`);
const drifted = driftList.filter((d) => Math.abs(d.delta) > DRIFT_THRESHOLD);
console.log(`漂移点数：${drifted.length}/${driftList.length}（>${DRIFT_THRESHOLD} 即校准线过时信号）`);
if (drifted.length > 0) {
  console.log("  漂移点：" + drifted.map((d) => `${d.id}(Δ${d.delta >= 0 ? "+" : ""}${d.delta})`).join("、"));
  console.log("  → 提示：这些点对应体裁线已过时，需官方送检新数据后重拟合");
}
