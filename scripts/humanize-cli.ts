/**
 * scripts/humanize-cli.ts —— 批量去味 CLI（v0.8.6 起；v0.9.15 补 LLM 通道）
 *
 * 竞品（嘎嘎降AI/零感AI/千笔AI）标配「批量上传多文件处理」，本项目此前只有 UI 单篇模式。
 * 本 CLI 补齐：批量处理 .txt 文件，输出到指定目录。
 *
 * v0.9.15 之前只接了本地引擎（`src/engine/humanize`），`src/api` 那 28 个模块
 * （深度闭环 / 交叉评判 / 定向修订 / 长文分块）CLI 完全够不到 —— 等于「批量」这个卖点
 * 只兑现了一半。现在 `--api` 走 UI 同款的 `runHumanize`，本地回退逻辑一并继承。
 *
 * 用法：
 *   npx tsx scripts/humanize-cli.ts <input-dir-or-file> [--out <dir>] [--intensity 0.9]
 *       [--zhuque] [--style casual|plain|academic] [--suffix .humanized] [--seed 20260905]
 *       [--api [--base-url <url>] [--model <name>] [--api-key <key>] [--judge-model <name>]]
 *       [--alt-model <name>] [--no-deep] [--contest <n>] [--max-calls <n>] [--max-wait <sec>]
 *       [--strict] [--persona default|netgen|classic] [--report <file.json>]
 *
 * 示例：
 *   npx tsx scripts/humanize-cli.ts ./docs-txt --out ./out --intensity 0.9 --zhuque
 *   # LLM 深度模式（Key 走环境变量，别写进命令行历史）：
 *   QUAIWEI_API_KEY=sk-xxx npx tsx scripts/humanize-cli.ts ./in --api --model deepseek-v4-flash
 *
 * Key 来源优先级（CLI 专用，与 UI 设置面板无关）：
 *   1) --api-key
 *   2) 环境变量 QUAIWEI_API_KEY
 *   3) 环境变量 OPENAI_API_KEY
 *   4) loadPresetKeys()：SENSENOVA_KEYS 环境变量 / scripts/.sensenova-keys（gitignore）
 */
import fs from "fs";
import path from "path";
import { humanize } from "../src/engine/humanize";
import { detectAI } from "../src/engine/detector";
import { runHumanize } from "../src/api/llm";
import { DEFAULT_API, loadPresetKeys, type ApiConfig } from "../src/api/llm-config";

interface Args {
  input: string;
  out: string;
  intensity: number;
  zhuque: boolean;
  style: "casual" | "plain" | "academic";
  suffix: string;
  /** v0.9.15：本地引擎种子。此前硬编码 20260905 且不可改，批量结果无法与 UI 对齐复现。 */
  seed: number;
  /* ---- LLM 通道（--api 生效） ---- */
  api: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  judgeModel: string;
  altModel: string;
  deep: boolean;
  contest: number;
  maxCalls: number;
  maxWait: number;
  strict: boolean;
  persona: string;
  report: string;
}

const USAGE =
  "用法: npx tsx scripts/humanize-cli.ts <input-dir-or-file> [--out <dir>] [--intensity 0.9]" +
  " [--zhuque] [--style casual|plain|academic] [--suffix .humanized] [--seed 20260905]" +
  " [--api [--base-url <url>] [--model <name>] [--api-key <key>] [--judge-model <name>]]" +
  " [--alt-model <name>] [--no-deep] [--contest <n>] [--max-calls <n>] [--max-wait <sec>]" +
  " [--strict] [--persona default|netgen|classic] [--report <file.json>]";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: "",
    out: "",
    intensity: 0.9,
    zhuque: false,
    style: "casual",
    suffix: ".humanized",
    seed: 20260905,
    api: false,
    baseUrl: "",
    model: "",
    apiKey: "",
    judgeModel: "",
    altModel: "",
    deep: true,
    contest: 1,
    maxCalls: 0,
    maxWait: 0,
    strict: false,
    persona: "default",
    report: "",
  };
  const a = argv.slice(2);
  if (!a[0] || a[0].startsWith("--")) {
    console.error(USAGE);
    process.exit(1);
  }
  args.input = a[0];
  const num = (v: string | undefined, d: number) => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : d;
  };
  for (let i = 1; i < a.length; i++) {
    switch (a[i]) {
      case "--out": args.out = a[++i] ?? ""; break;
      case "--intensity": args.intensity = Math.max(0, Math.min(1, num(a[++i], 0.9))); break;
      case "--zhuque": args.zhuque = true; break;
      case "--style": args.style = (a[++i] as Args["style"]) || "casual"; break;
      case "--suffix": args.suffix = a[++i] ?? ".humanized"; break;
      case "--seed": args.seed = Math.floor(num(a[++i], 20260905)); break;
      case "--api": args.api = true; break;
      case "--base-url": args.baseUrl = a[++i] ?? ""; break;
      case "--model": args.model = a[++i] ?? ""; break;
      case "--api-key": args.apiKey = a[++i] ?? ""; break;
      case "--judge-model": args.judgeModel = a[++i] ?? ""; break;
      case "--alt-model": args.altModel = a[++i] ?? ""; break;
      case "--no-deep": args.deep = false; break;
      case "--contest": args.contest = Math.max(1, Math.floor(num(a[++i], 1))); break;
      case "--max-calls": args.maxCalls = Math.max(0, Math.floor(num(a[++i], 0))); break;
      case "--max-wait": args.maxWait = Math.max(0, Math.floor(num(a[++i], 0))); break;
      case "--strict": args.strict = true; break;
      case "--persona": args.persona = a[++i] || "default"; break;
      case "--report": args.report = a[++i] ?? ""; break;
      default:
        console.error(`未知参数: ${a[i]}\n${USAGE}`);
        process.exit(1);
    }
  }
  if (!args.out) args.out = args.input.endsWith(".txt") ? path.dirname(args.input) : args.input;
  return args;
}

/** 组装 ApiConfig：只覆盖用户显式给过的字段，其余沿用 DEFAULT_API */
function buildApiConfig(args: Args): ApiConfig {
  const keys =
    args.apiKey ||
    process.env.QUAIWEI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    loadPresetKeys().join("\n");
  const cfg: ApiConfig = {
    ...DEFAULT_API,
    enabled: true,
    deepMode: args.deep,
    apiKey: keys,
    apiKeys: keys, // Key 池：429/401 自动切下一个（与 apiKey 合并去重）
    strictFidelity: args.strict,
    contestSamples: args.contest,
    maxApiCalls: args.maxCalls,
    maxWaitSeconds: args.maxWait,
    style: args.style,
  };
  if (args.baseUrl) cfg.baseUrl = args.baseUrl;
  if (args.model) cfg.model = args.model;
  if (args.judgeModel) cfg.judgeModel = args.judgeModel;
  if (args.altModel) cfg.altModel = args.altModel;
  if (args.persona === "default" || args.persona === "netgen" || args.persona === "classic") {
    cfg.persona = args.persona;
  }
  return cfg;
}

function collectTxtFiles(input: string): string[] {
  const st = fs.statSync(input);
  if (st.isFile()) return [input];
  const out: string[] = [];
  for (const f of fs.readdirSync(input)) {
    const p = path.join(input, f);
    if (fs.statSync(p).isFile() && f.toLowerCase().endsWith(".txt")) out.push(p);
  }
  return out.sort();
}

interface FileReport {
  file: string;
  ms: number;
  charsIn: number;
  charsOut: number;
  detectBefore: number;
  detectAfter: number;
  ok: boolean;
  error?: string;
  /* 以下仅 --api 模式有 */
  engine?: string;
  usedApi?: boolean;
  roundScores?: number[];
  note?: string;
  degrade?: string[];
}

async function main() {
  const args = parseArgs(process.argv);
  const files = collectTxtFiles(args.input);
  if (!files.length) {
    console.error("未找到 .txt 文件:", args.input);
    process.exit(1);
  }
  fs.mkdirSync(args.out, { recursive: true });

  let cfg: ApiConfig | null = null;
  if (args.api) {
    cfg = buildApiConfig(args);
    // CLI 没有 vite / Electron 的同源代理：形如 "/sensenova/v1" 的相对路径在 Node 里必挂，
    // 与其让它在第一次 fetch 时报个看不懂的错，不如现在说清楚。
    if (/^\//.test(cfg.baseUrl)) {
      console.error(
        `✗ baseUrl "${cfg.baseUrl}" 是同源相对路径，CLI 无代理无法使用。\n` +
          `  请填完整地址，例如 --base-url https://token.sensenova.cn/v1`,
      );
      process.exit(1);
    }
    if (!cfg.apiKey.trim()) {
      console.error(
        "✗ 未拿到 API Key。可用方式：--api-key / 环境变量 QUAIWEI_API_KEY / OPENAI_API_KEY / " +
          "SENSENOVA_KEYS / scripts/.sensenova-keys",
      );
      process.exit(1);
    }
    console.log(
      `批量去味（LLM 通道）：${files.length} 个文件 | 强度 ${args.intensity} | ` +
        `${args.deep ? "深度闭环" : "单轮"} | 模型 ${cfg.model}` +
        `${cfg.judgeModel ? ` + 评判 ${cfg.judgeModel}` : ""} | 文风 ${args.style}`,
    );
  } else {
    console.log(
      `批量去味：${files.length} 个文件 | 强度 ${args.intensity} | 朱雀增强 ${args.zhuque ? "开" : "关"} | 文风 ${args.style}`,
    );
  }
  console.log("─".repeat(64));

  const reports: FileReport[] = [];
  let ok = 0, fail = 0;
  for (const f of files) {
    const name = path.basename(f);
    try {
      const raw = fs.readFileSync(f, "utf-8");
      if (!raw.trim()) {
        console.log(`⏭  ${name}：空文件，跳过`);
        continue;
      }
      const t0 = Date.now();
      const rep: FileReport = {
        file: name,
        ms: 0,
        charsIn: raw.length,
        charsOut: 0,
        detectBefore: detectAI(raw).probability,
        detectAfter: 0,
        ok: true,
      };
      let out: string;
      if (cfg) {
        const r = await runHumanize(
          raw,
          args.intensity,
          cfg,
          (round, score, stage) => {
            console.log(`   ${name} ${stage ?? ""}第 ${round} 轮${score === null ? "" : ` 评分 ${score}`}`);
          },
          args.zhuque,
          undefined, // genre 交给引擎自动判定，与 UI「自动」一致
        );
        out = r.text;
        rep.engine = r.engine;
        rep.usedApi = r.usedApi;
        rep.roundScores = r.roundScores;
        rep.note = r.note;
        rep.degrade = r.degrade;
      } else {
        out = humanize(raw, {
          intensity: args.intensity,
          seed: args.seed,
          zhuqueMode: args.zhuque,
          style: args.style,
        });
      }
      rep.ms = Date.now() - t0;
      rep.charsOut = out.length;
      rep.detectAfter = detectAI(out).probability;
      const dest = path.join(args.out, name.replace(/\.txt$/i, "") + args.suffix + ".txt");
      fs.writeFileSync(dest, out, "utf-8");
      console.log(
        `✅ ${name}：${rep.detectBefore}→${rep.detectAfter}（${rep.ms}ms，${raw.length}→${out.length} 字）→ ${path.basename(dest)}`,
      );
      if (cfg) {
        const tag = rep.engine === "llm" ? "LLM" : rep.engine === "mixed" ? "混拼" : "本地回退";
        const rounds = rep.roundScores?.length ? ` 轮次分 [${rep.roundScores.join(", ")}]` : "";
        console.log(`   ${tag}${rounds}${rep.note ? ` · ${rep.note}` : ""}`);
        for (const d of rep.degrade ?? []) console.log(`   ⚠ ${d}`);
      }
      reports.push(rep);
      ok++;
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`❌ ${name}：${msg}`);
      reports.push({
        file: name, ms: 0, charsIn: 0, charsOut: 0,
        detectBefore: 0, detectAfter: 0, ok: false, error: msg,
      });
      fail++;
    }
  }
  console.log("─".repeat(64));
  console.log(`完成：${ok} 成功 / ${fail} 失败 → ${args.out}`);

  if (args.report) {
    const rp = path.resolve(args.report);
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    fs.writeFileSync(rp, JSON.stringify({ ts: new Date().toISOString(), args, reports }, null, 2), "utf-8");
    console.log(`报告：${rp}`);
  }
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
