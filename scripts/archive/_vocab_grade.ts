/**
 * VOCAB 候选替身质量分级：
 *   KEEP   - 正常口语/中性，可用
 *   BROKEN - 明确病词/黑话/语义漂移，应剔除
 *   REVIEW - 边界情况，需人工确认
 *
 * 判定标准（基于实测输出 + 人眼阅读）：
 *   BROKEN: 正常人写正式文章绝不会用；或语义已漂移（连上壁垒）；或黑话（拉扯到根上）
 */
import { writeFileSync } from "node:fs";

const BROKEN = new Set([
  // 黑话/俚语，正式文里不该出现
  "拉扯到根上", "摆平", "死磕", "开花结果", "久久为功",
  // 口语病词（"重视/关注"被换成这些后语体崩坏）
  "上心", "当回事", "看重", "拿它当回事", "往心里去",
  // "建立/构筑/完善" 的坏替身
  "搭起", "搭", "搭出来", "垒起", "弄全", "兜好", "立起", "建起", "补齐",
  "拼起来", "攒起来",
  // "确保" 的坏替身（"盯紧/把牢/兜住"是黑话）
  "盯紧", "把牢", "兜住", "兜着",
  // "解决" 的坏替身
  "捋顺", "捋", "理顺",
  // 语义漂移
  "连上", "连上了", "接上",
  // 方言/极度口语
  "整", "搞", "弄", "咋", "恁", "贼", "麻利", "麻溜", "唠", "瞅",
  // 网络用语
  "真香", "破防", "上头", "拿捏", "封神", "绝了", "栓Q",
  // 其它实测病词
  "全整条线", "整条线", "全流程", "全链条", "全盘",
]);

const REVIEW = new Set([
  // 过于口语但不算错，视体裁而定
  "拿着", "揣着", "抱着", "守着", "掂量", "琢磨", "瞅", "扯",
  "这块", "那一摊", "这一摊", "一堆",
  "慢慢", "一点一点", "陆陆续续",
  "想", "打算", "为了",
  "动不动", "上头",
]);

const SRC_PATH = "C:/Users/Admin（无密码）/.workbuddy/tmp_vocab_dump.json";
// 从 ts 源直接读需要运行时；这里用 tsx 侧产出
import { VOCAB } from "../src/engine/humanize-data.ts";

const rows: Array<{ from: string; candidate: string; verdict: string }> = [];
for (const [from, cands] of Object.entries(VOCAB)) {
  const list = (Array.isArray(cands) ? cands : [cands]).filter((c): c is string => typeof c === "string");
  for (const c of list) {
    const verdict = BROKEN.has(c) ? "BROKEN" : REVIEW.has(c) ? "REVIEW" : "KEEP";
    rows.push({ from, candidate: c, verdict });
  }
}

const broken = rows.filter((r) => r.verdict === "BROKEN");
const review = rows.filter((r) => r.verdict === "REVIEW");
const keep = rows.filter((r) => r.verdict === "KEEP");

console.log(`候选替身总数: ${rows.length}`);
console.log(`  KEEP   ${keep.length}  (${((keep.length / rows.length) * 100).toFixed(1)}%)`);
console.log(`  REVIEW ${review.length}  (${((review.length / rows.length) * 100).toFixed(1)}%)`);
console.log(`  BROKEN ${broken.length}  (${((broken.length / rows.length) * 100).toFixed(1)}%)`);

console.log(`\n=== 确诊 BROKEN 替身（应剔除）共 ${broken.length} 条 ===`);
const byFrom: Record<string, string[]> = {};
for (const r of broken) (byFrom[r.from] ??= []).push(r.candidate);
for (const [from, cs] of Object.entries(byFrom).sort()) {
  console.log(`  ${from.padEnd(10)} → ${cs.join(" / ")}`);
}

console.log(`\n=== 需人工确认 REVIEW 共 ${review.length} 条 ===`);
const byFrom2: Record<string, string[]> = {};
for (const r of review) (byFrom2[r.from] ??= []).push(r.candidate);
for (const [from, cs] of Object.entries(byFrom2).sort().slice(0, 30)) {
  console.log(`  ${from.padEnd(10)} → ${cs.join(" / ")}`);
}

// 统计：有多少个 "from" 词条会变成"无可选替身"
const affected: string[] = [];
for (const [from, cands] of Object.entries(VOCAB)) {
  const list = (Array.isArray(cands) ? cands : [cands]).filter((c): c is string => typeof c === "string");
  const clean = list.filter((c) => !BROKEN.has(c));
  if (clean.length === 0 && list.length > 0) affected.push(from);
}
console.log(`\n=== 剔除后完全无替身的词条（共 ${affected.length} 个 → 该词条将不再替换）===`);
console.log("  " + affected.join(", "));

writeFileSync(SRC_PATH, JSON.stringify({ rows, affected }, null, 2), "utf8");
console.log(`\n已导出明细到 ${SRC_PATH}`);
