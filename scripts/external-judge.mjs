/**
 * scripts/external-judge.mjs —— 用"非自家谱系"的外部席位复评交付稿
 *
 * 为什么需要它（2026-09-22）：本仓所有"能力"结论都建立在两把自家尺子上——本地 aiScore
 * （UI 里那个数）和闭环评委（DeepSeek 系）。实测发现论说/叙事稿上本地 13、外部席位 80，
 * 见 docs/external-judge-findings.md。要复查这类分歧，必须有一个与被评文本生成模型
 * 不同系的席位，且要能量它自己的抖动（重复评 N 次看极差）。
 *
 * 与朱雀官方 API 的区别：这仍是 LLM 主观分，不是官方真值，不能拿来换算"过没过 40% 线"。
 * 它的用途只有一个——**检验我们自己那把尺有没有在说谎**。
 *
 * 用法（必须走 tsx：脚本 import 了 src/ 下的 .ts）：
 *   npx tsx scripts/external-judge.mjs <含外部访问串的文件> [--model step-3.5-flash]
 *        [--base https://api.stepfun.com/v1] [--reps 3] [--len 65] [--dir artifacts/llm-cap-0920]
 *
 * 凭证纪律：文件路径只作参数传入，本脚本不复制、不打印其内容，也不把它写进任何仓库文件；
 * 目标串靠"本仓凭证文件里从未出现过的哈希"锁定，只输出长度与 sha256 前 8 位。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { judgeAiScore } from "../src/api/llm-judge.ts";
import { aiScore } from "../src/engine/humanize.ts";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const SRC_FILE = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
if (!SRC_FILE || !fs.existsSync(SRC_FILE)) {
  console.error("用法：npx tsx scripts/external-judge.mjs <含外部访问串的文件> [--model …] [--base …] [--reps 3] [--len 65]");
  process.exit(2);
}
const MODEL = arg("model", "step-3.5-flash");
const BASE = arg("base", "https://api.stepfun.com/v1");
const REPS = Number(arg("reps", "3"));
const WANT_LEN = Number(arg("len", "0"));
const DIR = arg("dir", "artifacts/llm-cap-0920");

const digest = (s) => crypto.createHash("sha256").update(s).digest("hex");
const known = new Set();
for (const f of ["scripts/.sensenova-keys", "endpoints.local.json"]) {
  if (!fs.existsSync(f)) continue;
  for (const m of fs.readFileSync(f, "utf8").matchAll(/[A-Za-z0-9._-]{20,}/g)) known.add(digest(m[0]));
}
// 统一形状：首字符字母数字、后续字母数字与 . _ -，总长 ≥40
const SHAPE = /[A-Za-z0-9][A-Za-z0-9._-]{39,}/g;
const cands = [...new Set((fs.readFileSync(SRC_FILE, "utf8").match(SHAPE) || []))].filter(
  (c) => !known.has(digest(c)),
);
if (!cands.length) {
  console.error("该文件里没有本仓从未出现过的候选串——外部席位无法锁定。");
  process.exit(2);
}
const picked = (WANT_LEN ? cands.filter((c) => c.length === WANT_LEN) : cands)[0];
if (!picked) {
  console.error(`按长度 ${WANT_LEN} 没筛到；本仓未见过的那些长度是：${cands.map((c) => c.length).join(" / ")}`);
  process.exit(2);
}
console.log(`外部席位：${BASE} / ${MODEL}   访问串 长度=${picked.length} sha=${digest(picked).slice(0, 8)}`);
console.log(`（与写手 SenseNova/DeepSeek 系不同系；本仓凭证文件里从未出现过这条）\n`);

const cfg = {
  enabled: true,
  baseUrl: BASE,
  apiKey: picked,
  model: MODEL,
  temperature: 0,
  deepMode: false,
  style: "casual",
};

const FILES = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".txt") && !/\.orig\.txt$/.test(f))
  .sort();
if (!FILES.length) {
  console.error(`${DIR} 下没有 .txt 样本`);
  process.exit(2);
}
console.log(`样本目录 ${DIR}：${FILES.length} 份`);
console.log("样本                                   字数  本地aiScore   外部席位重复打分        极差");
const rows = [];
for (const file of FILES) {
  const body = fs.readFileSync(path.join(DIR, file), "utf8");
  if (body.replace(/\s/g, "").length < 80) continue;
  const local = aiScore(body).score;
  const scores = [];
  for (let i = 0; i < REPS; i++) {
    try {
      scores.push(await judgeAiScore(body, cfg));
    } catch (e) {
      scores.push(-1);
      console.log(`   第 ${i + 1} 次调用失败：${String(e.message).slice(0, 70)}`);
    }
  }
  const good = scores.filter((s) => s >= 0);
  const spread = good.length ? Math.max(...good) - Math.min(...good) : NaN;
  const chars = body.replace(/\s/g, "").length;
  rows.push({ file, chars, local, scores, spread });
  console.log(
    `${file.replace(/^.*\//, "").padEnd(36)} ${String(chars).padStart(5)} ${String(local).padStart(9)}   ` +
      `${scores.map((s) => String(s).padStart(3)).join(" / ")}   ${isFinite(spread) ? spread : "?"}`,
  );
}
const out = path.join(DIR, "external-judge.json");
fs.writeFileSync(out, JSON.stringify({ model: MODEL, base: BASE, at: new Date().toISOString(), rows }, null, 2), "utf8");
console.log(`\n分数含义：越高越像 AI 写的。本地分与外部分分歧 >30 时，先怀疑本地尺，再怀疑文本。`);
console.log(`明细已写 ${out}`);
