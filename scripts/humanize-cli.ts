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
 *       [--out-format follow|txt|docx] [--explain]
 *       [--recursive] [--jobs <n>] [--dry-run]
 *
 * 示例：
 *   npx tsx scripts/humanize-cli.ts ./docs-txt --out ./out --intensity 0.9 --zhuque
 *   npx tsx scripts/humanize-cli.ts ./docs-txt --explain   # 每篇改完附「为什么这么改」清单
 *   npx tsx scripts/humanize-cli.ts ./word-docs --out ./out          # .docx 进 .docx 出
 *   npx tsx scripts/humanize-cli.ts ./word-docs --out-format txt     # 强制落成 .txt
 *   npx tsx scripts/humanize-cli.ts ./稿箱 --recursive --dry-run      # 递归预览，不落盘
 *   # LLM 深度模式（Key 走环境变量，别写进命令行历史）：
 *   QUAIWEI_API_KEY=sk-xxx npx tsx scripts/humanize-cli.ts ./in --api --model deepseek-v4-flash
 *
 * 支持输入：.txt / .md（按 UTF-8 文本读；v0.9.32 起自动识别 UTF-8 BOM / UTF-16 / GBK 并转码）
 * 与 .docx（零依赖 OOXML 解析，只取段落纯文本）。
 *
 * v0.9.32（全方位优化轮，依据 cli-fulltest 26+11 场景实战测试的发现）：
 *   1) 编码检测：Windows 记事本老文件常见 GBK/UTF-16，此前按 UTF-8 硬读直接变乱码稿
 *      （去味引擎再怎么改也是乱码——最坏的是用户看不出来）。现在 BOM 优先，
 *      无 BOM 先严格 UTF-8、失败落 GBK，并在控制台明说转码了哪个文件；产物一律 UTF-8。
 *   2) 回环防护：out=输入目录时，二轮会把上一轮产物 *.humanized.txt 再吃一遍，
 *      产出 *.humanized.humanized.txt 且层层叠加。现在目录批量默认跳过带输出后缀的文件
 *      （单文件显式指名不受限），重跑幂等。
 *   3) --recursive：目录默认仍不递归（旧行为），给了开关才走进子目录（隐藏目录一律跳过）。
 *   4) --jobs：--api 模式按 N 路并发处理文件（网络等待型，加速明显）；本地引擎单线程，
 *      给了也只提示不生效。
 *   5) --dry-run：只列出将处理哪些文件（含跳过原因），不建目录不落盘，随时可跑。
 *   6) 输出增强：批量行加 [k/n] 进度前缀；收尾加耗时/字数/AI 味代理分均值汇总；
 *      report 增加 outPath 与 totals 段。输入路径不存在时给一句话错误而非 ENOENT 堆栈。
 *
 * Key 来源优先级（CLI 专用，与 UI 设置面板无关）：
 *   1) --api-key
 *   2) 环境变量 QUAIWEI_API_KEY
 *   3) 环境变量 OPENAI_API_KEY
 *   4) loadPresetKeys()：SENSENOVA_KEYS 环境变量 / scripts/.sensenova-keys（gitignore）
 */
import fs from "fs";
import path from "path";
import { humanize, adviceFor } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics.ts";
import { detectAI } from "../src/engine/detector";
import { explainChanges, formatExplain, type ExplainItem } from "../src/engine/explain";
import { runHumanize } from "../src/api/llm";
import { DEFAULT_API, loadPresetKeys, type ApiConfig } from "../src/api/llm-config";
import { readDocxText, writeDocxText } from "../src/docx-io";

/** Buffer → 独立 ArrayBuffer（Buffer 可能是共享内存池上的视图，直接给 .buffer 会串） */
function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/**
 * 输入文件 → 纯文本。.docx 解析失败时把真实部件名抛给上层（与 UI 一致，不吞根因）。
 *
 * v0.9.32：txt/md 的编码检测。此前一律按 UTF-8 硬读，GBK 老文件会变成整篇乱码
 * 且**看不出来**（乱码照样能"去味"，产出一份谁也用不了的稿子）。
 * 顺序：BOM（UTF-8/UTF-16LE/UTF-16BE）→ 严格 UTF-8 → GBK → lenient UTF-8 兜底。
 * 产物侧无条件落 UTF-8（writeOutput 的 encoding 参数固定 "utf-8"）。
 */
async function readInputText(f: string): Promise<string> {
  if (!f.toLowerCase().endsWith(".docx")) return decodeTextBuffer(fs.readFileSync(f), f);
  return readDocxText(toArrayBuffer(fs.readFileSync(f)));
}

/** BOM / GBK 检测 + 转码（纯函数语义，便于单独推理；console.warn 说明转码了谁） */
function decodeTextBuffer(buf: Buffer, f: string): string {
  const name = path.basename(f);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf.subarray(3)); // UTF-8 BOM：剥掉再读
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    console.warn(`⚠ ${name}：UTF-16LE 编码，已转码为 UTF-8 读取`);
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    console.warn(`⚠ ${name}：UTF-16BE 编码，已转码为 UTF-8 读取`);
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* 非法 UTF-8 字节序列 → 落 GBK 试一次 */
  }
  try {
    const gbk = new TextDecoder("gbk").decode(buf);
    console.warn(`⚠ ${name}：不是合法 UTF-8，已按 GBK 转码读取（产物统一落 UTF-8）`);
    return gbk;
  } catch {
    return new TextDecoder("utf-8").decode(buf); // lenient 兜底：宁可有稿也不吞文件
  }
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
  /** v0.9.30：改完附「为什么这么改」清单（句级 diff 反查规则表，事后归因） */
  explain: boolean;
  /** v0.9.32：目录扫描递归子目录（默认关，与旧行为一致；隐藏目录一律跳过） */
  recursive: boolean;
  /** v0.9.32：--api 模式并发路数（本地引擎单线程，>1 只提示不生效） */
  jobs: number;
  /** v0.9.32：只列出将处理的文件，不建目录不落盘 */
  dryRun: boolean;
  /** v0.9.38：stdin 管道模式。输入参数给 `-` 或整个省略时置位；正文走 stdout、诊断走 stderr */
  stdin: boolean;
}

const USAGE =
  "用法: npx tsx scripts/humanize-cli.ts <input-dir-or-file> [--out <dir>] [--intensity 0.9]" +
  " [--zhuque] [--style casual|plain|academic] [--suffix .humanized] [--seed 20260905]" +
  " [--api [--base-url <url>] [--model <name>] [--api-key <key>] [--judge-model <name>]]" +
  " [--alt-model <name>] [--no-deep] [--contest <n>] [--max-calls <n>] [--max-wait <sec>]" +
  " [--strict] [--persona default|netgen|classic] [--report <file.json>]" +
  " [--out-format follow|txt|docx] [--explain]" +
  " [--recursive] [--jobs <n>] [--dry-run]\n" +
  "  输入参数给 - 或整个省略时走标准输入：cat 稿.txt | ai-humanizer -s 0.8（正文 stdout，诊断 stderr）\n" +
  "  --base-url 填网关绝对地址（如 https://token.sensenova.cn/v1）。UI 设置里的 /sensenova/v1" +
  " 是同源代理专用写法（代理会剥掉 /sensenova 前缀再转发），CLI 直连勿带这段前缀。\n" +
  "  --recursive 目录扫描进子目录（默认不进）；--jobs 仅 --api 模式生效（并发路数）；" +
  "  --dry-run 只列出将处理的文件不落盘。目录批量默认跳过已带输出后缀的产物（重跑幂等）。";

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
    explain: false,
    recursive: false,
    jobs: 1,
    dryRun: false,
    stdin: false,
  };
  const a = argv.slice(2);
  // v0.9.38：stdin 管道模式。输入参数给 `-`（Unix 惯例）或**没有任何位置参数**时置位
  // stdin，正文从 fd 0 读、结果写 stdout、诊断走 stderr（`ai-humanizer - < 稿.txt > 去味.txt`）。
  // 位置参数要「剥掉选项」才能定位：选项可以占首位（`--seed 42` 无路径也是合法管道用法），
  // 所以第一遍扫出输入 token 的下标，第二遍再解析选项（跳过该下标）。
  // 省略参数时**不能在这里判 TTY**——parseArgs 是纯函数（scripts-logic.test.ts 的 vm 沙箱里
  // 没有 process.stdin），交互终端下的「用法+退出」交给 main 补判。
  const VALUED_OPTS = new Set([
    "--out",
    "--intensity",
    "--style",
    "--suffix",
    "--seed",
    "--base-url",
    "--model",
    "--api-key",
    "--judge-model",
    "--alt-model",
    "--contest",
    "--max-calls",
    "--max-wait",
    "--persona",
    "--report",
    "--out-format",
    "--jobs",
  ]);
  let inputIdx = -1;
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === "-") {
      inputIdx = i; // 显式 stdin
      break;
    }
    if (t.startsWith("-") && t !== "") {
      if (t.startsWith("--") && VALUED_OPTS.has(t)) i++; // 带值选项：连它的值一起跳过
      continue;
    }
    inputIdx = i; // 第一个位置参数（空串也落这里，下面按原行为打法）
    break;
  }
  if (inputIdx === -1 || a[inputIdx] === "-") {
    args.input = "-";
    args.stdin = true;
  } else if (a[inputIdx] === "") {
    console.error(USAGE);
    process.exit(1);
  } else {
    args.input = a[inputIdx];
  }
  const num = (v: string | undefined, d: number) => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : d;
  };
  for (let i = 0; i < a.length; i++) {
    if (i === inputIdx) continue; // 输入路径已在上面定走，不当选项解析
    switch (a[i]) {
      case "--out":
        args.out = a[++i] ?? "";
        break;
      case "--intensity":
        args.intensity = Math.max(0, Math.min(1, num(a[++i], 0.9)));
        break;
      case "--zhuque":
        args.zhuque = true;
        break;
      case "--style":
        args.style = (a[++i] as Args["style"]) || "casual";
        break;
      case "--suffix":
        args.suffix = a[++i] ?? ".humanized";
        break;
      case "--seed":
        args.seed = Math.floor(num(a[++i], 20260905));
        break;
      case "--api":
        args.api = true;
        break;
      case "--base-url":
        args.baseUrl = a[++i] ?? "";
        break;
      case "--model":
        args.model = a[++i] ?? "";
        break;
      case "--api-key":
        args.apiKey = a[++i] ?? "";
        break;
      case "--judge-model":
        args.judgeModel = a[++i] ?? "";
        break;
      case "--alt-model":
        args.altModel = a[++i] ?? "";
        break;
      case "--no-deep":
        args.deep = false;
        break;
      case "--contest":
        args.contest = Math.max(1, Math.floor(num(a[++i], 1)));
        break;
      case "--max-calls":
        args.maxCalls = Math.max(0, Math.floor(num(a[++i], 0)));
        break;
      case "--max-wait":
        args.maxWait = Math.max(0, Math.floor(num(a[++i], 0)));
        break;
      case "--strict":
        args.strict = true;
        break;
      case "--persona":
        args.persona = a[++i] || "default";
        break;
      case "--report":
        args.report = a[++i] ?? "";
        break;
      case "--out-format": {
        const v = (a[++i] ?? "").toLowerCase();
        if (v === "follow" || v === "txt" || v === "docx") args.outFormat = v;
        else {
          console.error(`--out-format 只接受 follow | txt | docx，收到 "${v}"\n${USAGE}`);
          process.exit(1);
        }
        break;
      }
      case "--explain":
        args.explain = true;
        break;
      case "--recursive":
        args.recursive = true;
        break;
      case "--jobs":
        args.jobs = Math.max(1, Math.floor(num(a[++i], 1)));
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        console.error(`未知参数: ${a[i]}\n${USAGE}`);
        process.exit(1);
    }
  }
  if (!args.out) {
    // 单文件时默认输出到它所在目录；目录时输出到它自身（沿用既有行为，只把判定从 .txt 放宽）。
    // stdin 模式的 out 无意义（单篇不落盘），main 会提前返回，这里给个占位即可。
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
 *
 * v0.9.32 返回 { files, skipped }：skipped 统计「已带输出后缀、按回环防护规则跳过」的个数，
 * 供 main 打印。回环防护只作用于**目录扫描**——单文件是用户显式指名的，照单全收。
 */
function collectInputFiles(
  input: string,
  opts: { recursive?: boolean; skipSuffix?: string } = {},
): { files: string[]; skipped: number } {
  const st = fs.statSync(input);
  if (st.isFile()) return { files: isSupportedInput(input) ? [input] : [], skipped: 0 };
  const files: string[] = [];
  let skipped = 0;
  const skip = (opts.skipSuffix ?? "").trim().toLowerCase();
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(".")) continue; // 隐藏项一律不进批量（.git/.covtmp 这类）
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) {
        if (opts.recursive) walk(p);
        continue;
      }
      if (!isSupportedInput(f)) continue;
      // 回环防护：*.humanized.txt 这类上一轮产物不再吃回去（--suffix 可自定义判定词）
      if (skip && INPUT_EXTS.some((e) => f.toLowerCase().endsWith(skip + e))) {
        skipped++;
        continue;
      }
      files.push(p);
    }
  };
  walk(input);
  return { files: files.sort(), skipped };
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
  /** v0.9.32：产物落盘路径（并发/嵌套目录场景里 basename 不足以定位） */
  outPath?: string;
  /* 以下仅 --api 模式有 */
  engine?: string;
  usedApi?: boolean;
  roundScores?: number[];
  note?: string;
  degrade?: string[];
  /* 仅 --explain 模式有 */
  explain?: ExplainItem[];
}

/** v0.9.32：report totals 的求和（对全部条目求和，含失败篇目——失败也是花了时间的） */
function sum0(reps: FileReport[], g: (r: FileReport) => number): number {
  return reps.reduce((s, r) => s + g(r), 0);
}

/** v0.9.32：简单 worker 池（--api 并发；本地引擎单线程不走这里） */
async function runPool<T>(
  items: T[],
  jobs: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * v0.9.38：stdin 管道模式主流程。
 *
 * 边界（诚实声明）：
 *  · **只走本地引擎**。LLM 通道（--api）的 cfg 构建与校验在 main 的批量路径里，
 *    不为一把管道把那段重构进这里——要深度模式请把内容落成文件。
 *  · 编码：stdin 是 Node 已解码的 UTF-8 流，不走 readInputText 的
 *    BOM/UTF-16/GBK 探测（那是文件路径场景的能力）。
 *  · 输出分工：**正文一律 stdout、诊断一律 stderr**，`> 重定向` 不会把进度行混进产物。
 *  · --report/--suffix/--out-format 在 stdin 模式无意义（单篇不落盘），忽略。
 */
async function runStdinMode(args: Args): Promise<void> {
  if (args.api) {
    console.error("✗ stdin 模式暂不支持 LLM 通道（--api）：请把内容落成文件再走文件输入");
    process.exit(1);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (e) {
    console.error(
      `✗ 读标准输入失败：${(e as Error).message}\n  用法示例：cat 稿.txt | ai-humanizer -`,
    );
    process.exit(1);
  }
  if (!raw.trim()) {
    console.error("✗ 标准输入为空（用法示例：cat 稿.txt | ai-humanizer -）");
    process.exit(1);
  }
  const t0 = Date.now();
  const before = detectAI(raw).probability;
  const out = humanize(raw, {
    intensity: args.intensity,
    seed: args.seed,
    zhuqueMode: args.zhuque,
    style: args.style,
  });
  // 正文：stdout（保留引擎产出的换行结构，末尾补一个换方便终端查看）
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  // 诊断：stderr
  const after = detectAI(out).probability;
  console.error(
    `✅ stdin：${before}→${after}（${Date.now() - t0}ms，${raw.length}→${out.length} 字）`,
  );
  const advice = adviceFor(raw, aiScore(raw).score);
  if (advice.code !== "ok") console.error(`ⓘ ${advice.message}`);
  if (args.explain) {
    const items = explainChanges(raw, out);
    console.error(
      formatExplain(items)
        .split("\n")
        .map((l) => `   ${l}`)
        .join("\n"),
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);

  // v0.9.38：stdin 管道模式（输入参数 - 或省略）。省略参数时在这里补判 TTY：
  // 交互终端下不给管道，维持原行为（用法 + 退出），别把用户晾在读取阻塞里。
  if (args.stdin) {
    if (args.input === "-" || !process.stdin.isTTY) {
      await runStdinMode(args);
      return;
    }
    console.error(USAGE);
    process.exit(1);
  }

  // v0.9.32：读不到输入路径时给一句话错误，而不是甩 ENOENT 堆栈
  let collected: { files: string[]; skipped: number };
  try {
    collected = collectInputFiles(args.input, {
      recursive: args.recursive,
      skipSuffix: args.suffix,
    });
  } catch (e) {
    console.error(`✗ 读不到输入路径：${args.input}\n  ${(e as Error).message}`);
    process.exit(1);
  }
  const files = collected.files;
  if (!files.length) {
    console.error(`未找到可处理的文件（支持 ${INPUT_EXTS_LABEL}）:`, args.input);
    process.exit(1);
  }

  // v0.9.32：--dry-run 在 Key 校验/建目录之前返回——预览不该被网关配置挡住，也不该留下空目录
  if (args.dryRun) {
    console.log(
      `试运行（--dry-run）：将处理 ${files.length} 个文件 | 强度 ${args.intensity} | ` +
        `${args.api ? "LLM 通道" : "本地引擎"}${args.recursive ? " | 递归" : ""}（不落盘）`,
    );
    for (const f of files) console.log(`  · ${f}`);
    if (collected.skipped)
      console.log(`（另跳过 ${collected.skipped} 个已带输出后缀「${args.suffix}」的既有产物）`);
    return;
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
        `${cfg.judgeModel ? ` + 评判 ${cfg.judgeModel}` : ""} | 文风 ${args.style}` +
        `${args.jobs > 1 ? ` | 并发 ${args.jobs}` : ""}`,
    );
  } else {
    console.log(
      `批量去味：${files.length} 个文件 | 强度 ${args.intensity} | 朱雀增强 ${args.zhuque ? "开" : "关"} | 文风 ${args.style}`,
    );
    if (args.jobs > 1)
      console.log("   ⓘ 本地引擎是单线程 CPU 模式，--jobs 仅对 --api 生效，已忽略");
  }
  if (collected.skipped)
    console.log(
      `   ⓘ 已跳过 ${collected.skipped} 个带输出后缀「${args.suffix}」的既有产物（重跑幂等；单文件指名输入不受限）`,
    );
  console.log("─".repeat(64));

  const multi = files.length > 1;
  const reports: FileReport[] = new Array(files.length);
  let ok = 0,
    fail = 0;
  const processOne = async (f: string, idx: number) => {
    const name = path.basename(f);
    const step = multi ? `[${idx + 1}/${files.length}] ` : "";
    try {
      const raw = await readInputText(f);
      if (!raw.trim()) {
        console.log(`${step}⏭  ${name}：空文件，跳过`);
        return;
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
            console.log(
              `   ${step}${name} ${stage ?? ""}第 ${round} 轮${score === null ? "" : ` 评分 ${score}`}`,
            );
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
      rep.outPath = dest;
      console.log(
        `${step}✅ ${name}：${rep.detectBefore}→${rep.detectAfter}（${rep.ms}ms，${raw.length}→${out.length} 字）→ ${path.basename(dest)}`,
      );
      // v0.9.22：低风险输入照常出稿，但把"其实不用去味"说出来。
      // 不自动跳过——批量场景里静默不产出比多产出一版更难排查。
      const advice = adviceFor(raw, aiScore(raw).score);
      if (advice.code !== "ok") console.log(`   ⓘ ${advice.message}`);
      if (args.explain) {
        const items = explainChanges(raw, out);
        rep.explain = items;
        // 缩进两格对齐本篇其他行首的 `   `
        console.log(
          formatExplain(items)
            .split("\n")
            .map((l) => `   ${l}`)
            .join("\n"),
        );
      }
      if (cfg) {
        const tag = rep.engine === "llm" ? "LLM" : rep.engine === "mixed" ? "混拼" : "本地回退";
        const rounds = rep.roundScores?.length ? ` 轮次分 [${rep.roundScores.join(", ")}]` : "";
        console.log(`   ${tag}${rounds}${rep.note ? ` · ${rep.note}` : ""}`);
        for (const d of rep.degrade ?? []) console.log(`   ⚠ ${d}`);
      }
      reports[idx] = rep;
      ok++;
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`${step}❌ ${name}：${msg}`);
      reports[idx] = {
        file: name,
        ms: 0,
        charsIn: 0,
        charsOut: 0,
        detectBefore: 0,
        detectAfter: 0,
        ok: false,
        error: msg,
      };
      fail++;
    }
  };
  // v0.9.32：--api（网络等待型）可并发提速；本地引擎是同步 CPU 活，串行即可
  if (cfg && args.jobs > 1) await runPool(files, args.jobs, processOne);
  else for (let i = 0; i < files.length; i++) await processOne(files[i], i);
  const reps = reports.filter((r): r is FileReport => !!r);

  console.log("─".repeat(64));
  console.log(`完成：${ok} 成功 / ${fail} 失败 → ${args.out}`);
  // v0.9.32：收尾汇总。detect 是**本地代理分**（与引擎同源词表），只作趋势参考——
  // SKILL.md 里"同源指标非外部真值"的边界同样适用于这行。
  const done = reps.filter((r) => r.ok);
  if (done.length) {
    const sum = (g: (r: FileReport) => number) => done.reduce((s, r) => s + g(r), 0);
    const avg = (g: (r: FileReport) => number) => Math.round(sum(g) / done.length);
    console.log(
      `汇总：${done.length} 篇 | 引擎耗时 ${sum((r) => r.ms)}ms | ` +
        `字数 ${sum((r) => r.charsIn)}→${sum((r) => r.charsOut)} | ` +
        `AI 味代理分（均值）${avg((r) => r.detectBefore)}→${avg((r) => r.detectAfter)}`,
    );
  }

  if (args.report) {
    const rp = path.resolve(args.report);
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    fs.writeFileSync(
      rp,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          args,
          totals: {
            files: reps.length,
            ok,
            fail,
            skippedSuffix: collected.skipped,
            charsIn: sum0(reps, (r) => r.charsIn),
            charsOut: sum0(reps, (r) => r.charsOut),
            msTotal: sum0(reps, (r) => r.ms),
          },
          reports: reps,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`报告：${rp}`);
  }
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
