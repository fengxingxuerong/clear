/**
 * scripts/zhuque-v4-pipeline.ts
 * ---------------------------------------------------------
 * v4 官方送检 + 标定脚手架（v3 改造版：去硬编码路径、支持中段档位扫描）
 *
 * 目标（docs/fingerprint-and-zhuque-calibration.md §3.8 计划 1）：
 *   每条体裁线补 1~2 个「非饱和中段 x 值」，把自由度从 1 扩到 3+，
 *   从而能给出带 S.E. 置信区间的正式标定。
 *
 * 子命令：
 *  1) scan    —— 对每个体裁扫描多档强度，打印 (intensity, aiScore, chars) 表，
 *                用于挑选命中目标区间的档位（论说≈15/22、叙事≈15/30、对话≈15/35）
 *  2) prepare —— 按 manifest 中指定的 (id, genre, intensity, zhuqueMode, srcText) 生成
 *                送检拼接文本（>350 字，不够自动补轮次）到 scripts/zhuque-v4-out/，
 *                并同步生成待填官分的 TSV：scripts/calibration-input-v4.tsv
 *  3) report  —— 打印 v4 拟合报告（从 calibration-data-v4-genres.json 读）
 *
 * 用法：
 *   npx tsx scripts/zhuque-v4-pipeline.ts scan
 *   npx tsx scripts/zhuque-v4-pipeline.ts prepare
 *   （浏览器自动化/人工把 v4-out 各 txt 送朱雀官方后，填 calibration-input-v4.tsv，
 *     再执行 scripts/archive/zhuque-v4-fit.ts 完成 OLS）
 *
 * 送检链接：https://matrix.tencent.com/ai-detect/ai_gen （要求 ≥350 字）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiScore } from "../src/engine/humanize-metrics";
import { humanize } from "../src/engine/humanize";
import { sentenceStats } from "../src/engine/humanize-primitives";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "zhuque-v4-out");
const INPUT_TSV = path.join(__dirname, "calibration-input-v4.tsv");
const V2_JSON = path.join(__dirname, "calibration-data-v2-genres.json");
const SEED = 20260826;
const MIN_CHARS = 350; // 朱雀最低字数门槛

/* ============================================================
   原文语料（复用 v2 归档数据 + scripts/calibrate/human 人写语料）
   ============================================================ */
function loadV2Text(genre: string, level: string): string {
  const raw = JSON.parse(fs.readFileSync(V2_JSON, "utf8"));
  const row = raw.find((r: any) => r.genre === genre && r.level === level);
  if (!row) throw new Error(`v2 找不到 genre=${genre} level=${level}`);
  return row.text;
}

const HUMAN_CORPUS = [
  { id: "H-NEW1", file: "夜宵碎念.txt", desc: "人写·夜宵碎念（口语随笔）" },
  { id: "H-NEW2", file: "宜家半日游.txt", desc: "人写·宜家半日游（购物叙事）" },
  { id: "H-NEW3", file: "楼下早餐摊.txt", desc: "人写·楼下早餐摊（市井描写）" },
  { id: "H-NEW4", file: "长文·搬家记.txt", desc: "人写·搬家记（长文叙事）" },
];

function loadHumanCorpus(id: string): string {
  const meta = HUMAN_CORPUS.find((h) => h.id === id);
  if (!meta) throw new Error(`未知人写语料 id=${id}`);
  return fs.readFileSync(path.join(__dirname, "calibrate", "human", meta.file), "utf8");
}

/* ============================================================
   scan —— 扫描各体裁档位，打印 aiScore 分布
   ============================================================ */
function cmdScan() {
  // 论说原文（v0.7 数字密集型）
  const EXPO_O1_RAW = fs.readFileSync(path.join(__dirname, "archive", "EXPO_O1_RAW.txt"), "utf8");

  const groups: { genre: string; label: string; targets: number[]; srcFn: () => string }[] = [
    { genre: "expository", label: "论说文", targets: [15, 22], srcFn: () => EXPO_O1_RAW },
    { genre: "narrative", label: "叙事文", targets: [15, 30], srcFn: () => loadV2Text("narrative", "原文") },
    { genre: "dialogue", label: "对话体", targets: [15, 35], srcFn: () => loadV2Text("dialogue", "原文") },
  ];

  console.log(`══════════ v4 档位扫描 (seed=${SEED}) ══════════`);
  for (const g of groups) {
    console.log(`\n【${g.label}】目标中段 x：${g.targets.join(" / ")}`);
    console.log(`  强度    aiScore   burstiness   字数`);
    for (let i = 1; i <= 9; i++) {
      const intensity = i / 10;
      const t = humanize(g.srcFn(), { intensity, zhuqueMode: true, seed: SEED });
      const ai = aiScore(t);
      const cv = sentenceStats(t).cv;
      const mark = g.targets.some((tg) => Math.abs(ai.score - tg) <= 3) ? "  ◀◀ 命中区间" : "";
      console.log(`  ${intensity.toFixed(1)}     ${String(ai.score).padStart(3)}     ${cv.toFixed(2).padStart(6)}     ${t.replace(/\s/g, "").length}${mark}`);
    }
  }
  console.log(`\n【人写语料 aiScore（应天然低，直接送检）】`);
  for (const h of HUMAN_CORPUS) {
    const t = loadHumanCorpus(h.id);
    const ai = aiScore(t);
    console.log(`  ${h.id} ${h.desc}  aiScore=${ai.score}  字数=${t.replace(/\s/g, "").length}`);
  }
}

/* ============================================================
   prepare —— 生成送检包（根据上面的扫描结果人工选定档位）
   ============================================================ */
interface SampleSpec {
  id: string;
  genre: "expository" | "narrative" | "dialogue" | "humanHand";
  genreName: string;
  level: string;
  intensity: number;
  zhuqueMode: boolean;
  seed?: number;
  srcFn: () => string;
  note: string;
}

const SAMPLES: SampleSpec[] = [
  // —— 论说（v4 扫描：i=0.3 → x≈16 中段；原文 x=92 高端重测）——
  { id: "O4", genre: "expository", genreName: "论说文", level: "中段0.3档", intensity: 0.3, zhuqueMode: true, seed: SEED, srcFn: () => fs.readFileSync(path.join(__dirname, "archive", "EXPO_O1_RAW.txt"), "utf8"), note: "v4·论说中段 x≈16" },
  { id: "O5", genre: "expository", genreName: "论说文", level: "原文", intensity: 0, zhuqueMode: false, srcFn: () => fs.readFileSync(path.join(__dirname, "archive", "EXPO_O1_RAW.txt"), "utf8"), note: "v4·论说原文 x≈92 高端校准（v0.7 旧标 33 已漂移）" },
  // —— 叙事中段（i=0.1 → x≈18，阈值效应拿不到 30，18 为当前可及中段）——
  { id: "N4", genre: "narrative", genreName: "叙事文", level: "中段0.1档", intensity: 0.1, zhuqueMode: true, seed: SEED, srcFn: () => loadV2Text("narrative", "原文"), note: "v4·叙事中段 x≈18" },
  // —— 对话中段（i=0.3/seed2 → x≈22；i=0.1/seed3 → x≈35）——
  { id: "D4", genre: "dialogue", genreName: "对话体", level: "中段0.3档", intensity: 0.3, zhuqueMode: true, seed: SEED + 7, srcFn: () => loadV2Text("dialogue", "原文"), note: "v4·对话中段低 x≈22" },
  { id: "D5", genre: "dialogue", genreName: "对话体", level: "中段0.1档", intensity: 0.1, zhuqueMode: true, seed: SEED + 14, srcFn: () => loadV2Text("dialogue", "原文"), note: "v4·对话中段高 x≈35" },
  // —— 人写新稿（4 篇语料，全部送检锁定人写截距）——
  { id: "H-NEW1", genre: "humanHand", genreName: "纯人写稿", level: "无处理", intensity: 0, zhuqueMode: false, srcFn: () => loadHumanCorpus("H-NEW1"), note: "v4·人写·夜宵碎念" },
  { id: "H-NEW2", genre: "humanHand", genreName: "纯人写稿", level: "无处理", intensity: 0, zhuqueMode: false, srcFn: () => loadHumanCorpus("H-NEW2"), note: "v4·人写·宜家半日游" },
  { id: "H-NEW3", genre: "humanHand", genreName: "纯人写稿", level: "无处理", intensity: 0, zhuqueMode: false, srcFn: () => loadHumanCorpus("H-NEW3"), note: "v4·人写·楼下早餐摊" },
  { id: "H-NEW4", genre: "humanHand", genreName: "纯人写稿", level: "无处理", intensity: 0, zhuqueMode: false, srcFn: () => loadHumanCorpus("H-NEW4"), note: "v4·人写·搬家记" },
];

function cmdPrepare() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) fs.unlinkSync(path.join(OUT_DIR, f));

  console.log(`═══════════════ v4 送检样本生成 (seed=${SEED}) ═══════════════`);
  console.log(`输出目录：${OUT_DIR}\n`);
  const manifest: any[] = [];

  for (const s of SAMPLES) {
    const seed = s.seed ?? SEED;
    const base = s.intensity === 0 ? s.srcFn() : humanize(s.srcFn(), { intensity: s.intensity, zhuqueMode: s.zhuqueMode, seed });
    const ai = aiScore(base);
    let upload = base;
    let round = 1;
    while (upload.replace(/\s/g, "").length < MIN_CHARS + 50) {
      const t2 = s.intensity === 0 ? s.srcFn() : humanize(s.srcFn(), { intensity: s.intensity, zhuqueMode: s.zhuqueMode, seed: seed + round });
      upload = upload + "\n\n" + t2;
      round++;
    }
    const chars = upload.replace(/\s/g, "").length;
    const fname = `${s.id}-${s.genreName}-${s.level}.txt`.replace(/[\\/:*?"<>|\s]/g, "_");
    fs.writeFileSync(path.join(OUT_DIR, fname), upload, "utf8");
    manifest.push({ id: s.id, genre: s.genre, level: s.level, aiScore: ai.score, chars, file: fname, note: s.note });
    console.log(`✅ ${s.id} ${s.genreName} ${s.level}  aiScore=${ai.score}  字数=${chars}  rounds=${round}  → ${fname}`);
  }

  const tsvHeader = "id\tgenre\tlevel\taiScore\tchars\tfile\tzhuqueOfficialPct\tcomment\n";
  const tsvBody = manifest.map((m) => `${m.id}\t${m.genre}\t${m.level}\t${m.aiScore}\t${m.chars}\t${m.file}\t\t${m.note}`).join("\n");
  fs.writeFileSync(INPUT_TSV, tsvHeader + tsvBody, "utf8");
  console.log(`\n📝 待填 TSV：${INPUT_TSV}`);
  console.log(`   送检地址：https://matrix.tencent.com/ai-detect/ai_gen （每篇 ≥${MIN_CHARS} 字，已保证）`);
}

const cmd = process.argv[2] ?? "help";
if (cmd === "scan") cmdScan();
else if (cmd === "prepare") cmdPrepare();
else {
  console.log(`用法：
  npx tsx scripts/zhuque-v4-pipeline.ts scan     # 扫描各体裁档位 aiScore，挑选中段档
  npx tsx scripts/zhuque-v4-pipeline.ts prepare  # 按 SAMPLES 生成送检包 + TSV
  （送检后官分填 scripts/calibration-input-v4.tsv，再做 OLS 拟合）`);
}
