/**
 * 正则自检：找出「字符类被提前闭合」的正则（2026-10-05 加）
 *
 * ## 起因
 *
 * `classify-genre.ts` 的冒号台词正则字符类写作 `（）()【】[]]`，其中裸的 `[`
 * 让字符类**提前闭合**，整条正则恒不匹配 —— 对话体判定少了一条主特征，
 * 且 Rule 1 里 `dlgColonRatio >= 0.06` 与 combo 的 0.3 权重成为从不生效的死分支。
 * 全项目扫过一遍（257 文件 / 1809 个正则字面量），**这是唯一一处**。
 *
 * ## 为什么不靠 eslint
 *
 * `\[` 会触发 `no-useless-escape`，但那是**误报**：eslint 只看到两个字符，
 * 不知道字符类里裸 `[` 会让类提前闭合。服从 lint 就会把修复改回去。
 *
 * ## 为什么不能靠覆盖率
 *
 * 这类缺陷里**每一行都被执行了**，只是结果永远错。行覆盖率 100% 也照样坏。
 * 只能靠「拿样本打进去，看结果对不对」来发现。
 *
 * ## 判据
 *
 * 对每个正则字面量，用一组**该正则意图匹配的样本**去打：
 * ① 样本能编译；② 全部不命中 ⇒ 该正则对它自己的用途恒失效 ⇒ 报出来。
 * 判据刻意保守：只报「全不命中」，不猜「应该命中几个」——
 * 后者需要知道每个正则的意图，而那正是它没告诉我们的东西。
 */
import fs from "node:fs";
import path from "node:path";

/** 扫描范围（与门禁其余部分一致：进产物的 src/ + 门禁脚本） */
const SCAN_DIRS = ["src", "scripts"];

/** 明显的非正则目录：归档脚本不进产物，且大量是历史实验 */
const SKIP_DIR = /(^|[\\/])(node_modules|dist|coverage|archive|electron-|\.covtmp)([\\/]|$)/;

/**
 * 本文件自己的测试也在扫描范围内，而测试里**故意**写了坏写法当样例。
 * 门禁不能被自己的测试数据绊倒——但也不能简单跳过所有 `*.test.ts`
 * （那会让真实缺陷藏在测试文件里逃过检查）。
 * 这里只跳过**确实以本文件为被测对象**的那一个，并写明理由。
 */
const SKIP_FILES = new Set(["scripts/check-regex-defects.test.ts"]);

function collectFiles(dir: string, out: string[]): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.test(p)) collectFiles(p, out);
    } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 剥掉注释，避免把注释里的 `/` 当成正则分隔符 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** 正则字面量：/.../flags，字符类整体作为一个单元 */
const RE_LITERAL = /\/(?![*/])((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+)\/([gimsuy]*)/g;

/**
 * 判断「字符类提前闭合」是否真的发生。
 *
 * ## 缺陷的准确机制（第一版判断错在这里）
 *
 * 直觉是「字符类里有裸 `[` 就坏」。**不对**——JS 里字符类内部的 `[` 是合法字面量，
 * 标准写法 `[.*+?^${}()|[\]\\]`（转义正则元字符的惯用形式）就靠它匹配 `[`。
 *
 * 真正出事的是**紧跟在类内 `[` 后面的那个未转义 `]`**：它把类**提前闭合**了，
 * 于是类外留下一句字面量 `]`。以本项目的坏写法为例：
 *
 *     [\u4e00-\u9fa5…（）()【】[]]
 *                    ↑ 类在这里就闭合了，类内容不含任何括号
 *                       ↑ 剩下的这个 ] 变成模式里的字面量，于是永远匹配不上
 *
 * 所以判据是：**字符类闭合之后，紧接着出现 `]`** —— 那就是漏出去的字面量。
 * 合法写法里类后是 `*`、`?` 或模式结尾，不会出现落单的 `]`。
 *
 * ## 为什么不靠 eslint
 *
 * 修好之后 `\[` 触发 `no-useless-escape`，但那是误报（eslint 不知道字符类里裸 `[`
 * 的语义）。服从 lint 就把修复改回去了，所以要另立一条不猜意图的判据。
 */
export function hasUnescapedBracketInCharClass(body: string): boolean {
  const open = findCharClassStart(body);
  if (open < 0) return false;
  const close = findCharClassEnd(body, open);
  if (close < 0) return false; // 类没闭合：正则本身非法，交给 tsc/eslint 报
  // 闭合之后紧跟一个落单的 `]` ⇒ 有人本想把它放进类里（写成裸 `[` + `]`）
  return body[close + 1] === "]";
}

/** 找到第一个未转义的 `[`（字符类起点），没有则返回 -1 */
function findCharClassStart(body: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {
      i++;
      continue;
    }
    if (body[i] === "[") return i;
  }
  return -1;
}

/** 从字符类起点找到与之配对的 `]`（跳过转义序列），找不到返回 -1 */
function findCharClassEnd(body: string, open: number): number {
  for (let i = open + 1; i < body.length; i++) {
    if (body[i] === "\\") {
      i++; // 跳过被转义的下一个字符（`\]` 不会闭合类）
      continue;
    }
    if (body[i] === "]") return i;
  }
  return -1;
}

/**
 * 为什么只有一条判据（试过两条，砍掉一条）
 *
 * 初版还有判据 2：「含冒号字符的正则，拿冒号样本打进去，全不命中就报」。
 * 实测**误报 193 处**（257 文件 / 1809 个正则字面量）——绝大多数正则压根不是用来
 * 匹配冒号的：数字提取 `(\d{1,3})`、去尾标点 `[。，,;；:：！!？?\s]+$`、
 * 百分比解析 `(\d+(?:\.\d+)?)\s*%`。它们含冒号只是因为**字符类里列了冒号**，
 * 不是因为要匹配「阿明：」这种台词。
 *
 * 「含冒号」推不出「该匹配冒号样本」——要判断意图就得知道这个正则想干什么，
 * 而那恰恰是它没告诉我们的东西。**误报的门禁比没有门禁更糟**：它训练人忽略红灯，
 * 最后连真缺陷一起放过。
 *
 * 留下的判据 1 不猜意图，只看**结构事实**：字符类闭合后是否紧跟一个落单的 `]`。
 * 这与「这个正则想干什么」无关，所以不会因为新增一个「碰巧含冒号」的正则而误报。
 */
/** 缺陷文案（CLI 输出与扫描共用一份，避免两处各写一份走样） */
export const REASON = "字符类提前闭合：类内未转义的 [ 让 ] 提前收尾，多出来的 ] 变成模式里的字面量";

export interface RegexDefect {
  file: string;
  line: number;
  literal: string;
  reason: string;
}

export function scanRegexDefects(root: string): RegexDefect[] {
  const out: RegexDefect[] = [];
  for (const dir of SCAN_DIRS) {
    for (const f of collectFiles(path.join(root, dir), [])) {
      const rel = path.relative(root, f).split(path.sep).join("/");
      if (SKIP_FILES.has(rel)) continue;
      const raw = fs.readFileSync(f, "utf8");
      const code = stripComments(raw);
      for (const m of code.matchAll(RE_LITERAL)) {
        const body = m[1];
        try {
          new RegExp(body, m[2]);
        } catch {
          continue; // 真语法错由 tsc/eslint 负责，这里不重复报
        }
        const line = code.slice(0, m.index).split("\n").length;
        // 判据：字符类闭合后紧跟落单的 `]`。机制与踩过的坑写在
        // hasUnescapedBracketInCharClass 的注释里，这里不重复。
        if (hasUnescapedBracketInCharClass(body)) {
          out.push({ file: rel, line, literal: m[0], reason: REASON });
        }
      }
    }
  }
  return out;
}

export function runRegexSelfCheck(root: string): { ok: boolean; defects: RegexDefect[] } {
  const defects = scanRegexDefects(root);
  return { ok: defects.length === 0, defects };
}

/* CLI 入口：npx tsx scripts/check-regex-defects.ts */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("check-regex-defects.ts")) {
  const root = process.cwd();
  const { ok, defects } = runRegexSelfCheck(root);
  if (ok) {
    console.log("✅ 正则自检通过：全项目无「字符类提前闭合」写法");
    console.log(
      "   （判据：字符类闭合后不得紧跟落单的 ]。这类缺陷行覆盖率抓不到——行被执行了，只是结果永远错）",
    );
  } else {
    console.error(`❌ 正则自检失败：${defects.length} 处「字符类提前闭合」写法\n`);
    for (const d of defects) {
      console.error(`   ${d.file}:${d.line}  ${d.reason}`);
      console.error(`     ${d.literal}`);
      console.error(`     修法：把字符类里的 [ 写成 \\[\n`);
    }
    process.exit(1);
  }
}
