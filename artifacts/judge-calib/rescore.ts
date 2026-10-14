/**
 * judge-calib/rescore.ts —— 从落盘原始响应重算评分（不重跑 LLM，不烧额度）
 *
 * 用法：npx tsx artifacts/judge-calib/rescore.ts [结果文件名（默认取最新）]
 *
 * 为什么需要它：首次校准跑完后才发现判定阈值有缺陷（固定 ≥4 对短 frag 永远不可达）。
 * 重跑一遍要烧 28 次调用，而闸门已在 429 限流。**已落盘的原始响应就是事实**，
 * 判定逻辑改了直接重算即可——这也是"LLM 输出必须落盘"的实际收益。
 */
import { readFileSync, readdirSync } from "node:fs";
import { CASES } from "./cases.ts";

function clean(s: string): string {
  return s.replace(/[\s，。！？、；：""''（）《》"'.,!?;:()[\]]/g, "");
}
function lcs(a: string, b: string): number {
  const s = clean(a);
  const t = clean(b);
  if (!s || !t) return 0;
  let best = 0;
  const dp = new Array<number>(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i++) {
    let prev = 0;
    for (let j = 1; j <= t.length; j++) {
      const cur = dp[j];
      dp[j] = s[i - 1] === t[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = cur;
    }
  }
  return best;
}

const dir = "artifacts/judge-calib/results";
const arg = process.argv[2];
const file = arg ?? readdirSync(dir).sort().pop();
if (!file) {
  console.error("results/ 目录为空");
  process.exit(1);
}
const j = JSON.parse(readFileSync(`${dir}/${file}`, "utf-8"));
console.log(`重算 ${file}（模型 ${j.model} / 变体 ${j.variant}）\n`);

let hit = 0;
let miss = 0;
let cleanOk = 0;
let cleanBad = 0;
const missed: string[] = [];

for (const r of j.rows) {
  const c = CASES.find((x) => x.id === r.id)!;
  if (r.error) {
    console.log(`  ERR ${r.id}  ${r.error.slice(0, 40)}`);
    continue;
  }
  if (c.kind === "clean") {
    const ok = r.reported === 0;
    ok ? cleanOk++ : cleanBad++;
    console.log(`  ${ok ? "✅" : "⚠️误报"} ${r.id.padEnd(22)} 报${r.reported}条`);
    continue;
  }
  // 从原始响应里重新提取 issues
  let issues: { sentence?: string; reason?: string; type?: string }[] = [];
  try {
    const fenced = String(r.raw).match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : String(r.raw);
    const s = body.indexOf("{");
    const e = body.lastIndexOf("}");
    issues = JSON.parse(body.slice(s, e + 1)).issues ?? [];
  } catch {
    issues = [];
  }
  const frag = c.frag ?? "";
  const need = Math.min(4, clean(frag).length);
  let best = 0;
  let quoted = "";
  for (const it of issues) {
    const b = Math.max(
      lcs(it.sentence ?? "", frag),
      lcs(it.reason ?? "", frag),
      lcs(it.type ?? "", frag),
    );
    if (b > best) {
      best = b;
      quoted = (it.sentence ?? "").slice(0, 34);
    }
  }
  const ok = best >= need;
  ok ? hit++ : miss++;
  if (!ok) missed.push(`${c.id}（报了${issues.length}条，最接近 LCS=${best}/${need}）`);
  console.log(
    `  ${ok ? "✅" : "❌"} ${c.id.padEnd(22)} LCS=${String(best).padStart(2)}/${need} 报${issues.length}条 ｜ ${quoted}`,
  );
}

console.log(
  `\n修正后召回 ${hit}/${hit + miss}（${((hit / (hit + miss)) * 100).toFixed(0)}%）｜干净稿未误报 ${cleanOk}/${cleanOk + cleanBad}`,
);
if (missed.length) {
  console.log(`\n仍未识别 ${missed.length} 条：`);
  for (const m of missed) console.log(`  · ${m}`);
}
