// 一次性：执行 humanize.ts 拆分阶段 1a（把「常量 + 替换规则」搬到 humanize-rules.ts）
// 安全约束：
//   ① 只按行段整块搬运，不逐行改写 ⇒ 字节级等价、零行为差异
//   ② 锚点校验失败立即退出，绝不写文件
//   ③ 搬完立刻 tsc + 全量测试；不许改任何测试文件
import fs from "node:fs";

const P = "D:/projects/quaiwei/src/engine/humanize.ts";
const OUT = "D:/projects/quaiwei/src/engine/humanize-rules.ts";
const src = fs.readFileSync(P, "utf8");
const lines = src.split("\n");

const seg = (a, b) => lines.slice(a - 1, b);
const A1 = seg(149, 162); // 常量：概率/阈值
const A2 = seg(295, 490); // 替换规则

const must = (cond, msg) => {
  if (!cond) {
    console.log("ABORT: " + msg);
    process.exit(1);
  }
};

must(A1.slice(0, 5).join("\n").includes("REPLACE_VOCAB_BASE"), "A1 首锚点");
must(A1[A1.length - 1].includes("DROP_CONNECTIVE_INTENSITY_THRESHOLD"), "A1 末锚点");
must(A2.slice(0, 5).join("\n").includes("REPLACE_VOCAB_CANDIDATES"), "A2 首锚点");
must(A2[A2.length - 1].trim() === "]);", "A2 末锚点");

// 待删区间（0-based 闭区间）
const drop = [
  [148, 161],
  [294, 489],
];
const inDrop = (i) => drop.some(([a, b]) => i >= a && i <= b);
const kept = lines.filter((_, i) => !inDrop(i));

const rules = [
  "/**",
  " * humanize-rules.ts —— 替换规则层（2026-10-17 从 humanize.ts 拆出，阶段 1a）。",
  " *",
  " * 拆什么：① 替换概率/阈值的全部常量；② `replaceVocab` 一族规则表与级联守卫",
  " * （`wouldCascade` / `DIR_MODIFIER_VERB_CLASH_RE` / `FORMAL_FORBIDDEN_SUBSTITUTES`）。",
  " *",
  " * 为什么能干净拆：实测本区块**零人类 humanize.ts 内部依赖**（只读 `humanize-data.ts` 的",
  " * `VOCAB_ENTRIES`），所以不存在循环依赖。`humanize.ts` 继续 re-export 这三个符号，",
  " * 36 处外部 import 与 16 个测试文件一行都不用改。",
  " *",
  " * ⚠️ 本文件是**纯搬运**：不许在搬迁过程中改任何规则、阈值或注释。",
  " *    要改行为，等搬迁 commit 落地、全量测试绿了之后另开一个 commit。",
  " */",
  'import { VOCAB_ENTRIES } from "./humanize-data.ts";',
  "",
  ...A1,
  "",
  ...A2,
  "",
].join("\n");

fs.writeFileSync(OUT, rules, "utf8");

// humanize.ts：删掉两段 + 在 import 区之后插入 import/re-export
const importEnd = kept.findIndex((l) => l.startsWith("// 公开 API 面"));
must(importEnd > 0, "找不到「公开 API 面」注释，中止");
const inject = [
  "",
  "// v0.9.53 阶段 1a：替换规则层已拆到 humanize-rules.ts。此处 re-export 保持外部 import 不变。",
  'import {',
  "  REPLACE_VOCAB_BASE,",
  "  REPLACE_VOCAB_SLOPE,",
  "  SOFT_ENDING_PROB,",
  "  SOFT_TAIL_PROB,",
  "  SPLIT_SENTENCE_THRESHOLD,",
  "  SPLIT_SENTENCE_RATE,",
  "  MERGE_SENTENCE_THRESHOLD,",
  "  MERGE_SENTENCE_PREV_MAX,",
  "  MERGE_SENTENCE_RATE,",
  "  INTERJECTION_RATE,",
  "  DROP_CONNECTIVE_INTENSITY_THRESHOLD,",
  "  wouldCascade,",
  "  DIR_MODIFIER_VERB_CLASH_RE,",
  "  FORMAL_FORBIDDEN_SUBSTITUTES,",
  '} from "./humanize-rules.ts";',
  "export {",
  "  wouldCascade,",
  "  DIR_MODIFIER_VERB_CLASH_RE,",
  "  FORMAL_FORBIDDEN_SUBSTITUTES,",
  "};",
  "",
];
kept.splice(importEnd, 0, ...inject);

fs.writeFileSync(P, kept.join("\n"), "utf8");

const cnt = (s, re) => (s.match(re) || []).length;
console.log("humanize-rules.ts 行数:", rules.split("\n").length);
console.log("humanize.ts 行数:", src.split("\n").length, "→", kept.length);
console.log("FORMAL_FORBIDDEN_SUBSTITUTES 出现处: rules=" + cnt(rules, /FORMAL_FORBIDDEN_SUBSTITUTES/g) + " humanize=" + cnt(kept.join("\n"), /FORMAL_FORBIDDEN_SUBSTITUTES/g));
