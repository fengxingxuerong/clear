/**
 * 验证：问题在「替换目标词质量」，不在「替换频率」。
 * 统计 VOCAB 里那些"书面词 → 口语替身"的映射，人工评审哪些替身是病词。
 */
import { VOCAB } from "../src/engine/humanize-data.ts";

// 已知病词（来自实测输出 + 本轮诊断）
const BROKEN_OUTPUTS = new Set([
  "拉扯到根上", "上心", "当回事", "搭起", "补齐", "立起", "弄全", "垒起",
  "开花结果", "死磕", "摆平", "捋顺", "兜好", "拔高", "盯紧", "把牢", "兜住",
  "连上壁垒", "全整条线", "全流程", "看住", "看重", "谈", "瞅",
]);

const entries = Object.entries(VOCAB);
console.log(`VOCAB 总词条: ${entries.length}\n`);

let brokenCount = 0;
let totalCandidates = 0;
const brokenList: Array<[string, string]> = [];

for (const [from, cands] of entries) {
  const list = Array.isArray(cands) ? cands : [cands];
  totalCandidates += list.length;
  for (const c of list) {
    if (BROKEN_OUTPUTS.has(c)) {
      brokenCount++;
      brokenList.push([from, c]);
    }
  }
}

console.log(`候选替身总数: ${totalCandidates}`);
console.log(`命中已知病词: ${brokenCount}  (${((brokenCount / totalCandidates) * 100).toFixed(1)}%)\n`);

console.log("=== 已知病词替身清单 ===");
for (const [from, c] of brokenList) {
  console.log(`  ${from.padEnd(10)} → ${c}`);
}

// 抽样看高危映射：把正式词换成口语/网络词的
console.log(`\n=== 抽样：书面词 → 口语替身（前 40 条，人工评估风险）===`);
let n = 0;
for (const [from, cands] of entries) {
  const list = Array.isArray(cands) ? cands : [cands];
  if (from.length < 2 || from.length > 4) continue;
  console.log(`  ${from.padEnd(8)} → ${list.join(" / ")}`);
  if (++n >= 40) break;
}
