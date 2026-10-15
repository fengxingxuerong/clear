/**
 * scripts/realcase/leak-scan.ts — 正式语体替身泄漏扫描器（v0.9.50）
 *
 * 跑法：`npx tsx scripts/realcase/leak-scan.ts [--seeds 20]`
 *
 * 为什么要有这个东西：
 *   v0.9.46 建了 FORMAL_FORBIDDEN_SUBSTITUTES（替身级黑名单），v0.9.49 加了
 *   INFORMAL_ONLY_KEYS（词条级手抄冻结），每条都是**被某个真实案例打出来的**。
 *   而替身级黑名单有个结构性死角：一个词条的候选池每扩一个词就多一个洞，
 *   rng 挑到没被毙的那个照样漏——v0.9.50 一次多种子扫描就抄出
 *   「透出 / 办妥 / 围着」三条 v0.9.49 声称已经修好的漏网。
 *   ⇒ **单点跑一遍产出 == 均匀分布的一个抽样**，必须多种子扫，且必须定期扫。
 *
 * 本脚本做两件事：
 *
 *   ① 已知坏替身的海报VIew-scan：BAD_WORDS 里的词在正式体裁产出中出现一次即报红。
 *      （登记口径与 src/engine/vocab-formal-substitutes.test.ts 同源，别两处各抄一份。）
 *
 *   ② 疑似 review 清单：把正式体裁产出里**所有**来自 VOCAB 的替换列成清单，
 *      按出现频次排序输出。这不是门禁，是给人工复核用的观察窗——
 *      词表每扩一批词，跑一次就能看到新词亲爱的在正式稿里长什么样。
 *
 * ⚠️ 判"是否泄漏"只能看**实际产出**（NGram 反查 VOCAB），不能看表 ——
 *    表上写着"已经封死"，产出一个 suffers 都比一屏绿色的断言有说服力。
 */
import { readFileSync } from "node:fs";
import { humanize } from "../../src/engine/humanize";
import { classifyGenre } from "../../src/engine/classify-genre";
import { VOCAB } from "../../src/engine/humanize-vocab";
import { aiScore } from "../../src/engine/humanize-metrics";

/** 从 `--seeds N` 读次郎数；默认 12 —— 12 是「既不慢又能量出 10% 级泄漏」的实测折中 */
const seedsArg = process.argv.indexOf("--seeds");
const SEEDS = seedsArg > -1 ? Number(process.argv[seedsArg + 1]) : 12;

/**
 * 已知在正式语体下不可接受的替身。每条都注明来源，
 * 与 vocab-formal-substitutes.test.ts 的 REALCASE_ONLY 口径一致。
 */
const BAD_WORDS = [
  "环绕", // C1：团队紧紧环绕公司年度战略目标
  "围着", // C1：聚焦于 → 围着（v0.9.50 新抄出）
  "使劲", // C1：使劲在下一季度取得更加优异的成绩
  "下功夫", // 同上同源
  "看得出来", // C1：主要看得出来在跨部门…
  "做到位", // C1：方方面面做到位各项重点工作任务
  "办妥", // v0.9.50 新抄出：落实 → 办妥
  "做实", // 同上词条另一候选，一并盯
  "透出", // v0.9.50 新抄出：体现 → 透出
  // —— v0.9.50 第二批：同样由复核窗抓出，随后已按「混合池毙替身 / 整池冻结词条」处置 ——
  "变强", // 增强
  "加把劲", // 增强
  "抓实", // 加强
  "抓紧", // 加强
  "联手", // 协同 / 通力
  "这么一来", // 从而
  "说起来", // 值得注意的是（整池冻结）
  "顺带一提", // 值得注意的是
  "有个细节", // 值得注意的是
  "方方面面", // 全面（整池冻结）
  "铺开", // 全面
  // v0.9.50 第三条：这条不是语体崩而是**病句**（「使一起用表征具备领域不变性」），
  // 任何体裁都不许产出 —— 所以登记在这里而不是 FORMAL_FORBIDDEN_SUBSTITUTES。
  "一起用", // 共享
];

/** VOCAB 替身反查：候选 → 源词（一个替身可能属于多个词条） */
const SUBSTITUTE_OWNERS = new Map<string, string[]>();
for (const [from, tos] of Object.entries(VOCAB)) {
  for (const t of tos) {
    if (t === from) continue;
    const owners = SUBSTITUTE_OWNERS.get(t) ?? [];
    owners.push(from);
    SUBSTITUTE_OWNERS.set(t, owners);
  }
}

function loadCases(): { id: string; text: string }[] {
  const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
  return Array.isArray(cases) ? cases : cases.cases || [];
}

const list = loadCases();
let badTotal = 0;
/** 复核窗按体裁分开：正式体裁（main）的产出才需要按书面语体审，
 *  对话/叙事里出现口语替身是设计意图，混在一张表里会让清单失去行动价值。 */
const reviewFormal = new Map<string, number>();
const reviewCasual = new Map<string, number>();
const rows: string[] = [];

console.log(`正式语体泄漏扫描 · ${list.length} 篇 × ${SEEDS} seed · 强度 0.9 · 自动体裁\n`);

for (const c of list) {
  const genre = classifyGenre(c.text).genre;
  const count = new Map<string, number>();
  let scoreSum = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const out = humanize(c.text, { intensity: 0.9, seed, genre: genre as never });
    scoreSum += aiScore(out).score;
    for (const word of SUBSTITUTE_OWNERS.keys()) {
      if (!out.includes(word)) continue;
      // 原文自带该词的（作者自己就写了口语词）不算"引擎产出"
      if (c.text.includes(word)) continue;
      count.set(word, (count.get(word) ?? 0) + 1);
      if (BAD_WORDS.includes(word)) badTotal++;
    }
  }
  const bad = [...count.entries()].filter(([w]) => BAD_WORDS.includes(w));
  const bucket = genre === "main" ? reviewFormal : reviewCasual;
  for (const [w, n] of count) bucket.set(w, (bucket.get(w) ?? 0) + n);
  rows.push(
    `${c.id.padEnd(20)} [${String(genre).padEnd(9)}] aiScore均值 ${(scoreSum / SEEDS)
      .toFixed(1)
      .padStart(
        5,
      )}  ${bad.length ? "❌ " + bad.map(([w, n]) => `${w}×${n}`).join(" ") : "✅ 无已知坏替身"}`,
  );
}

console.log(rows.join("\n"));
console.log(`\n已知坏替身总命中：${badTotal} ${badTotal === 0 ? "（干净）" : "（❌ 必须处置）"}`);

function dump(title: string, src: Map<string, number>) {
  console.log(`\n──── ${title}（人工复核窗，非门禁）────`);
  const sorted = [...src.entries()].sort((a, b) => b[1] - a[1]);
  for (const [w, n] of sorted) {
    console.log(
      `  ${String(n).padStart(3)}  ${w}   ← ${(SUBSTITUTE_OWNERS.get(w) ?? []).join(" / ")}`,
    );
  }
  if (!sorted.length) console.log("  （无）");
}

dump("正式体裁产出里的全部 VOCAB 替身 ← 按书面语体审这张", reviewFormal);
dump("非正式体裁产出里的 VOCAB 替身（口语替身是设计意图，仅作对照）", reviewCasual);

process.exit(badTotal === 0 ? 0 : 1);
