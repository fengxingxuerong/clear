/**
 * scripts/check-ledger-appendonly.ts
 * 凭证账本 append-only 的提交时强制
 *
 * 为什么需要它：scripts/zhuque-evidence.ts 的 `seal()` 用 appendFileSync 写账本，
 * 整套外部真值（哈希复算、页面原文互证、y 值交叉核对）都建立在"历史行不会被动"之上。
 * 但 audit 能发现的只是**字段对不上**的那些：
 *   · 整行被删掉 —— audit 只会少看一条，剩下的一致就报通过；
 *   · 行序被重排 —— 同上，它不关心顺序；
 *   · 改的是不参与复算的自由文本字段（note 一类） —— 复算不到，静默通过。
 * 也就是说"账本可篡改"这件事一直只靠自觉。这条脚本把它变成会拦的门禁。
 *
 * 判据只有一条、也是最强的一条：**HEAD 的每一行必须按原顺序原样出现在新内容的开头**
 * （只许在后面追加）。删除 / 改写 / 重排三种篡改在"最长公共前缀"这一步全部现形，
 * 不需要维护第二套规则。
 *
 * 用法：
 *   npx tsx scripts/check-ledger-appendonly.ts                      # HEAD vs 工作区
 *   npx tsx scripts/check-ledger-appendonly.ts --staged             # HEAD vs git 索引（hook 用）
 *   npx tsx scripts/check-ledger-appendonly.ts --head-file a --staged-file b   # 离线/自测
 * 退出码：0=只追加了；1=历史被动过；2=用法或环境错误。
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { execFileSync } from "child_process";

export const LEDGER_REL_DEFAULT = path.join("evidence", "zhuque", "ledger.jsonl");

export type Violation = {
  kind: "modified" | "reordered" | "truncated" | "deleted-all";
  /** HEAD 里出问题的行号（1 起） */
  line: number;
  headText: string;
  stagedText?: string;
};

export type Verdict = {
  ok: boolean;
  violations: Violation[];
  headLines: number;
  stagedLines: number;
};

/** 归一化：忽略行尾空白与 CRLF，但**不**忽略行内内容 */
function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim());
}

/** 只比较"前缀是否被保住"，追加多少行都不管。 */
export function diffLedger(headText: string, stagedText: string): Verdict {
  const h = linesOf(headText).filter(Boolean);
  const s = linesOf(stagedText).filter(Boolean);
  const base: Pick<Verdict, "headLines" | "stagedLines"> = {
    headLines: h.length,
    stagedLines: s.length,
  };

  if (h.length === 0) return { ok: true, violations: [], ...base };
  if (s.length === 0)
    return {
      ok: false,
      violations: [{ kind: "deleted-all", line: 1, headText: h[0] }],
      ...base,
    };

  let i = 0;
  while (i < h.length && i < s.length && h[i] === s[i]) i++;
  if (i >= h.length) return { ok: true, violations: [], ...base }; // 纯追加（含零追加）

  const headLine = h[i];
  const violations: Violation[] = [];
  const restOfStaged = new Set(s.slice(i));
  if (s.length < h.length) {
    // 新内容比 HEAD 还短：从第 i+1 行起整段被砍掉
    violations.push({ kind: "truncated", line: i + 1, headText: h.slice(i).join("\n") });
  } else if (restOfStaged.has(headLine)) {
    violations.push({ kind: "reordered", line: i + 1, headText: headLine, stagedText: s[i] });
  } else {
    // 这一行在新内容里彻底不见了：要么被改写，要么被删除——两者都无法区分，
    // 因为删一行和改一行在"前缀断裂"上是同一个现象。分开报只会给读者假精确。
    violations.push({
      kind: "modified",
      line: i + 1,
      headText: headLine,
      stagedText: s[i],
    });
  }
  return { ok: false, violations, ...base };
}

type Opts = {
  headText: string | null;
  stagedText: string | null;
  headFile: string | null;
  stagedFile: string | null;
  /** 走文件对照，绝不回落到 git（否则自测时 head-file 缺失会去读真仓库的 HEAD，测出假结果） */
  offline: boolean;
  useStagedIndex: boolean;
  ledgerRel: string;
  repo: string;
  quiet: boolean;
  usageError: string | null;
};

const USAGE =
  "用法：npx tsx scripts/check-ledger-appendonly.ts [--staged] [--ledger <仓库内相对路径>] [--repo <目录>]\n" +
  "     离线/自测：npx tsx scripts/check-ledger-appendonly.ts --head-file <a.jsonl> --staged-file <b.jsonl>";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
}

export function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    headText: null,
    stagedText: null,
    headFile: null,
    stagedFile: null,
    offline: false,
    useStagedIndex: argv.includes("--staged"),
    ledgerRel: flag(argv, "--ledger") ?? LEDGER_REL_DEFAULT,
    repo: path.resolve(flag(argv, "--repo") ?? process.cwd()),
    quiet: argv.includes("--quiet"),
    usageError: null,
  };
  const hf = flag(argv, "--head-file");
  const sf = flag(argv, "--staged-file");
  if (argv.includes("--head-file") && !hf) o.usageError = "❌ --head-file 需要一个文件路径";
  if (argv.includes("--staged-file") && !sf) o.usageError = "❌ --staged-file 需要一个文件路径";
  o.headFile = hf ?? null;
  o.stagedFile = sf ?? null;
  o.offline = Boolean(hf || sf);
  if (o.stagedFile && !o.headFile)
    o.usageError = "❌ --staged-file 必须与 --head-file 同时给（否则没有对照基准）";
  if (o.headFile && o.stagedFile && !o.usageError) {
    try {
      o.headText = fs.readFileSync(o.headFile, "utf8");
    } catch {
      // HEAD 侧读不到 = 账本还不存在（首次入账），后面按"无历史"处理
      o.headText = null;
    }
    try {
      o.stagedText = fs.readFileSync(o.stagedFile, "utf8");
    } catch (e) {
      o.usageError = `❌ --staged-file 读不出来：${(e as Error).message}`;
    }
  }
  return o;
}

/** git show <ref>:<path>；文件/该 ref 下不存在时返回 null（不当错误） */
function gitShow(repo: string, spec: string): string | null {
  try {
    return execFileSync("git", ["-C", repo, "show", spec], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const o = parseArgs(argv);
  if (o.usageError) {
    console.error(o.usageError);
    console.error(USAGE);
    return 2;
  }

  let headText = o.headText;
  let stagedText = o.stagedText;

  if (o.offline) {
    // 文件对照模式：HEAD 侧读不到就是"账本还不存在"，按无历史处理，绝不回落到真仓库
    headText = o.headText ?? "";
    stagedText = o.stagedText ?? "";
  } else {
    // 走 git：HEAD 一侧 + 索引或工作区一侧
    const rel = o.ledgerRel.split(path.sep).join("/");
    if (headText === null) headText = gitShow(o.repo, `HEAD:${rel}`) ?? "";
    if (stagedText === null) {
      stagedText = o.useStagedIndex
        ? (gitShow(o.repo, `:${rel}`) ?? "") // 索引里的待提交版本
        : (() => {
            try {
              return fs.readFileSync(path.join(o.repo, o.ledgerRel), "utf8");
            } catch {
              return ""; // 工作区没有这个文件：若 HEAD 里有，diffLedger 会判 deleted-all
            }
          })();
    }
  }

  const v = diffLedger(headText ?? "", stagedText ?? "");
  if (!o.quiet) {
    console.log(`凭证账本 append-only 检查：HEAD ${v.headLines} 行 → 待提交 ${v.stagedLines} 行`);
  }
  if (v.ok) {
    if (!o.quiet)
      console.log(`✅ 只追加了 ${Math.max(0, v.stagedLines - v.headLines)} 行，历史一字未动`);
    return 0;
  }
  const label: Record<Violation["kind"], string> = {
    "deleted-all": "整本账本被删除",
    modified: "改写或删除了历史行",
    reordered: "重排了历史行",
    truncated: "截断了账本尾部",
  };
  console.error("❌ 凭证账本的历史行被动过了，这不是追加：");
  for (const x of v.violations) {
    console.error(`   · 第 ${x.line} 行：${label[x.kind]}`);
    console.error(`     HEAD：${String(x.headText).slice(0, 160)}`);
    if (x.stagedText) console.error(`     现在：${String(x.stagedText).slice(0, 160)}`);
  }
  console.error(
    "   → 账本的价值就在于历史不可改。要更正一条记录，请**追加**一条新记录（同 id 的新提交），\n" +
      "     由 `zhuque-evidence.ts audit` 的 pct-conflict 规则去暴露矛盾；不要编辑 ledger.jsonl 的旧行。\n" +
      "   → 确属误报（例如你就是在做一次有意的历史整理，并已另行留档）：git commit --no-verify",
  );
  return 1;
}

// 直接执行才跑；被测试 import 时不产生副作用（与 zhuque-evidence.ts 同一套入口判断）
const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) process.exit(main());
