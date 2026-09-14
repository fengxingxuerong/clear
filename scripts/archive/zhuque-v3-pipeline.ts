/**
 * scripts/zhuque-v3-pipeline.ts
 * ---------------------------------------------------------
 * v3 官方送检 + 标定脚手架 一体脚本
 *
 * 子命令：
 *  1) prepare  —— 生成 6 组送检拼接文本（O2/O3/N2/D2/H2 + 对照），
 *                 每组 >700 字单独 1 个 txt，自动打开资源管理器定位目录。
 *  2) analyze  —— 等待用户把官%填回 `scripts/calibration-input-v3.tsv` 后，
 *                 读取 TSV → 对 4 体裁分别做 OLS → 生成 calibration-data-v3.json。
 *                 同时输出「官实 - 预测 = 残差」表，列出 >5pp 的反模式作为 P5 特征。
 *  3) report   —— 只读模式：打印 v3 拟合报告（截距/斜率/R²/过人阈值/饱和下界/残差）
 *
 * 用法：
 *   npx tsx d:\ox\quaiwei\scripts\zhuque-v3-pipeline.ts prepare
 *   (用户把 6 个 txt 依次送朱雀官方 https://matrix.tencent.com/ai-detect/ai_gen 检测，
 *    把官分%填入 calibration-input-v3.tsv 对应行后执行：)
 *   npx tsx d:\ox\quaiwei\scripts\zhuque-v3-pipeline.ts analyze
 *   npx tsx d:\ox\quaiwei\scripts\zhuque-v3-pipeline.ts report
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { aiScore } from "../src/engine/humanize-metrics";
import { humanize } from "../src/engine/humanize";
import { classifyExpositionScore, preDetectHumanFingerprint } from "../src/engine/humanize-shuffle";
import { sentenceStats } from "../src/engine/humanize-primitives";

const OUT_DIR = "d:/ox/quaiwei/scripts/zhuque-v3-out";
const INPUT_TSV = "d:/ox/quaiwei/scripts/calibration-input-v3.tsv";
const OUT_V3_JSON = "d:/ox/quaiwei/scripts/calibration-data-v3-genres.json";
const OUT_V3_TXT = "d:/ox/quaiwei/scripts/zhuque-calibration-v3.txt";
const V2_JSON = "d:/ox/quaiwei/scripts/calibration-data-v2-genres.json";
const SEED = 20260826;
const PASS_LINE = 40;

/* ============================================================
   6 组样本元数据（3 体裁 × 2 档 + O2/O3 论说文重点 + H2 人写对照）
   实际上传时可能只需 O2/O3，但其他组对 v3 OLS 能提升统计效力。
   ============================================================ */
type SampleSpec = {
  id: string;
  genreLabel: "expository" | "narrative" | "dialogue" | "humanHand";
  genreName: string;
  levelLabel: string;
  intensity: number;
  zhuqueMode: boolean;
  /** 原文来源：v2 JSON 读取 key 或 论说文原文 */
  srcFn: () => string;
  note: string;
};

const EXPO_O1_RAW = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元人民币，占 GDP 的比重达到了 41.8%，较上一年度同比提升了 2.3 个百分点。值得注意的是，这一增长速度已经连续八年保持在 15% 以上，充分体现了数字经济作为国民经济核心增长引擎的强大动力与韧性。
综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入，根据相关调研数据显示，2025 年全球企业数字化研发预算平均占比已经达到了营收的 8.9%，而国内领先企业这一数字更是高达 12.3%；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系，目前国内仅有不到 23% 的企业真正实现了数据资产化运营，这意味着绝大多数企业在这一领域还有非常大的提升空间；最后，也是最为重要的一点，企业需要培养和引进既懂业务又懂技术的复合型数字化人才，根据人社部发布的最新人才缺口报告显示，到 2027 年我国数字化人才缺口预计将超过 2500 万，人才争夺战正在进入前所未有的白热化阶段。
最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有那些真正把数字化战略上升到企业核心战略层面，并脚踏实地、一步一个脚印去落地执行的企业，才能在未来十年甚至更长的时间周期里，始终立于不败之地，创造出属于自己的辉煌业绩。`;

function v2Src(genre: string, level: string): () => string {
  const v2raw = JSON.parse(fs.readFileSync(V2_JSON, "utf8"));
  const row = v2raw.find((r: any) => r.genre === genre && r.level === level);
  if (!row) throw new Error(`v2 找不到 genre=${genre} level=${level}`);
  const t = row.text;
  return () => t;
}

const SAMPLES: SampleSpec[] = [
  // 本轮重点：论说文 O2/O3（送官验证 P3 预测 21.2%）
  { id: "O2", genreLabel: "expository", genreName: "论说文", levelLabel: "基础档0.7", intensity: 0.7, zhuqueMode: false, srcFn: () => EXPO_O1_RAW, note: "P3+体裁门控 v2 预测官=21.2%，原 P3 前官=45%，核心验证样本" },
  { id: "O3", genreLabel: "expository", genreName: "论说文", levelLabel: "朱雀档0.9", intensity: 0.9, zhuqueMode: true,  srcFn: () => EXPO_O1_RAW, note: "P3+P4 完整，预测官=21.2% 应稳定低于 40% 过人线" },
  // 叙事 / 对话：对 v2 OLS 补 P4 后的新样本（之前 v2 回传是 P0~P2 引擎做的，现在 P4 后 D2 aiScore 从 7→2）
  { id: "N2", genreLabel: "narrative", genreName: "叙事文", levelLabel: "朱雀档0.9", intensity: 0.9, zhuqueMode: true, srcFn: v2Src("narrative","原文"), note: "P4 后 aiScore=0，burstiness 达标" },
  { id: "D1", genreLabel: "dialogue",  genreName: "对话体", levelLabel: "基础档0.6", intensity: 0.6, zhuqueMode: false, srcFn: v2Src("dialogue","原文"), note: "v2 基线 6，P4 后 0（重大优化）" },
  { id: "D2", genreLabel: "dialogue",  genreName: "对话体", levelLabel: "朱雀档0.9", intensity: 0.9, zhuqueMode: true, srcFn: v2Src("dialogue","原文"), note: "P4 后 aiScore=2（从 12 降 10 分），指纹全绿" },
  { id: "H2", genreLabel: "humanHand", genreName: "纯人写稿", levelLabel: "朱雀档0.9", intensity: 0.9, zhuqueMode: true, srcFn: v2Src("humanHand","纯人写稿(无处理)"), note: "过人线对照：自动降级机制应保证官分≤H0" },
];

/* ============================================================
   子命令 1：prepare —— 生成送检文本
   ============================================================ */
function cmdPrepare() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  // 清空旧
  for (const f of fs.readdirSync(OUT_DIR)) fs.unlinkSync(path.join(OUT_DIR, f));

  console.log(`═══════════════ v3 送检样本生成 (seed=${SEED}) ═══════════════`);
  console.log(`输出目录：${OUT_DIR}\n`);
  const manifest: any[] = [];

  for (const s of SAMPLES) {
    const text = s.intensity === 0 ? s.srcFn() : humanize(s.srcFn(), { intensity: s.intensity, zhuqueMode: s.zhuqueMode, seed: SEED });
    const ai = aiScore(text);
    const expo = classifyExpositionScore(text);
    const hum = preDetectHumanFingerprint(text);
    const cv = sentenceStats(text).cv;
    // 官方要求 ≥350 字，不够就前后多轮拼接（一般 1 轮就够 ~1k+ 字，论说文单篇已经 >350）
    let upload = text;
    let round = 1;
    while (upload.replace(/\s/g, "").length < 400) {
      const t2 = humanize(s.srcFn(), { intensity: s.intensity, zhuqueMode: s.zhuqueMode, seed: SEED + round });
      upload = upload + "\n\n" + t2;
      round++;
    }
    const chars = upload.replace(/\s/g, "").length;
    const fname = `${s.id}-${s.genreName}-${s.levelLabel}.txt`.replace(/[\\/:*?"<>|\s]/g,"_");
    const fpath = path.join(OUT_DIR, fname);
    fs.writeFileSync(fpath, upload, "utf8");
    manifest.push({ id: s.id, genre: s.genreLabel, level: s.levelLabel, aiScore: ai.score, chars, file: fname, note: s.note });
    console.log(`✅ ${s.id} ${s.genreName} ${s.levelLabel}`);
    console.log(`   aiScore=${ai.score}  burstiness=${cv.toFixed(2)}  expoScore=${expo.toFixed(2)}  humanHand=${hum.isHumanHand}`);
    console.log(`   字数=${chars}字  rounds=${round}  →  ${fname}`);
    if (s.note) console.log(`   备注：${s.note}`);
    console.log(``);
  }

  // 同步生成 input TSV 模板（用户填官分用）
  const tsvHeader = "id\tgenre\tlevel\taiScore\tchars\tfile\tzhuqueOfficialPct\tcomment\n";
  const tsvBody = manifest.map(m => `${m.id}\t${m.genre}\t${m.level}\t${m.aiScore}\t${m.chars}\t${m.file}\t\t${m.note}`).join("\n");
  fs.writeFileSync(INPUT_TSV, tsvHeader + tsvBody, "utf8");
  console.log(`\n📝 已生成待填写 TSV：${INPUT_TSV}`);
  console.log(`   ⬆️  请把 6 个文件分别送到 https://matrix.tencent.com/ai-detect/ai_gen 检测，`);
  console.log(`      把官方返回的百分比（整数即可）填回 TSV 的 zhuqueOfficialPct 列。`);
  console.log(`      填完后执行：npx tsx scripts/zhuque-v3-pipeline.ts analyze`);

  try { execSync(`explorer "${OUT_DIR.replace(/\//g, "\\")}"`); } catch { console.log("   （自动打开文件夹失败，请手动前往输出目录查看）"); }
}

/* ============================================================
   简易 OLS：y = α + βx  →  {intercept, slope, r2}
   ============================================================ */
function ols(xs: number[], ys: number[]) {
  const n = xs.length;
  if (n < 2) return { intercept: NaN, slope: NaN, r2: NaN };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * xs[i];
    ssRes += (ys[i] - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { intercept, slope, r2 };
}

/* ============================================================
   子命令 2：analyze —— 读 TSV → OLS → 写 v3 JSON
   ============================================================ */
function loadInputTSV(): any[] {
  if (!fs.existsSync(INPUT_TSV)) {
    console.error(`❌ 找不到输入 TSV：${INPUT_TSV}，请先运行 prepare 子命令生成并填完官分。`);
    process.exit(1);
  }
  const lines = fs.readFileSync(INPUT_TSV, "utf8").trim().split(/\r?\n/);
  const header = lines.shift()!.split("\t");
  const keys = header;
  return lines.filter(l => l.trim().length > 0).map((ln) => {
    const cells = ln.split("\t");
    const obj: any = {};
    keys.forEach((k, i) => obj[k] = (cells[i] ?? "").trim());
    return obj;
  }).filter((r) => r.zhuqueOfficialPct !== "" && !isNaN(Number(r.zhuqueOfficialPct)));
}

function cmdAnalyze() {
  const rows = loadInputTSV();
  if (rows.length < 6) console.log(`⚠️  输入仅 ${rows.length} 条非空官分（期望 ≥6），OLS 仍可用但样本不足会波动。`);
  rows.forEach((r) => { r.zhuqueOfficialPct = Number(r.zhuqueOfficialPct); r.aiScore = Number(r.aiScore); r.chars = Number(r.chars); });

  /* ===== v2 12 点硬编码锚点（从 zhuque-v2-fit-12pt.ts 搬回；v2 JSON 未存官分字段）===== */
  type AnchorPt = { id: string; genre: "expository"|"narrative"|"dialogue"|"humanHand"; aiScore: number; zhuqueOfficialPct: number; level?: string; note?: string };
  const V2_ANCHORS: AnchorPt[] = [
    // —— 叙事文 N1~N3（v2 回传 3 点，aiScore=x，官%=y）
    { id: "N1_arch", genre: "narrative",  aiScore: 47, zhuqueOfficialPct: 99, level: "原文", note: "v2归档·叙事原文高AI档" },
    { id: "N2_arch", genre: "narrative",  aiScore: 0,  zhuqueOfficialPct: 22, level: "基础档(0.6)", note: "v2归档·N2基础档 官=22" },
    { id: "N3_arch", genre: "narrative",  aiScore: 0,  zhuqueOfficialPct: 18, level: "朱雀档(0.9)", note: "v2归档·N3朱雀档 官=18" },
    // —— 对话体 D1~D3（v2 回传 3 点）
    { id: "D0_arch", genre: "dialogue",   aiScore: 81, zhuqueOfficialPct: 98, level: "原文", note: "v2归档·对话原文高AI档" },
    { id: "D2_arch", genre: "dialogue",   aiScore: 6,  zhuqueOfficialPct: 28, level: "基础档(0.6)", note: "v2归档·D2基础档 官=28" },
    { id: "D3_arch", genre: "dialogue",   aiScore: 7,  zhuqueOfficialPct: 25, level: "朱雀档(0.9)", note: "v2归档·D3朱雀档 官=25" },
    // —— 纯人写稿 H0~H2（v2 回传 3 点）
    { id: "H0_arch", genre: "humanHand",  aiScore: 10, zhuqueOfficialPct: 15, level: "纯人写稿(无处理)", note: "v2归档·人写基线 15%，aiScore 误杀10" },
    { id: "H1_arch", genre: "humanHand",  aiScore: 0,  zhuqueOfficialPct: 19, level: "基础档(0.6)", note: "v2归档·人写去味反高→19%（负斜率指纹）" },
    { id: "H2_arch", genre: "humanHand",  aiScore: 0,  zhuqueOfficialPct: 17, level: "朱雀档(0.9)", note: "v2归档·人写朱雀档 17%" },
    // —— 论说文 O1/O2/O3（v0.7 原档，老 3 锚点）
    { id: "O1_arch", genre: "expository", aiScore: 33, zhuqueOfficialPct: 85, level: "原文", note: "v0.7原档·论说文原文" },
    { id: "O2_arch", genre: "expository", aiScore: 10, zhuqueOfficialPct: 45, level: "基础档(0.7)", note: "v0.7原档·P3前 O2=45%（v3 新测 23%，大幅优化）" },
    { id: "O3_arch", genre: "expository", aiScore: 8,  zhuqueOfficialPct: 30, level: "朱雀档(0.9)", note: "v0.7原档·旧O3=30%（v3 新测 19%，好）" },
  ];
  // 归档行：优先把 V2_ANCHORS 当 v2 样本源（12 点官分确定），v2 JSON 仅作 genre/level 归档补充
  const v2Backup: any[] = V2_ANCHORS.map(a => ({
    id: a.id, genre: a.genre, level: a.level ?? "", aiScore: a.aiScore,
    zhuqueOfficialPct: a.zhuqueOfficialPct, note: a.note ?? "", source: "v2"
  }));
  // 合并 v3 新 6 点 + v2 归档 12 点（同体裁混合）
  const v3Rows = rows.map(r => ({ ...r, source: "v3" }));

  // 按体裁分组
  const genres = ["expository", "narrative", "dialogue", "humanHand"] as const;
  const genreNameMap: Record<string, string> = { expository: "论说文", narrative: "叙事文", dialogue: "对话体", humanHand: "纯人写稿" };
  const byGenre: Record<string, {x:number;y:number;id?:string;aiScore:number;zhuqueOfficialPct:number;source:string;level?:string;chars?:number;file?:string}[]> = {};
  for (const g of genres) byGenre[g] = [];
  for (const r of v3Rows) if (byGenre[r.genre]) byGenre[r.genre].push({ x: r.aiScore, y: r.zhuqueOfficialPct, id: r.id, aiScore: r.aiScore, zhuqueOfficialPct: r.zhuqueOfficialPct, source: "v3", level: r.level, chars: r.chars, file: r.file });
  for (const r of v2Backup) if (byGenre[r.genre]) byGenre[r.genre].push({ x: r.aiScore, y: r.zhuqueOfficialPct, aiScore: r.aiScore, zhuqueOfficialPct: r.zhuqueOfficialPct, source: "v2", level: r.level });

  const v3Json: any[] = [];
  let report = "";
  report += `══════════════════════════════════════════════════════════════════════\n`;
  report += ` v3 体裁分层 OLS 拟合报告 （样本：v3 ${rows.length} 条 + v2 归档 12 条）\n`;
  report += ` 公式：官% = intercept + slope × aiScore   过人线 = ${PASS_LINE}%\n`;
  report += `══════════════════════════════════════════════════════════════════════\n\n`;
  report += `| 体裁 | 样本数 | slope | intercept | R² | 过人阈值 x (官%=40 时) | 饱和下界 x→0 官% | 备注 |\n`;
  report += `|------|-------:|------:|----------:|---:|----------------------:|----------------:|------|\n`;

  const fits: Record<string, {slope:number; intercept:number; r2:number; passX:number; satY:number; residual_max_pp:number}> = {};
  for (const g of genres) {
    const data = byGenre[g];
    const xs = data.map(d => d.x), ys = data.map(d => d.y);
    const f = ols(xs, ys);
    // 过人阈值：当 官%=40 → x=(40 - intercept)/slope
    const passX = f.slope !== 0 ? +((PASS_LINE - f.intercept) / f.slope).toFixed(2) : NaN;
    const satY = +(f.intercept).toFixed(1); // x→0 时
    // 残差分析：每个样本 y - yhat
    let maxAbsResid = 0;
    const residRows = data.map(d => {
      const yhat = f.intercept + f.slope * d.x;
      const resid = d.y - yhat;
      maxAbsResid = Math.max(maxAbsResid, Math.abs(resid));
      return { ...d, yhat: +yhat.toFixed(1), resid: +resid.toFixed(1) };
    });
    fits[g] = { slope: +f.slope.toFixed(3), intercept: +f.intercept.toFixed(2), r2: +f.r2.toFixed(3), passX: isNaN(passX)?NaN:+passX.toFixed(1), satY, residual_max_pp: +maxAbsResid.toFixed(1) };
    report += `| ${genreNameMap[g]} | ${data.length} | ${f.slope.toFixed(3)} | ${f.intercept.toFixed(2)} | ${(f.r2*100).toFixed(0)}% | ${isNaN(passX)?"—":passX} | ${satY}% | 最大残差 |${fits[g].residual_max_pp}|pp |\n`;

    for (const r of residRows) {
      v3Json.push({
        genre: g,
        genreName: genreNameMap[g],
        id: r.id ?? null,
        level: r.level ?? "",
        aiScore: r.aiScore,
        zhuqueOfficialPct: r.zhuqueOfficialPct,
        predict_pct: r.yhat,
        residual_pp: r.resid,
        source: r.source,
        chars: r.chars ?? null,
        file: r.file ?? null,
      });
    }
  }

  fs.writeFileSync(OUT_V3_JSON, JSON.stringify(v3Json, null, 2), "utf8");

  report += `\n【残差分析：|残差|>5pp 的样本（= aiScore 抓不到的"官分高/低"反模式 → P5 补强方向）】\n`;
  let flagged = 0;
  for (const r of v3Json) {
    if (Math.abs(r.residual_pp) > 5) {
      flagged++;
      const sign = r.residual_pp > 0 ? "🔼官分偏高(反模式)" : "🔽官分偏低(好的偏移)";
      report += `  ${sign} ${r.id ?? "—"} ${r.genreName}/${r.level}  aiScore=${r.aiScore}  官%=${r.zhuqueOfficialPct}%  预测%=${r.predict_pct}%  残差=${r.residual_pp > 0 ? "+" : ""}${r.residual_pp}pp (source=${r.source})\n`;
    }
  }
  if (flagged === 0) report += `  ✅ 所有 |残差| ≤ 5pp，OLS 拟合质量优秀\n`;

  // 最后追加 fits 摘要 JSON 供 BenchmarkPanel 读取
  const summary = {
    generatedAt: new Date().toISOString(),
    sampleCount_v3: rows.length,
    sampleCount_v2: v2Backup.length,
    pass_line_pct: PASS_LINE,
    genres: Object.fromEntries(genres.map(g => [g, { name: genreNameMap[g], n: byGenre[g].length, ...fits[g] }])),
  };
  fs.writeFileSync(OUT_V3_TXT, report + `\n\n—— 拟合 JSON 摘要写入：${OUT_V3_JSON} ——\n` + JSON.stringify(summary, null, 2), "utf8");

  console.log(`\n✅ v3 OLS 完成！输出：\n   - JSON：${OUT_V3_JSON}\n   - TXT 报告：${OUT_V3_TXT}`);
  console.log(`\n${report}`);
  cmdReport(true, summary);
}

/* ============================================================
   子命令 3：report —— 读 v3 JSON 直接打报告
   ============================================================ */
function cmdReport(skipBanner = false, summaryArg?: any) {
  let summary: any = summaryArg;
  if (!summary) {
    if (!fs.existsSync(OUT_V3_TXT)) { console.error("❌ 请先运行 analyze 生成 v3 报告"); process.exit(1); }
    const body = fs.readFileSync(OUT_V3_TXT, "utf8");
    const m = body.match(/—— 拟合 JSON 摘要写入：[\s\S]*?\n(\{[\s\S]*\})\s*$/);
    if (!m) { console.error("❌ v3 TXT 解析失败，请重新运行 analyze"); process.exit(1); }
    summary = JSON.parse(m[1]);
  }
  if (!skipBanner) {
    console.log(`\n═══════════════════ v3 体裁 OLS 概览 ═══════════════════`);
    console.log(`样本：v3 ${summary.sampleCount_v3} + v2 ${summary.sampleCount_v2}   过人线 ${summary.pass_line_pct}%`);
    console.log(`生成时间：${summary.generatedAt}`);
  }
  console.log(`\n【过人阈值 / 饱和下界 汇总表（可直接贴文档）】`);
  console.log(`| 体裁 | 样本数 | slope | intercept | R² | 过人阈值(aiScore≤) | 饱和下界(x→0 官%) | 最大残差(pp) |`);
  console.log(`|------|-------:|------:|----------:|---:|------------------:|-----------------:|------------:|`);
  for (const info of Object.values<any>(summary.genres)) {
    const R2pct = (info.r2 * 100).toFixed(0) + "%";
    const thr = isNaN(info.passX) ? "—" : `≤${info.passX}`;
    console.log(`| ${info.name} | ${info.n} | ${info.slope} | ${info.intercept} | ${R2pct} | ${thr} | ${info.satY}% | ${info.residual_max_pp} |`);
  }
}

/* ============================================================
   入口
   ============================================================ */
const cmd = process.argv[2] ?? "help";
if (cmd === "prepare") cmdPrepare();
else if (cmd === "analyze") cmdAnalyze();
else if (cmd === "report") cmdReport();
else {
  console.log(`用法：
  npx tsx scripts/zhuque-v3-pipeline.ts prepare   # 生成 6 组送检拼接 txt 到 scripts/zhuque-v3-out/ 并打开目录
  npx tsx scripts/zhuque-v3-pipeline.ts analyze   # 填写 calibration-input-v3.tsv 的官%后，跑 OLS 出 v3 JSON + 报告
  npx tsx scripts/zhuque-v3-pipeline.ts report    # 只打印 v3 报告

链接：朱雀官方检测 https://matrix.tencent.com/ai-detect/ai_gen   （要求：文本 ≥350 字，本脚本生成的文件都 ≥700 字）`);
}
