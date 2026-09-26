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
 * v0.9.17：输入侧接上 .docx（v0.9.16 只做了 UI，CLI 仍是「.txt only」，CHANGELOG 里
 * 明写着「CLI 的 .docx 输入暂未接」）。现在 `.docx` 与 `.txt`/`.md` 一并批量处理，
 * 输出格式默认**跟随输入**（.docx 进 → .docx 出），`--out-format txt|docx` 可强制覆盖。
 *
 * 用法：
 *   npx tsx scripts/humanize-cli.ts <input-dir-or-file> [--out <dir>] [--intensity 0.9]
 *       [--zhuque] [--style casual|plain|academic] [--suffix .humanized] [--seed 20260905]
 *       [--api [--base-url <url>] [--model <name>] [--api-key <key>] [--judge-model <name>]]
 *       [--alt-model <name>] [--no-deep] [--contest <n>] [--max-calls <n>] [--max-wait <sec>]
 *       [--strict] [--persona default|netgen|classic] [--report <file.json>]
 *       [--out-format follow|txt|docx]
 *
 * 示例：
 *   npx tsx scripts/humanize-cli.ts ./docs-txt --out ./out --intensity 0.9 --zhuque
 *   npx tsx scripts/humanize-cli.ts ./word-docs --out ./out          # .docx 进 .docx 出
 *   npx tsx scripts/humanize-cli.ts ./word-docs --out-format txt     # 强制落成 .txt
 *   # LLM 深度模式（Key 走环境变量，别写进命令行历史）：
 *   QUAIWEI_API_KEY=sk-xxx npx tsx scripts/humanize-cli.ts ./in --api --model deepseek-v4-flash
 *
 * 支持输入：.txt / .md（按 UTF-8 文本读）与 .docx（零依赖 OOXML 解析，只取段落纯文本）。
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
import { readDocxText, writeDocxText } from "../src/docx-io";

/** Buffer → 独立 ArrayBuffer（Buffer 可能是共享内存池上的视图，直接给 .buffer 会串） */
function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** 输入文件 → 纯文本。.docx 解析失败时把真实部件名抛给上层（与 UI 一致，不吞根因） */
async function readInputText(f: string): Promise<string> {
  if (!f.toLowerCase().endsWith(".docx")) return fs.readFileSync(f, "utf-8");
  return readDocxText(toArrayBuffer(fs.readFileSync(f)));
}

/**
 * 输出扩展名：`--out-format` 显式给了就听它的，否则跟随输入
 * （.docx 进 → .docx 出；用户拿 Word 稿来批量处理，落回 .txt 反而多一道手）。
 */
function outExtOf(inputFile: string, outFormat: string): string {
  if (outFormat === "docx") return ".docx";
  if (outFormat === "txt") return ".txt";
  return inputFile.toLowerCase().endsWith(".docx") ? ".docx" : ".txt";
}

async function writeOutput(dest: string, text: string, asDocx: boolean): Promise<void> {
  if (!asDocx) {
    fs.writeFileSync(dest, text, "utf-8");
    return;
  }
  const blob = await writeDocxText(text);
  fs.writeFileSync(dest, Buffer.from(await blob.arrayBuffer()));
}

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
  /** v0.9.17：输出格式。follow = 跟随输入扩展名（.docx 进 → .docx 出） */
  outFormat: "follow" | "txt" | "docx";
}

const USAGE =
  "用法: npx tsx scripts/humanize-cli.ts <input-dir-or-file> [--out <dir>] [--intensity 0.9]" +
  " [--zhuque] [--style casual|plain|academic] [--suffix .humanized] [--seed 20260905]" +
  " [--api [--base-url <url>] [--model <name>] [--api-key <key>] [--judge-model <name>]]" +
  " [--alt-model <name>] [--no-deep] [--contest <n>] [--max-calls <n>] [--max-wait <sec>]" +
  " [--strict] [--persona default|netgen|classic] [--report <file.json>]" +
  " [--out-format follow|txt|docx]\n" +
  "  --base-url 填网关绝对地址（如 https://token.sensenova.cn/v1）。UI 设置里的 /sensenova/v1" +
  " 是同源代理专用写法（代理会剥掉 /sensenova 前缀再转发），CLI 直连勿带这段前缀。";

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
    outFormat: "follow",
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
      case "--out-format": {
        const v = (a[++i] ?? "").toLowerCase();
        if (v === "follow" || v === "txt" || v === "docx") args.outFormat = v;
        else {
          console.error(`--out-format 只接受 follow | txt | docx，收到 "${v}"\n${USAGE}`);
          process.exit(1);
        }
        break;
      }
      default:
        console.error(`未知参数: ${a[i]}\n${USAGE}`);
        process.exit(1);
    }
  }
  if (!args.out) {
    // 单文件时默认输出到它所在目录；目录时输出到它自身（沿用既有行为，只把判定从 .txt 放宽）
    args.out = isSupportedInput(args.input) ? path.dirname(args.input) : args.input;
  }
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

/**
 * CLI 认的输入扩展名（.docx 自 v0.9.17；去味引擎只吃纯文本，富文本格式一律不保留）。
 *
 * 定义位置有讲究：`scripts/scripts-logic.test.ts` 会按字面量找起止点，把「USAGE 常量 →
 * 主函数」之间的源码切进 vm 沙箱跑纯函数测试，所以这里要用到的常量不能写在文件顶部
 * 那段（不进切片）。同理，本文件的注释里也别写出那两个定位用的字面量——否则切片
 * 会从注释中间开始或结束，esbuild 转译直接失败（v0.9.17 接线时踩到，现象是
 * `Expected 星斜杠 to terminate multi-line comment`）。
 *
 * 自指陷阱备忘：上一行报错原文里含「星号+斜杠」的块注释终止符，原样写进本注释
 * 会把这段 JSDoc 提前掐断——这正是 v0.9.17 接线卡住的根因（esbuild 报
 * Unterminated string literal），所以只能转述为「星斜杠」，后人别手痒改回原样。
 */
const INPUT_EXTS = [".txt", ".md", ".docx"] as const;
const INPUT_EXTS_LABEL = ".txt / .md / .docx";

function isSupportedInput(f: string): boolean {
  const lower = f.toLowerCase();
  return INPUT_EXTS.some((e) => lower.endsWith(e));
}

/**
 * 收集待处理文件：.txt / .md / .docx。
 * （v0.9.17 前只认 .txt，名字也叫 collectTxtFiles——改名是因为它现在不止收 txt。）
 */
function collectInputFiles(input: string): string[] {
  const st = fs.statSync(input);
  if (st.isFile()) return isSupportedInput(input) ? [input] : [];
  const out: string[] = [];
  for (const f of fs.readdirSync(input)) {
    const p = path.join(input, f);
    if (fs.statSync(p).isFile() && isSupportedInput(f)) out.push(p);
  }
  return out.sort();
}

/**
 * CLI 直连误带同源代理前缀检测：UI/桌面版设置里的「/sensenova/v1」由 vite/Electron 代理
 * 剥掉 /sensenova 前缀后转发（rewrite: ^/sensenova → ""）。CLI 直连没有这层代理，
 * 带前缀的地址原样发出去会撞网关 404（{"code":5,"message":"NOT_FOUND"}，报错完全看不出
 * 是路径多了一段——v0.9.17 功能验收实测踩到）。
 *
 * 只判定绝对地址（http(s):// 开头）；相对路径由 main 里另一条「同源相对路径」拦截负责。
 * host 里的 sensenova 域名不受影响：token.sensenova.cn 中该词的前缀是点不是斜杠。
 * 用正则剥 host 而非 new URL——vm 沙箱（scripts-logic.test.ts 切片）没有注入 URL 全局。
 */
function baseUrlHasProxyPrefix(baseUrl: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(baseUrl.trim());
  if (!m) return false;
  return /^\/sensenova(\/|$)/.test(m[1] ?? "");
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
  const files = collectInputFiles(args.input);
  if (!files.length) {
    console.error(`未找到可处理的文件（支持 ${INPUT_EXTS_LABEL}）:`, args.input);
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
    if (baseUrlHasProxyPrefix(cfg.baseUrl)) {
      console.error(
        `✗ baseUrl "${cfg.baseUrl}" 带着同源代理前缀 /sensenova——那是 UI/桌面版给代理用的写法，` +
          `代理会剥掉这段前缀再转发；CLI 直连没有代理，原样发出去会撞网关 404。\n` +
          `  请去掉前缀，例如 --base-url https://token.sensenova.cn/v1`,
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
      const raw = await readInputText(f);
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
      const ext = outExtOf(f, args.outFormat);
      const dest = path.join(args.out, name.replace(/\.(txt|md|docx)$/i, "") + args.suffix + ext);
      await writeOutput(dest, out, ext === ".docx");
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
