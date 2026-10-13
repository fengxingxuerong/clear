/**
 * 趣AI味 · CLI 入口（bin: ai-humanizer）
 *
 * 背景（分发形态缺口）：此前项目只有 Electron 桌面壳 + scripts/ 下的运维脚本，
 * 没有面向用户的命令行入口——「去 AI 味」能力散落在引擎里，命令行一样能用，
 * 但差一个壳。本文件就是那个壳：读文本（文件/stdin/-t）→ 调引擎 → 写结果（stdout/-o）。
 *
 * 设计约束：
 *  · 零运行时依赖：只用 node 内置模块 + 引擎本身，bundle 后单文件可分发
 *  · IO 全部经注入的 CliIo：argv 解析是纯函数，主流程可在测试里用内存 IO 跑，
 *    不起子进程（本环境同步 spawn 一律 EBUSY，e2e  spawn 路线走不通）
 *  · 退出码：0=成功 1=输入/运行错误 2=用法错误（与 check-version-sync.ts 惯例一致）
 *
 * 用法：
 *   ai-humanizer [选项] [文件]
 *   cat 稿子.txt | ai-humanizer -s 0.8 -o 稿子-去味.txt
 *   ai-humanizer -t "本文首先阐述了……" --score
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize, humanizeWithScore } from "../src/engine/humanize.ts";
import { humanizeBestOf } from "../src/engine/humanize-bestof.ts";
import type { HumanizeOptions } from "../src/engine/humanize-primitives.ts";
import pkg from "../package.json";

/** 体裁合法值（引擎侧 genre 字段 + CLI 的 auto 别名） */
const GENRES = ["auto", "main", "narrative", "dialogue", "humanHand"] as const;
type GenreArg = (typeof GENRES)[number];

/** 文风预设合法值（引擎 RewriteStyle） */
const STYLES = ["casual", "plain", "academic"] as const;
type StyleArg = (typeof STYLES)[number];

export interface CliOptions {
  /** -t 直接给的文本；与 file/stdin 互斥（优先级 -t > file > stdin） */
  text?: string;
  /** 位置参数：输入文件路径 */
  file?: string;
  /** -o 输出文件路径；不传则写 stdout */
  out?: string;
  /** -s 去味强度 0~1，默认 0.6 */
  strength: number;
  /** --seed 随机种子；undefined = 引擎自行随机 */
  seed?: number;
  /** -g 体裁；auto → 不传 genre 字段（引擎自动识别） */
  genre: GenreArg;
  /** --style 文风预设，默认 casual */
  style: StyleArg;
  /** --zhuque 朱雀增强（默认不传，引擎按强度自动决定） */
  zhuque: boolean;
  /** --bestof 多样本选优；数字为候选数（不传则按文本长度自动 4~10） */
  bestof?: number;
  /** --score 在 stderr 打印处理前后 aiScore 对比 */
  score: boolean;
}

/** 用法错误：带 usage 文本，由 run() 打到 stderr 并返回退出码 2 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** 注入式 IO：测试用内存实现，真实跑用 node 流/fs */
export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** 读 stdin 全文；非管道环境返回空串 */
  stdin: () => string;
  readFile: (p: string) => string;
  writeFile: (p: string, s: string) => void;
}

const USAGE = `用法：ai-humanizer [选项] [文件]
  -t, --text <文本>      直接处理文本（也可用文件参数或 stdin 管道）
  -s, --strength <0~1>   去味强度（默认 0.6）
  --seed <整数>          随机种子（固定后结果可复现；默认随机）
  -g, --genre <体裁>     auto|main|narrative|dialogue|humanHand（默认 auto 自动识别）
  --style <预设>         casual|plain|academic（默认 casual）
  --zhuque               强制开启朱雀增强（默认交给引擎按强度决定）
  --bestof [n]           多样本选优：n 个候选里挑最不像 AI 的（默认按长度自动 4~10）
  --score                stderr 打印处理前后 aiScore 对比
  -o, --out <文件>       输出到文件（默认 stdout）
  -h, --help
  -v, --version`;

/** 解析 argv（不含 node/脚本路径两节）。纯函数，不碰 IO。 */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    strength: 0.6,
    genre: "auto",
    style: "casual",
    zhuque: false,
    score: false,
  };
  /** 取下一个参数作为值；缺失即用法错误 */
  const takeValue = (i: number, flag: string): [string, number] => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) {
      throw new UsageError(`选项 ${flag} 需要一个值`);
    }
    return [v, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-t":
      case "--text": {
        const [v, ni] = takeValue(i, a);
        opts.text = v;
        i = ni;
        break;
      }
      case "-s":
      case "--strength": {
        const [v, ni] = takeValue(i, a);
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          throw new UsageError(`strength 必须是 0~1 之间的数，收到：${v}`);
        }
        opts.strength = n;
        i = ni;
        break;
      }
      case "--seed": {
        const [v, ni] = takeValue(i, a);
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) {
          throw new UsageError(`seed 必须是非负整数，收到：${v}`);
        }
        opts.seed = n;
        i = ni;
        break;
      }
      case "-g":
      case "--genre": {
        const [v, ni] = takeValue(i, a);
        if (!(GENRES as readonly string[]).includes(v)) {
          throw new UsageError(`未知体裁 ${v}，合法值：${GENRES.join("|")}`);
        }
        opts.genre = v as GenreArg;
        i = ni;
        break;
      }
      case "--style": {
        const [v, ni] = takeValue(i, a);
        if (!(STYLES as readonly string[]).includes(v)) {
          throw new UsageError(`未知文风 ${v}，合法值：${STYLES.join("|")}`);
        }
        opts.style = v as StyleArg;
        i = ni;
        break;
      }
      case "--zhuque":
        opts.zhuque = true;
        break;
      case "--bestof": {
        // 可选数字值：下一个参数是纯数字才消费，否则按自动候选数
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          const n = Number(next);
          if (n < 1 || n > 30) {
            throw new UsageError(`bestof 候选数必须在 1~30，收到：${next}`);
          }
          opts.bestof = n;
          i++;
        } else {
          opts.bestof = 0; // 0 = 自动（由引擎按文本长度定 4~10）
        }
        break;
      }
      case "--score":
        opts.score = true;
        break;
      case "-o":
      case "--out": {
        const [v, ni] = takeValue(i, a);
        opts.out = v;
        i = ni;
        break;
      }
      case "-h":
      case "--help":
        throw new UsageError("__help__");
      case "-v":
      case "--version":
        throw new UsageError("__version__");
      default: {
        if (a.startsWith("-")) {
          throw new UsageError(`未知选项 ${a}`);
        }
        if (opts.file !== undefined) {
          throw new UsageError(`只能处理一个输入文件，收到第二个：${a}`);
        }
        opts.file = a;
      }
    }
  }
  if (opts.text !== undefined && opts.file !== undefined) {
    throw new UsageError("-t 与文件参数互斥，二选一");
  }
  return opts;
}

/** 组装引擎选项（CLI 字段 → HumanizeOptions；auto 体裁不传字段） */
function toEngineOpts(opts: CliOptions): HumanizeOptions {
  return {
    intensity: opts.strength,
    seed: opts.seed,
    style: opts.style,
    zhuqueMode: opts.zhuque ? true : undefined,
    genre: opts.genre === "auto" ? undefined : opts.genre,
  };
}

/** 主流程。返回退出码；所有输出经 io，不直接碰 console/process（可测）。 */
export async function run(argv: string[], io: CliIo): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      if (e.message === "__help__") {
        io.out(`${USAGE}\n`);
        return 0;
      }
      if (e.message === "__version__") {
        io.out(`ai-humanizer v${pkg.version}\n`);
        return 0;
      }
      io.err(`错误：${e.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }

  // ---- 取输入：-t > 文件 > stdin 管道 ----
  let input: string;
  try {
    if (opts.text !== undefined) {
      input = opts.text;
    } else if (opts.file !== undefined) {
      input = io.readFile(opts.file);
    } else {
      input = io.stdin();
    }
  } catch (e) {
    io.err(`错误：读输入失败 —— ${(e as Error).message}\n`);
    return 1;
  }
  if (!input.trim()) {
    io.err("错误：输入为空（-t / 文件参数 / stdin 管道三选一）\n");
    return 1;
  }

  // ---- 处理 ----
  let result: string;
  let beforeScore: number | undefined;
  let afterScore: number | undefined;
  try {
    if (opts.bestof !== undefined) {
      const r = humanizeBestOf(input, { ...toEngineOpts(opts), candidates: opts.bestof || undefined });
      result = r.text;
      beforeScore = r.before.score;
      afterScore = r.after.score;
    } else if (opts.score) {
      const r = humanizeWithScore(input, toEngineOpts(opts));
      result = r.text;
      beforeScore = r.before.score;
      afterScore = r.after.score;
    } else {
      result = humanize(input, toEngineOpts(opts));
    }
  } catch (e) {
    io.err(`错误：引擎处理失败 —— ${(e as Error).message}\n`);
    return 1;
  }

  // ---- 输出 ----
  try {
    if (opts.out !== undefined) {
      io.writeFile(opts.out, result);
      io.err(`已写入 ${opts.out}\n`);
    } else {
      io.out(result.endsWith("\n") ? result : `${result}\n`);
    }
    // bestof 是无条件打（选优的意义就是前后对比，用户显式选了它就必然想知道结果）；
    // 普通路径尊重 --score 开关（默认只出正文，保持管道友好）。
    if ((opts.score || opts.bestof !== undefined) && beforeScore !== undefined && afterScore !== undefined) {
      const delta = afterScore - beforeScore;
      io.err(
        `[score] aiScore ${beforeScore} → ${afterScore}（${delta <= 0 ? "" : "+"}${delta}，越低越不像 AI）\n`,
      );
    }
  } catch (e) {
    io.err(`错误：写输出失败 —— ${(e as Error).message}\n`);
    return 1;
  }
  return 0;
}

/** node 真实 IO 实现 */
export const nodeIo: CliIo = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  stdin: () => {
    try {
      return fs.readFileSync(0, "utf8");
    } catch {
      return ""; // 非管道环境 fd 0 读不动时按空输入处理
    }
  },
  readFile: (p) => fs.readFileSync(p, "utf8"),
  writeFile: (p, s) => {
    const dir = path.dirname(p);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, s, "utf8");
  },
};

/** 直接执行判定（tsx scripts/cli.ts 与 bundle 后 node dist-cli/cli.mjs 都成立） */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  run(process.argv.slice(2), nodeIo).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`错误：${(e as Error).stack ?? e}\n`);
      process.exitCode = 1;
    },
  );
}
