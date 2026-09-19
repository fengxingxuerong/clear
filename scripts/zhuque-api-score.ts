/**
 * scripts/zhuque-api-score.ts —— 用朱雀官方 API 拿真实 AI 概率（零手点、可批量）
 *
 * 为什么需要它：网页版每次都要人工过滑块、还有当日次数上限，所以「送检一批样本拿真值」
 * 一直是手工活，标定数据（四体裁线重拟合）也因此迟迟补不齐。
 * 2026-09 朱雀在腾讯云 EdgeOne Makers 开了内置模型 @makers/zhuque-text，
 * 每月 50 万 token 免费，脚本可以直接跑通闭环。口径与 UI 里的「外部检测器」完全同源
 * （都走 src/api/detector.ts 的 classifyViaDetector + ZHUQUE_OFFICIAL_DETECTOR）——
 * 请求逻辑分两处写，守卫就只在一处生效。
 *
 * 用法：
 *   ZHUQUE_API_KEY=xxx npx tsx scripts/zhuque-api-score.ts <file.txt> [file2 ...] [--out <dir>]
 *
 * Key 只从环境变量读：写进命令行会留在 shell 历史和进程列表里，写进文件会被 git 看见。
 * 逐篇串行送检（并发打同一个账号只会更快地烧额度）。
 */
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { ZHUQUE_OFFICIAL_DETECTOR, classifyViaDetector } from "../src/api/detector";
import { countChars } from "./zhuque-evidence.ts";

function parseArgs(argv: string[]): { files: string[]; out: string } {
  const files: string[] = [];
  let out = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i] ?? "";
    else if (a.startsWith("--")) console.error(`忽略未知参数 ${a}`);
    else files.push(a);
  }
  return { files, out };
}

interface Ratios {
  human: number | null;
  ai: number | null;
  suspected: number | null;
}

/** labels_ratio 的三档占比转百分数；缺字段一律 null，不拿 0 冒充「0% 是 AI」 */
function ratioOf(raw: Record<string, unknown>): Ratios {
  const lr = raw.labels_ratio;
  const get = (k: string): number | null => {
    if (lr === null || typeof lr !== "object") return null;
    const v = (lr as Record<string, unknown>)[k];
    return typeof v === "number" && isFinite(v) ? v : null;
  };
  const pct = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 100);
  return { human: pct(get("0")), ai: pct(get("1")), suspected: pct(get("2")) };
}

/** 本次扣减的免费额度 token 数：文档明确要求按 makers_models_usage 核算，不是 usage */
function tokensOf(raw: Record<string, unknown>): number | null {
  const mk = raw.makers_models_usage;
  if (mk === null || typeof mk !== "object") return null;
  const n = Number((mk as Record<string, unknown>).total_tokens);
  return isFinite(n) ? n : null;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const key = process.env.ZHUQUE_API_KEY ?? "";
  if (!key) {
    console.error(
      "缺少 ZHUQUE_API_KEY。\n" +
        "  去腾讯云 EdgeOne 控制台 → Makers → Models → API Key 建一个（不需要自建网关），然后：\n" +
        "  ZHUQUE_API_KEY=xxx npx tsx scripts/zhuque-api-score.ts <file.txt>\n" +
        "  别把 Key 粘进对话，也别写进仓库里的任何文件——聊天记录和 git 历史都是明文。",
    );
    return 2;
  }
  const { files, out } = parseArgs(argv);
  if (!files.length) {
    console.error("用法: npx tsx scripts/zhuque-api-score.ts <file.txt> [file2 ...] [--out <dir>]");
    return 2;
  }
  if (out && !fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });

  const cfg = { ...ZHUQUE_OFFICIAL_DETECTOR, apiKey: key, enabled: true };
  let failed = 0;
  let spent = 0;

  for (const f of files) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) {
      console.error(`✗ ${f} 不存在`);
      failed++;
      continue;
    }
    const text = fs.readFileSync(abs, "utf8");
    const chars = countChars(text);
    try {
      const t0 = Date.now();
      const { score, raw } = await classifyViaDetector(text, cfg);
      const r = ratioOf(raw);
      const tk = tokensOf(raw);
      if (tk !== null) spent += tk;
      console.log(
        `✓ ${path.basename(f)}  ${chars} 字  官方 AI 概率 ${score}%` +
          `（人工 ${r.human ?? "-"}% / AI ${r.ai ?? "-"}% / 疑似 ${r.suspected ?? "-"}%）` +
          `  扣 ${tk ?? "?"} token  ${(Date.now() - t0) / 1000}s`,
      );
      if (chars < 350) console.log(`  ⚠️ 低于网页版 350 字门槛；API 是否同口径未实测，比对时留意`);
      if (out) {
        const dest = path.join(out, path.basename(f).replace(/\.[^.]+$/, "") + ".zhuque-api.json");
        fs.writeFileSync(dest, JSON.stringify({ file: f, chars, score, raw }, null, 2), "utf8");
        console.log(`  → 原始响应已存 ${dest}`);
      }
    } catch (e) {
      console.error(`✗ ${path.basename(f)} 送检失败：${(e as Error).message}`);
      failed++;
    }
  }

  console.log(
    `\n共 ${files.length} 篇，失败 ${failed} 篇，本次累计扣减 ${spent} token` +
      `（免费额度 50 万 token/月）。`,
  );
  return failed ? 1 : 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  // 只用 process.exitCode，不调 process.exit()：本机实测过，fetch 的 socket 句柄还没关完
  // 就硬退会在 Windows 上炸 libuv 断言（Assertion failed: UV_HANDLE_CLOSING），
  // 退出码被崩掉的过程盖住——门禁只认退出码，码必须是真的。
  const done = (code: number) => {
    process.exitCode = code;
  };
  run()
    .then(done)
    .catch((e) => {
      console.error(`脚本自身出错：${(e as Error).stack ?? e}`);
      done(1);
    });
}
