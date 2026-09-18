/**
 * scripts/calib-sanity.ts —— 标定数据源自检
 * ---------------------------------------------------------
 * 1) 参数一致性：calibration-data.json tracks 与 zhuque-calib.ts CALIB 是否一致
 * 2) 锚点拟合误差：用 tracks 参数预测 18 点官分，|残差| ≤ 8pp 才算自洽
 * 3) x 轴漂移报告：用 rebuild 参数重建文本 → 当前引擎重算 aiScore，
 *    与数据源 x 对比，|Δ| > 3 标红（= 引擎改动导致校准线过时信号）
 *
 * 退出码：【1】【2】不过就是错；【3】按"漂移基线"棘轮拦（只许变好，见文件末尾说明）。
 * 用法：npx tsx scripts/calib-sanity.ts [--ceiling N]   # N 用于临时收紧/放宽漂移基线
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiScore } from "../src/engine/humanize-metrics";
import { humanize } from "../src/engine/humanize";
import { CALIB, predictOfficialPct, type CalibTrack } from "../src/engine/zhuque-calib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 极简 flag 解析：不带值的 --xxx 记为 "1" */
const argv: Record<string, string> = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const next = a[i + 1];
    argv[a[i].slice(2)] = next === undefined || next.startsWith("--") ? "1" : a[++i];
  }
}
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

/* ----------------------------- 退出码 ----------------------------- *
 * 【1】【2】是自洽性检查，不过就是错，一律拦。
 * 【3】x 轴漂移是"已知过时"状态：2026-09-19 实测剩 6/18 点漂移（最大 Δ=-35，D0），
 * 全部硬拦会让仓库永久红、进而没人看这个检查——正是本文件长期只打印不拦（退出码恒 0）
 * 导致漂移无人察觉的老问题。所以做成**棘轮**：只许变好、不许变差，超过基线才拦。
 * 用 --ceiling 可以临时收紧来自测这条门禁真的会拦。
 * ------------------------------------------------------------------ */
const DRIFT_CEILING_POINTS = Number(argv.ceiling ?? 6);
const DRIFT_CEILING_MAX = 35;
const maxAbs = Math.max(...driftList.map((d) => Math.abs(d.delta)));
const bad: string[] = [];
if (!paramOk) bad.push("tracks 参数与 zhuque-calib.ts 不一致");
if (maxErr > 8) bad.push(`锚点拟合误差 ${maxErr.toFixed(1)}pp > 8pp`);
if (drifted.length > DRIFT_CEILING_POINTS)
  bad.push(`漂移 ${drifted.length} 点 > 基线 ${DRIFT_CEILING_POINTS} 点（引擎改动让校准线更过时了）`);
if (maxAbs > DRIFT_CEILING_MAX) bad.push(`最大漂移 Δ${maxAbs} > 基线 ${DRIFT_CEILING_MAX}`);
console.log(
  bad.length
    ? `\n❌ 标定数据源自检未通过：\n  - ${bad.join("\n  - ")}`
    : `\n✅ 标定数据源自检通过（漂移基线 ${drifted.length}/${DRIFT_CEILING_POINTS} 点、Δmax ${maxAbs}/${DRIFT_CEILING_MAX}）`,
);
process.exit(bad.length ? 1 : 0);
