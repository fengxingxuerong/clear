/**
 * scripts/prepare-submit.ts —— 送检准备（v0.8.6）
 *
 * 流程：读入原文 → 朱雀档深度去味 → 输出送检稿（≥350字门槛校验 + 分批建议）
 *       → 打开朱雀官网 → 用户手动粘贴检测 → 把官方分回填进本脚本 --record 模式
 *
 * 用法：
 *   生成送检稿:  npx tsx scripts/prepare-submit.ts <input.txt> [--out <file>] [--intensity 0.9] [--seed N]
 *   回填官方分:  npx tsx scripts/prepare-submit.ts --record <本地aiScore> <官方百分数> [体裁]
 *
 * 回填的数据会追加到 scripts/calib-lab-points.jsonl（校准实验室共享数据源）。
 */
import fs from "fs";
import path from "path";
import { humanize, aiScore } from "../src/engine/humanize";
import { classifyGenre } from "../src/engine/classify-genre";
import { detectZhuque, ZHUQUE_URL } from "../src/engine/zhuque";
import { trackForGenre } from "../src/engine/zhuque-calib";
import { CALIB, type CalibTrack } from "../src/engine/zhuque-calib";

const POINTS_FILE = path.resolve("scripts/calib-lab-points.jsonl");

function record(args: string[]): void {
  const [xStr, yStr, genre] = args;
  const x = Number(xStr), y = Number(yStr);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y < 0 || y > 100) {
    console.error("用法: --record <本地aiScore> <官方百分数0-100> [track: main|narrative|dialogue|human]");
    process.exit(1);
  }
  const track = (genre as CalibTrack) || "main";
  // genre 参数即轨道名，直接校验
  if (!CALIB[track]) {
    console.error(`未知体裁线: ${track}（可选 main/narrative/dialogue/human）`);
    process.exit(1);
  }
  const point = {
    ts: new Date().toISOString(),
    x, y, track,
    pred: CALIB[track].a * x + CALIB[track].b,
    src: "prepare-submit 手动回填",
  };
  fs.appendFileSync(POINTS_FILE, JSON.stringify(point) + "\n", "utf-8");
  const err = point.pred - y;
  console.log(`✅ 已回填校准点: aiScore=${x} → 官方=${y}%（${track} 线）`);
  console.log(`   当前线预测 ${point.pred.toFixed(1)}% | 偏差 ${err >= 0 ? "+" : ""}${err.toFixed(1)}pp`);
  console.log(`   数据文件: ${POINTS_FILE}`);
  console.log(`   提示: 累计 ≥3 个同线新点后，可用最小二乘重拟合该线（参照 scripts/zhuque-v2-fit-12pt.ts）`);
}

function prepare(args: string[]): void {
  const input = args[0];
  let out = "", intensity = 0.9, seed = 20260905;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i] ?? "";
    else if (args[i] === "--intensity") intensity = Math.max(0, Math.min(1, parseFloat(args[++i] || "0.9")));
    else if (args[i] === "--seed") seed = parseInt(args[++i] || "20260905", 10);
  }
  if (!input || !fs.existsSync(input)) {
    console.error("用法: npx tsx scripts/prepare-submit.ts <input.txt> [--out <file>] [--intensity 0.9] [--seed N]");
    process.exit(1);
  }
  const raw = fs.readFileSync(input, "utf-8");
  if (!raw.trim()) { console.error("空文件"); process.exit(1); }

  const genre = classifyGenre(raw);
  console.log(`体裁自动识别: ${genre.genre}（置信 ${genre.confidence}%）`);

  console.log(`去味中（强度 ${intensity}，seed ${seed}，朱雀档）...`);
  const t0 = Date.now();
  const output = humanize(raw, { intensity, seed, zhuqueMode: true, style: genre.genre === "dialogue" ? "casual" : "plain" });
  console.log(`完成（${Date.now() - t0}ms）\n`);

  const repIn = detectZhuque(raw);
  const repOut = detectZhuque(output);
  const track = trackForGenre(genre.genre);
  const line = CALIB[track];
  const pred = Math.max(0, Math.min(100, line.a * repOut.composite + line.b));
  const x40 = line.x40;

  const dest = out || input.replace(/\.txt$/i, "") + ".submit.txt";
  fs.writeFileSync(dest, output, "utf-8");

  console.log("═".repeat(60));
  console.log("送检稿信息");
  console.log("═".repeat(60));
  console.log(`文件: ${dest}`);
  console.log(`字数: ${output.replace(/\s/g, "").length}（官方要求 ≥350 字${repOut.stats.chars < 350 ? " ⚠️ 未达门槛！" : " ✅"}）`);
  console.log(`本地 aiScore: ${aiScore(raw).score} → ${aiScore(output).score}`);
  console.log(`朱雀面板综合分: ${repIn.composite} → ${repOut.composite}`);
  console.log(`体裁线预测官方分: ${pred.toFixed(1)}%（${track} 线，过人线 aiScore ≤ ${x40}）`);
  console.log(`预测判定: ${pred <= 40 ? "🟢 预计过线" : pred <= 60 ? "🟡 中风险" : "🔴 高风险，建议再跑一轮"}`);
  console.log("─".repeat(60));
  console.log(`下一步:`);
  console.log(`1. 打开朱雀官网: ${ZHUQUE_URL}`);
  console.log(`2. 粘贴 ${dest} 全文（≥350 字）送检`);
  console.log(`3. 拿到官方百分数后回填：`);
  console.log(`   npx tsx scripts/prepare-submit.ts --record ${aiScore(output).score} <官方百分数> ${track}`);
}

// ---- 入口 ----
const argv = process.argv.slice(2);
if (argv[0] === "--record") record(argv.slice(1));
else prepare(argv);
