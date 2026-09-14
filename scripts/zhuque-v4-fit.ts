/**
 * scripts/zhuque-v4-fit.ts —— v4 四体裁 OLS 拟合（含 x 轴统一重标）
 * ---------------------------------------------------------
 * v4 标定的关键升级：
 *  1) x 轴统一重标：历史归档点（v0.7/v2/v3）的 aiScore 都是"当时引擎"算的，
 *     引擎迭代后同一文本的 x 会漂移（如论说原文 33→92），旧 x 不可比。
 *     本脚本对每个归档点的文本用【当前引擎】重算 x，所有点共用同一把尺子。
 *  2) 补非饱和中段点：v4 新送检 11 篇（论说 16/92、叙事 18、对话 22/35、人写 4 篇），
 *     把各线自由度从 1 扩到 3+，可给出 S.E. 与置信区间。
 *
 * 用法：
 *   1. npx tsx scripts/zhuque-v4-pipeline.ts prepare   # 生成送检包 + TSV
 *   2. 送检朱雀，把官分填入 scripts/calibration-input-v4.tsv
 *   3. npx tsx scripts/zhuque-v4-fit.ts                # 重标 x + OLS + 报告
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiScore } from "../src/engine/humanize-metrics";
import { humanize } from "../src/engine/humanize";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_JSON = path.join(__dirname, "calibration-data-v2-genres.json");
const V4_TSV = path.join(__dirname, "calibration-input-v4.tsv");
const OUT_JSON = path.join(__dirname, "calibration-data-v4-genres.json");
const OUT_TXT = path.join(__dirname, "zhuque-calibration-v4.txt");
const EXPO_RAW = fs.readFileSync(path.join(__dirname, "archive", "EXPO_O1_RAW.txt"), "utf8");
const SEED = 20260826;
const PASS_LINE = 40;

function loadV2Text(genre: string, level: string): string {
  const raw = JSON.parse(fs.readFileSync(V2_JSON, "utf8"));
  const row = raw.find((r: any) => r.genre === genre && r.level === level);
  if (!row) throw new Error(`v2 找不到 genre=${genre} level=${level}`);
  return row.text;
}

/** 确定性重建：给定原文/强度/seed，按 v3/v4 的补轮逻辑生成最终送检文本 */
function rebuild(base: string, intensity: number, zhuqueMode: boolean, seed: number, minChars: number): string {
  if (intensity === 0) return base;
  let upload = humanize(base, { intensity, zhuqueMode, seed });
  let round = 1;
  while (upload.replace(/\s/g, "").length < minChars) {
    upload = upload + "\n\n" + humanize(base, { intensity, zhuqueMode, seed: seed + round });
    round++;
  }
  return upload;
}

/** 当前引擎重算 aiScore（x 重标） */
function rescore(text: string): number {
  return aiScore(text).score;
}

/* ============================================================
   数据点定义：source 说明归档，文本统一重建后重算 x
   ============================================================ */
type Pt = {
  id: string; genre: "expository" | "narrative" | "dialogue" | "humanHand";
  genreName: string; level: string; x: number; y: number; source: string; note: string;
};

const V2_NAR = loadV2Text("narrative", "原文");
const V2_DIA = loadV2Text("dialogue", "原文");
const V2_HUMAN = loadV2Text("humanHand", "纯人写稿(无处理)");

const ARCHIVED: Pt[] = [
  // —— 论说（v0.7 3 点 + v3 2 点，文本=EXPO 原文或经处理的 EXPO）——
  { id: "O1", genre: "expository", genreName: "论说文", level: "原文", x: rescore(EXPO_RAW), y: 85, source: "v0.7", note: "EXPO 原文 92" },
  { id: "O2v07", genre: "expository", genreName: "论说文", level: "基础0.7(旧)", x: rescore(rebuild(EXPO_RAW, 0.7, false, SEED, 400)), y: 45, source: "v0.7", note: "旧引擎 x=10" },
  { id: "O3v07", genre: "expository", genreName: "论说文", level: "朱雀0.9(旧)", x: rescore(rebuild(EXPO_RAW, 0.9, true, SEED, 400)), y: 30, source: "v0.7", note: "旧引擎 x=8" },
  { id: "O2v3", genre: "expository", genreName: "论说文", level: "基础0.7(v3)", x: rescore(rebuild(EXPO_RAW, 0.7, false, SEED, 400)), y: 23, source: "v3", note: "旧引擎 x=1" },
  { id: "O3v3", genre: "expository", genreName: "论说文", level: "朱雀0.9(v3)", x: rescore(rebuild(EXPO_RAW, 0.9, true, SEED, 400)), y: 19, source: "v3", note: "旧引擎 x=1" },
  // —— 叙事（v2 3 点 + v3 1 点）——
  { id: "N1", genre: "narrative", genreName: "叙事文", level: "原文", x: rescore(V2_NAR), y: 99, source: "v2", note: "原文 47→重标" },
  { id: "N2v2", genre: "narrative", genreName: "叙事文", level: "基础0.6(v2)", x: rescore(rebuild(V2_NAR, 0.6, false, SEED, 400)), y: 22, source: "v2", note: "旧引擎 x=0" },
  { id: "N3v2", genre: "narrative", genreName: "叙事文", level: "朱雀0.9(v2)", x: rescore(rebuild(V2_NAR, 0.9, true, SEED, 400)), y: 18, source: "v2", note: "旧引擎 x=0" },
  { id: "N2v3", genre: "narrative", genreName: "叙事文", level: "朱雀0.9(v3)", x: rescore(rebuild(V2_NAR, 0.9, true, SEED, 400)), y: 15, source: "v3", note: "v3 新检" },
  // —— 对话（v2 3 点 + v3 2 点）——
  { id: "D0", genre: "dialogue", genreName: "对话体", level: "原文", x: rescore(V2_DIA), y: 98, source: "v2", note: "原文 81→重标" },
  { id: "D2v2", genre: "dialogue", genreName: "对话体", level: "基础0.6(v2)", x: rescore(rebuild(V2_DIA, 0.6, false, SEED, 400)), y: 28, source: "v2", note: "旧引擎 x=6→0 漂移" },
  { id: "D3v2", genre: "dialogue", genreName: "对话体", level: "朱雀0.9(v2)", x: rescore(rebuild(V2_DIA, 0.9, true, SEED, 400)), y: 25, source: "v2", note: "旧引擎 x=7→0 漂移" },
  { id: "D1v3", genre: "dialogue", genreName: "对话体", level: "基础0.6(v3)", x: rescore(rebuild(V2_DIA, 0.6, false, SEED, 400)), y: 22, source: "v3", note: "v3 新检" },
  { id: "D2v3", genre: "dialogue", genreName: "对话体", level: "朱雀0.9(v3)", x: rescore(rebuild(V2_DIA, 0.9, true, SEED, 400)), y: 21, source: "v3", note: "v3 新检" },
  // —— 人写（v2 3 点 + v3 1 点）——
  { id: "H0", genre: "humanHand", genreName: "纯人写稿", level: "无处理", x: rescore(V2_HUMAN), y: 15, source: "v2", note: "超市购物稿" },
  { id: "H1", genre: "humanHand", genreName: "纯人写稿", level: "基础0.6", x: rescore(rebuild(V2_HUMAN, 0.6, false, SEED, 400)), y: 19, source: "v2", note: "反直觉：去味反升" },
  { id: "H2v2", genre: "humanHand", genreName: "纯人写稿", level: "朱雀0.9(v2)", x: rescore(rebuild(V2_HUMAN, 0.9, true, SEED, 400)), y: 17, source: "v2", note: "" },
  { id: "H2v3", genre: "humanHand", genreName: "纯人写稿", level: "朱雀0.9(v3)", x: rescore(rebuild(V2_HUMAN, 0.9, true, SEED, 400)), y: 18, source: "v3", note: "v3 新检" },
];

/** v4 新送检点：读 TSV（官分已填） */
function loadV4Rows(): Pt[] {
  if (!fs.existsSync(V4_TSV)) throw new Error(`找不到 ${V4_TSV}，请先跑 prepare 并送检填分`);
  const lines = fs.readFileSync(V4_TSV, "utf8").trim().split(/\r?\n/);
  const header = lines.shift()!.split("\t");
  const out: Pt[] = [];
  for (const ln of lines) {
    if (!ln.trim()) continue;
    const c: Record<string, string> = {};
    header.forEach((k, i) => (c[k] = (ln.split("\t")[i] ?? "").trim()));
    if (c.zhuqueOfficialPct === "" || isNaN(Number(c.zhuqueOfficialPct))) continue;
    out.push({
      id: c.id, genre: c.genre as Pt["genre"],
      genreName: c.genre === "expository" ? "论说文" : c.genre === "narrative" ? "叙事文" : c.genre === "dialogue" ? "对话体" : "纯人写稿",
      level: c.level, x: Number(c.aiScore), y: Number(c.zhuqueOfficialPct), source: "v4", note: c.comment,
    });
  }
  return out;
}

/* ============================================================
   OLS + 标准误 + 95% 置信区间
   ============================================================ */
function ols(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (let i = 0; i < n; i++) { const p = intercept + slope * xs[i]; ssRes += (ys[i] - p) ** 2; }
  const ssTot = ys.reduce((s, v) => s + (v - my) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  const df = n - 2;
  const se = df > 0 ? Math.sqrt(ssRes / df) : NaN; // 回归标准误（pp）
  const seSlope = df > 0 && den > 0 ? se / Math.sqrt(den) : NaN;
  const seIntercept = df > 0 ? se * Math.sqrt(1 / n + (mx * mx) / den) : NaN;
  const tCrit = df > 0 ? (df <= 1 ? 12.706 : df === 2 ? 4.303 : df === 3 ? 3.182 : 2.776) : NaN; // 粗查 t 表
  const ciSlope = [slope - tCrit * seSlope, slope + tCrit * seSlope];
  const ciIntercept = [intercept - tCrit * seIntercept, intercept + tCrit * seIntercept];
  return { n, slope, intercept, r2, se, seSlope, seIntercept, ciSlope, ciIntercept, maxResid: Math.max(...ys.map((y, i) => Math.abs(y - (intercept + slope * xs[i])))) };
}

function main() {
  const v4Rows = loadV4Rows();
  const all = [...ARCHIVED, ...v4Rows];
  console.log(`═══════════════ v4 OLS 拟合（归档 ${ARCHIVED.length} + v4 新检 ${v4Rows.length} = ${all.length} 点）═══════════════`);
  console.log(`x 轴已统一用当前引擎重标（归档点文本重建重算 aiScore）\n`);

  const genres: Pt["genre"][] = ["expository", "narrative", "dialogue", "humanHand"];
  const gName: Record<string, string> = { expository: "论说文", narrative: "叙事文", dialogue: "对话体", humanHand: "纯人写稿" };
  let report = "";

  for (const g of genres) {
    const pts = all.filter((p) => p.genre === g);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const f = ols(xs, ys);
    const passX = f.slope !== 0 ? (PASS_LINE - f.intercept) / f.slope : NaN;
    console.log(`\n【${gName[g]}】n=${f.n}  y = ${f.intercept.toFixed(2)} + ${f.slope.toFixed(3)}x`);
    console.log(`  R²=${f.r2.toFixed(3)}  S.E.=${Number.isNaN(f.se) ? "—" : f.se.toFixed(2) + "pp"}  最大残差=${f.maxResid.toFixed(1)}pp`);
    console.log(`  95% CI: slope=[${f.ciSlope[0].toFixed(3)}, ${f.ciSlope[1].toFixed(3)}]  intercept=[${f.ciIntercept[0].toFixed(2)}, ${f.ciIntercept[1].toFixed(2)}]`);
    console.log(`  过人线(≤${PASS_LINE}%) aiScore ≤ ${isNaN(passX) ? "—" : passX.toFixed(1)}`);
    for (const p of pts) {
      const yhat = f.intercept + f.slope * p.x;
      const resid = p.y - yhat;
      console.log(`    ${p.id.padEnd(8)} x=${String(p.x).padStart(3)} 官=${String(p.y).padStart(3)}% 预测=${yhat.toFixed(1)}% 残差=${resid >= 0 ? "+" : ""}${resid.toFixed(1)}pp [${p.source}]`);
    }
    report += `${gName[g]}\t${f.n}\t${f.slope.toFixed(3)}\t${f.intercept.toFixed(2)}\t${f.r2.toFixed(3)}\t${Number.isNaN(f.se) ? "NA" : f.se.toFixed(2)}\t${isNaN(passX) ? "NA" : passX.toFixed(1)}\t${f.maxResid.toFixed(1)}\n`;
  }

  // 写 v4 数据 JSON（含全部点）
  fs.writeFileSync(OUT_JSON, JSON.stringify(all, null, 2), "utf8");
  fs.writeFileSync(OUT_TXT, `v4 四体裁 OLS 拟合报告\n归档 ${ARCHIVED.length} + v4 ${v4Rows.length} = ${all.length} 点（x 轴当前引擎统一重标）\n\n体裁\tn\tslope\tintercept\tR²\tS.E.(pp)\t过人线x40\t最大残差(pp)\n${report}`, "utf8");
  console.log(`\n✅ 输出：${OUT_JSON}`);
  console.log(`        ${OUT_TXT}`);
}

main();
