/**
 * 真实案例端到端跑测（v0.9.46）
 *
 * 为什么单开这个文件：项目自带的 scan-bugs 跑的是**模板语料**（v5.2/v6.0 合成句 + 多强度多种子），
 * 历史上每次拿真实稿件试一轮都能抓出模板没盖住的缺陷。本轮目标是反过来——用真实形态的输入，
 * 先看**客观不变量**（丢内容 / 结构坏 / 标点烂 / 占位泄漏），再看人味效果。
 *
 * 判据分两层，故意分开：
 *   A. 硬缺陷（不可辩驳）：URL/邮箱/数字/英文专名/代码行丢失、引号不配对、段落数变化、
 *      长度失控、占位符残留、黑话泄漏。这些不需要语言直觉，机器说了算。
 *   B. 软缺陷（必须人读）：通顺度、语义是否走样。脚本只负责把 before/after 落盘方便逐篇看。
 *
 * 用法：npx tsx artifacts/realcase/run.ts [--only C3-tech-popular]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../../src/engine/humanize.ts";
import { aiScore } from "../../src/engine/humanize-metrics.ts";
import { LEAK_WORDS } from "../verify-quality.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;

interface Case {
  id: string;
  title: string;
  text: string;
}
const cases: Case[] = JSON.parse(fs.readFileSync(path.join(HERE, "cases.json"), "utf8")).cases;
fs.mkdirSync(OUT, { recursive: true });

const uniq = (a: string[]) => [...new Set(a)];
const grab = (s: string, re: RegExp) => uniq(s.match(re) ?? []);

const RE_URL = /https?:\/\/[^\s)）】，。；、"']+/g;
const RE_MAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const RE_NUM = /\d+(?:\.\d+)?%?/g;
const RE_ASCII_WORD = /[A-Za-z][A-Za-z0-9._-]{2,}/g;

/** 代码/纯符号行：汉字占比极低且有一定长度——这类行一旦被"润色"就是事故 */
function codeLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (l.length < 8) return false;
      const han = (l.match(/[\u4e00-\u9fa5]/g) ?? []).length;
      return han / l.length < 0.2;
    });
}

function paraCount(s: string): number {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;
}

interface Finding {
  level: "HARD" | "SOFT";
  kind: string;
  detail: string;
}

function check(before: string, after: string): Finding[] {
  const F: Finding[] = [];
  const push = (level: Finding["level"], kind: string, detail: string) =>
    F.push({ level, kind, detail });

  // 1. URL / 邮箱不得丢（丢了就是"把原文事实改没了"）
  for (const u of grab(before, RE_URL)) {
    if (!after.includes(u)) push("HARD", "URL 丢失", u);
  }
  for (const m of grab(before, RE_MAIL)) {
    if (!after.includes(m)) push("HARD", "邮箱丢失", m);
  }

  // 2. 数字不得丢忘olean 专门的 LLM 才有改数字的余地，本地引擎绝不能动
  const numsBefore = grab(before, RE_NUM);
  const numsAfter = grab(after, RE_NUM);
  const lostNums = numsBefore.filter((n) => !numsAfter.includes(n));
  if (lostNums.length) push("HARD", "数字丢失", lostNums.slice(0, 6).join(" / "));

  // 3. 英文专名（含版本号 / 型号）丢失
  const wordsBefore = grab(before, RE_ASCII_WORD);
  const lostWords = wordsBefore.filter((w) => !after.includes(w));
  if (lostWords.length) push("HARD", "英文专名丢失", lostWords.slice(0, 8).join(" / "));

  // 4. 代码块 / 纯符号行必须原样保留
  for (const line of codeLines(before)) {
    if (!after.includes(line)) push("HARD", "代码行丢失/被改写", line.slice(0, 60));
  }

  // 5. 引号配对（中文成对引号 + 直引号）
  for (const [open, close, name] of [
    ["“", "”", "中文弯引号"],
    ["「", "」", "日式引号"],
    ['"', '"', "直引号"],
  ] as const) {
    const o = (after.split(open).length - 1) as number;
    const c = (after.split(close).length - 1) as number;
    if (o !== c) push("HARD", `${name}不配对`, `开 ${o} / 闭 ${c}`);
  }

  // 6. 段落数（写一篇文章的人最直观的感受：结构被压扁/被炸开）
  const pb = paraCount(before);
  const pa = paraCount(after);
  if (pb !== pa) push("SOFT", "段落数变化", `${pb} → ${pa}`);

  // 7. 长度失控
  const ratio = after.length / Math.max(1, before.length);
  if (ratio > 1.3) push("HARD", "长度膨胀", `${(ratio * 100).toFixed(0)}%`);
  else if (ratio < 0.7) push("HARD", "长度塌缩", `${(ratio * 100).toFixed(0)}%`);

  // 8. 占位符 / 黑话泄漏
  if (after.includes("\uE000")) push("HARD", "占位符残留", "U+E000 未还原");
  for (const w of LEAK_WORDS) {
    if (after.includes(w) && !before.includes(w)) push("SOFT", "疑似黑话残留", w);
  }

  // 9. 标点体例：同字符连续 3+（省略号/破折号除外）、行首标点
  for (const line of after.split(/\r?\n/)) {
    const l = line.trim();
    if (/^[，。、；：？！）】」》%,.]/.test(l)) push("SOFT", "行首标点", l.slice(0, 20));
    const bad = l.match(/([，。、；：？！])\1{2,}/);
    if (bad) push("SOFT", "连续重复标点", bad[0]);
  }

  // 10. 相邻重复句（切句打散最容易把一句复制两遍）
  const lines = after
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const sentences = lines
    .join("\n")
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 6);
  for (let i = 1; i < sentences.length; i++) {
    if (sentences[i] === sentences[i - 1]) push("HARD", "相邻重复句", sentences[i].slice(0, 30));
  }

  // 11. 空句/只剩标点的句子
  for (const s of sentences) {
    if (/^[，。、；：？！、,.]+$/.test(s)) push("HARD", "空句", JSON.stringify(s));
  }
  return F;
}

/* ------------------------------ 跑 ------------------------------ */
const rows: Array<Record<string, string>> = [];
const allFindings: Array<{ id: string; f: Finding }> = [];

for (const c of cases) {
  if (ONLY && c.id !== ONLY) continue;
  const t0 = Date.now();
  const after = humanize(c.text, { intensity: 0.9, seed: 20261015 });
  const ms = Date.now() - t0;
  const before = c.text;
  const sb = aiScore(before).score;
  const sa = aiScore(after).score;
  const F = check(before, after);

  fs.writeFileSync(path.join(OUT, `${c.id}.before.txt`), before, "utf8");
  fs.writeFileSync(path.join(OUT, `${c.id}.after.txt`), after, "utf8");

  rows.push({
    id: c.id,
    aiScore: `${sb}→${sa}`,
    len: `${before.length}→${after.length}`,
    段落: `${paraCount(before)}→${paraCount(after)}`,
    HARD: String(F.filter((f) => f.level === "HARD").length),
    SOFT: String(F.filter((f) => f.level === "SOFT").length),
    ms: String(ms),
  });
  for (const f of F) allFindings.push({ id: c.id, f });
}

console.log("\n════════ 真实案例跑测：本地引擎（intensity 0.9，seed 20261015）════════\n");
const cols = ["id", "aiScore", "len", "段落", "HARD", "SOFT", "ms"];
console.log(cols.join("\t"));
for (const r of rows) console.log(cols.map((k) => r[k]).join("\t"));

const hard = allFindings.filter((x) => x.f.level === "HARD");
const soft = allFindings.filter((x) => x.f.level === "SOFT");
console.log(`\n──── 硬缺陷 ${hard.length} 条 ────`);
for (const { id, f } of hard) console.log(`  [${id}] ${f.kind}：${f.detail}`);
console.log(`\n──── 软提示 ${soft.length} 条 ────`);
for (const { id, f } of soft) console.log(`  [${id}] ${f.kind}：${f.detail}`);

fs.writeFileSync(
  path.join(HERE, "report.json"),
  JSON.stringify({ rows, findings: allFindings }, null, 2),
  "utf8",
);
console.log(`\n📁 逐篇 before/after 已落 ${OUT}`);
console.log(`📁 机器可读报告 ${path.join(HERE, "report.json")}`);
