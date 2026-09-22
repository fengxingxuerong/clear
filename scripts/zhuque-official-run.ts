/**
 * scripts/zhuque-official-run.ts —— 官方 API 一键送检 + 入凭证账本（零手点）
 *
 * 为什么存在：网页版送检每次要人工过滑块、有当日次数上限，所以「把标定点拿官方真值」
 * 一直是手工活，18 个点的凭证覆盖率长期停在 0/18。2026-09 朱雀在腾讯云 EdgeOne Makers
 * 开了官方 API（@makers/zhuque-text，50 万 token/月免费），本脚本把整条链路自动化：
 *
 *   重建标定点文本 → 官方 API 送检 → 原始 JSON 归档 → sealApi 入凭证账本（api-response 认证级）
 *
 * 与「网页版截图级」的区别：api-response 级的可复核载体是 API 原始 JSON（字节哈希 +
 * 审计时从 JSON 复算分数比对），与页面截图同等算"认证"（见 zhuque-evidence.ts 分级注释）。
 *
 * 两个模式：
 *   --recheck（默认） 重新送检 calibration-data.json 里已有的 18 个点。
 *                    用途：把它们的凭证从"回填级"升到"api-response 认证级"。
 *                    不改 calibration-data.json（y 保留历史值）；若 API 重测与历史 y 不符，
 *                    sealApi 当场警告（模型可能已更新 → 该重拟合），但不拦、audit 不报硬伤。
 *   --v4             额外送检 v4 的 8 个中段点（scripts/zhuque-v4-out/ 里已备好的文本），
 *                    并把它们**追加**进 calibration-data.json 的 points（x=当前引擎 aiScore、
 *                    y=API 官分）后 sealApi。这一步可能让 calib-sanity 的锚点误差 >8pp 转红——
 *                    那是"旧线拟合不了新数据"的诚实信号，跟着跑 scripts/zhuque-v4-fit.ts
 *                    看重拟合报告，再人工同步 zhuque-calib.ts（不自动改运行参数）。
 *
 * 用法：
 *   ZHUQUE_API_KEY=xxx npx tsx scripts/zhuque-official-run.ts [--recheck] [--v4] [--dry-run]
 *
 * Key 只从环境变量读：写进命令行会留在 shell 历史，写进文件会被 git 看见，贴进对话会明文落盘。
 * 幂等：账本里已有 api-response 记录的 id 直接跳过（凭证不可覆盖，重复跑不会重复入账）。
 * 逐篇串行送检（并发只会更快烧额度；50 万 token/月对 18+8 篇约 600 字的文本绰绰有余）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ZHUQUE_OFFICIAL_DETECTOR, classifyViaDetector } from "../src/api/detector";
import { aiScore } from "../src/engine/humanize-metrics";
import { humanize } from "../src/engine/humanize";
import { labelFromPct, readLedger, sealApi, countChars } from "./zhuque-evidence.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "zhuque-v4-out"); // gitignore：临时产物，sealApi 会复制进 evidence/
const CALIB_JSON = path.join(__dirname, "calibration-data.json");
const V2_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, "calibration-data-v2-genres.json"), "utf8"));
const SEED = 20260826;
const MIN_CHARS = 350;

/* ---------- 重建文本（与 calib-sanity.ts 的 rebuild 同一套，保证 x 轴同一把尺） ---------- */
const EXPO = fs.readFileSync(path.join(__dirname, "archive", "EXPO_O1_RAW.txt"), "utf8");
function v2Text(genre: string, level: string): string {
  const row = V2_JSON.find((r: any) => r.genre === genre && r.level === level);
  if (!row) throw new Error(`v2 找不到 ${genre}/${level}`);
  return row.text;
}
const SRC: Record<string, string> = {
  EXPO,
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

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const DO_V4 = argv.includes("--v4");

interface Job {
  id: string;
  genre: string;
  text: string;
  /** --v4 模式下：把新点追加进 calibration-data.json 需要的重建参数 */
  rebuildSpec?: { src: string; intensity: number; zhuqueMode: boolean };
  note: string;
}

/** 18 个已登记标定点 → 重建送检文本 */
function recheckJobs(): Job[] {
  const data = JSON.parse(fs.readFileSync(CALIB_JSON, "utf8"));
  return (data.points as any[]).map((p) => {
    const text = rebuild(SRC[p.rebuild.src], p.rebuild.intensity, p.rebuild.zhuqueMode, SEED);
    return { id: p.id, genre: p.genre, text, note: `recheck（重测历史点，y=${p.y}）` };
  });
}

/** v4 中段点：优先用已备好的 scripts/zhuque-v4-out/<id>-*.txt，否则按 SAMPLES 重建 */
function v4Jobs(): Job[] {
  // 与 zhuque-v4-pipeline.ts 的 SAMPLES 对齐（id → 体裁/档位/重建参数）
  const spec: Array<Pick<Job, "id" | "genre"> & { intensity: number; zhuqueMode: boolean; seed?: number; src: string; level: string; note: string }> = [
    { id: "O4", genre: "expository", level: "中段0.3档", intensity: 0.3, zhuqueMode: true, src: "EXPO", note: "v4·论说中段" },
    { id: "O5", genre: "expository", level: "原文", intensity: 0, zhuqueMode: false, src: "EXPO", note: "v4·论说原文" },
    { id: "N4", genre: "narrative", level: "中段0.1档", intensity: 0.1, zhuqueMode: true, src: "V2_NAR", note: "v4·叙事中段" },
    { id: "D4", genre: "dialogue", level: "中段0.3档", intensity: 0.3, zhuqueMode: true, seed: SEED + 7, src: "V2_DIA", note: "v4·对话中段低" },
    { id: "D5", genre: "dialogue", level: "中段0.1档", intensity: 0.1, zhuqueMode: true, seed: SEED + 14, src: "V2_DIA", note: "v4·对话中段高" },
    // 人写 4 篇直接用已备好文本（语料在 scripts/calibrate/human/，重建参数=无处理）
    { id: "H-NEW1", genre: "humanHand", level: "无处理", intensity: 0, zhuqueMode: false, src: "__FILE__", note: "v4·人写·夜宵碎念" },
    { id: "H-NEW2", genre: "humanHand", level: "无处理", intensity: 0, zhuqueMode: false, src: "__FILE__", note: "v4·人写·宜家半日游" },
    { id: "H-NEW3", genre: "humanHand", level: "无处理", intensity: 0, zhuqueMode: false, src: "__FILE__", note: "v4·人写·楼下早餐摊" },
    { id: "H-NEW4", genre: "humanHand", level: "无处理", intensity: 0, zhuqueMode: false, src: "__FILE__", note: "v4·人写·搬家记" },
  ];
  return spec.map((s) => {
    let text: string;
    if (s.src === "__FILE__") {
      // 人写语料：找 scripts/zhuque-v4-out/<id>-*.txt（prepare 已生成，≥350 字已保证）
      const f = fs.readdirSync(OUT_DIR).find((n) => n.startsWith(s.id + "-"));
      if (!f) throw new Error(`找不到 ${s.id} 的备好文本，请先跑 npx tsx scripts/zhuque-v4-pipeline.ts prepare`);
      text = fs.readFileSync(path.join(OUT_DIR, f), "utf8");
    } else {
      text = rebuild(SRC[s.src], s.intensity, s.zhuqueMode, s.seed ?? SEED);
    }
    return {
      id: s.id,
      genre: s.genre,
      text,
      rebuildSpec: s.src === "__FILE__" ? undefined : { src: s.src, intensity: s.intensity, zhuqueMode: s.zhuqueMode },
      note: s.note,
    };
  });
}

/* ---------- 官方 API 响应的三档占比（labels_ratio: 0=人工 1=AI 2=疑似） ---------- */
function labelsRatio(raw: Record<string, unknown>): string {
  const lr = raw.labels_ratio;
  if (lr === null || typeof lr !== "object") return "-";
  const g = (k: string) => {
    const v = (lr as Record<string, unknown>)[k];
    return typeof v === "number" && isFinite(v) ? `${Math.round(v * 100)}%` : "-";
  };
  return `人工 ${g("0")} / AI ${g("1")} / 疑似 ${g("2")}`;
}
function tokensOf(raw: Record<string, unknown>): number | null {
  const mk = raw.makers_models_usage;
  if (mk === null || typeof mk !== "object") return null;
  const n = Number((mk as Record<string, unknown>).total_tokens);
  return isFinite(n) ? n : null;
}

/* ---------- 主流程 ---------- */
async function main(): Promise<number> {
  const jobs: Job[] = [...recheckJobs()];
  if (DO_V4) jobs.push(...v4Jobs());

  // 幂等：已有 api-response 凭证的 id 跳过
  const already = new Set(readLedger().filter((e) => e.proof === "api-response").map((e) => e.id));
  const todo = jobs.filter((j) => !already.has(j.id));

  console.log(`═══════════ 官方 API 一键送检（${DO_V4 ? "recheck + v4" : "recheck"}）═══════════`);
  console.log(`待送检 ${todo.length} 篇（跳过已认证 ${jobs.length - todo.length} 篇）\n`);
  for (const j of todo) {
    const chars = countChars(j.text);
    const x = aiScore(j.text).score;
    console.log(`  ${j.id.padEnd(8)} ${j.genre.padEnd(11)} ${String(chars).padStart(4)} 字  aiScore=${String(x).padStart(3)}  ${j.note}${chars < MIN_CHARS ? "  ⚠️<350" : ""}`);
  }
  if (DRY) {
    console.log(`\n[dry-run] 不送检、不入账。去掉 --dry-run 实跑。`);
    return 0;
  }
  if (!todo.length) {
    console.log(`\n全部已认证，无需送检。`);
    return 0;
  }

  const key = process.env.ZHUQUE_API_KEY ?? "";
  if (!key) {
    console.error(
      "缺少 ZHUQUE_API_KEY。\n" +
        "  去腾讯云 EdgeOne 控制台 → Makers → Models → API Key 建一个（不需要自建网关），然后：\n" +
        "  ZHUQUE_API_KEY=xxx npx tsx scripts/zhuque-official-run.ts\n" +
        "  别把 Key 粘进对话，也别写进仓库里的任何文件——聊天记录和 git 历史都是明文。",
    );
    return 2;
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const cfg = { ...ZHUQUE_OFFICIAL_DETECTOR, apiKey: key, enabled: true };
  let ok = 0;
  let fail = 0;
  let spent = 0;
  const sealed: Job[] = [];

  for (const j of todo) {
    const tag = `${j.id}`;
    try {
      const t0 = Date.now();
      const { score, raw } = await classifyViaDetector(j.text, cfg);
      const tk = tokensOf(raw);
      if (tk !== null) spent += tk;
      const label = labelFromPct(score);
      console.log(`✓ ${tag.padEnd(8)} 官方 AI 概率 ${score}% (${label})  ${labelsRatio(raw)}  扣 ${tk ?? "?"} token  ${(Date.now() - t0) / 1000}s`);

      // 落盘临时产物（gitignore），sealApi 会复制进 evidence/ 归档
      const txtPath = path.join(OUT_DIR, `official-${j.id}.txt`);
      const apiPath = path.join(OUT_DIR, `official-${j.id}.api.json`);
      fs.writeFileSync(txtPath, j.text, "utf8");
      fs.writeFileSync(apiPath, JSON.stringify({ file: j.id, chars: countChars(j.text), score, raw }, null, 2), "utf8");

      // --v4 的新点：先注册进 calibration-data.json，再入账（否则 audit 报孤儿凭证）
      if (DO_V4 && j.rebuildSpec) {
        const data = JSON.parse(fs.readFileSync(CALIB_JSON, "utf8"));
        if (!(data.points as any[]).some((p) => p.id === j.id)) {
          data.points.push({
            id: j.id, genre: j.genre, level: j.note, x: aiScore(j.text).score, y: score,
            source: "v4-api", rebuild: j.rebuildSpec, note: `${j.note}（API 送检）`,
          });
          fs.writeFileSync(CALIB_JSON, JSON.stringify(data, null, 2), "utf8");
          console.log(`  → 已把 ${j.id} 追加进 calibration-data.json（x=${aiScore(j.text).score} y=${score}）`);
        }
      }

      // 入账。v4 新点此刻已被追加进 calibration-data.json，但本进程内 sealApi 读的
      // 标定数据源是模块加载时的快照 → 会警告"孤儿凭证"。这是无害的瞬时状态：
      // 本脚本结束后，audit/CI 用新进程重读 calibration-data.json，id 已注册，不再有孤儿凭证。
      const { rec, warnings } = sealApi({
        id: j.id,
        submitFile: path.relative(path.join(__dirname, ".."), txtPath).replace(/\\/g, "/"),
        pct: score,
        label,
        apiResponse: path.relative(path.join(__dirname, ".."), apiPath).replace(/\\/g, "/"),
        by: "zhuque-official-run",
      });
      console.log(`  → 已入账 [api-response] ${rec.submitFile} + ${rec.apiResponse}`);
      for (const w of warnings) console.log(`  ⚠️  ${w}`);
      ok++;
      sealed.push(j);
    } catch (e) {
      console.error(`✗ ${tag} 送检/入账失败：${(e as Error).message}`);
      fail++;
    }
  }

  console.log(`\n共 ${todo.length} 篇：成功 ${ok}，失败 ${fail}，本次累计扣减 ${spent} token（免费额度 50 万/月）。`);
  if (DO_V4 && sealed.length) {
    console.log(`\n下一步：v4 新点已入账。跑 npx tsx scripts/zhuque-v4-fit.ts 看重拟合报告，`);
    console.log(`确认新线拟合误差可接受后，再人工同步 src/engine/zhuque-calib.ts 与 calibration-data.json 的 tracks。`);
    console.log(`（calib-sanity 若因新点转红，是"旧线拟合不了新数据"的诚实信号，不是脚本出错。）`);
  }
  console.log(`\n凭证与账本都要入库，否则克隆后无法复算：git add evidence/ scripts/calibration-data.json`);
  return fail ? 1 : 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  const done = (code: number) => { process.exitCode = code; };
  main().then(done).catch((e) => { console.error(`脚本自身出错：${(e as Error).stack ?? e}`); done(1); });
}
