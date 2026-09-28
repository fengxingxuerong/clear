/**
 * 决定性实验：替换概率 p 扫描。
 * 不改源码，用环境变量注入 p 的覆盖值，扫出「损伤最小 vs 去味有效」的甜点。
 *
 * 手段：临时脚本内直接 monkey-patch 不行（p 是模块内常量），
 * 改用「复制 humanize.ts 的 replaceVocab 逻辑 + 手工跑管线」不可行（函数未导出）。
 * → 采用源码级实验：写一个可参数化的最小复现，测 p 对输出的影响方向。
 */
import { VOCAB } from "../src/engine/humanize-data.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";
import { splitSentences } from "../src/engine/humanize-text.ts";

// 取 VOCAB 里「书面词 → 口语替身」的映射（复刻 REPLACE_VOCAB_CANDIDATES 的口径）
const entries = Object.entries(VOCAB).filter(([k]) => k.length >= 2).slice(0, 400);
console.log(`VOCAB 词条数: ${Object.keys(VOCAB).length}, 参与实验: ${entries.length}`);

const SRC = `综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系。`;

// 用确定性 rng 模拟替换，扫 p
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyVocabAt(text: string, p: number, seed = 20260826): string {
  const rng = mulberry32(seed);
  let base = text;
  for (const [from, candidates] of entries) {
    let idx = base.indexOf(from);
    if (idx === -1) continue;
    const hits: { at: number; rep: string }[] = [];
    while (idx !== -1) {
      const end = idx + from.length;
      if (rng() < p) {
        const rep = candidates[Math.floor(rng() * candidates.length)];
        const nextCh = base.charAt(end);
        if (rep && nextCh && !rep.endsWith(nextCh)) hits.push({ at: idx, rep });
      }
      idx = base.indexOf(from, end);
    }
    if (hits.length) {
      let out = "";
      let cursor = 0;
      for (const { at, rep } of hits) {
        out += base.slice(cursor, at) + rep;
        cursor = at + from.length;
      }
      base = out + base.slice(cursor);
    }
  }
  return base;
}

console.log(`\n原文: score=${aiScore(SRC).score} 字数=${SRC.length}\n`);
console.log("p      当前公式含义          score  字数  样例（前 80 字）");
console.log("-".repeat(96));

const CASES = [
  [0.10, "极保守（=base 0.1）"],
  [0.20, ""],
  [0.30, ""],
  [0.40, ""],
  [0.50, ""],
  [0.65, "旧式 intensity=0 起点"],
  [0.875, "旧式 intensity=0.5"],
  [0.965, "旧式 intensity=0.7"],
  [1.00, "旧式 intensity=0.9"],
];

for (const [p, note] of CASES as Array<[number, string]>) {
  const out = applyVocabAt(SRC, p);
  const sc = aiScore(out);
  console.log(
    `${String(p).padEnd(7)}${note.padEnd(22)}${String(sc.score).padStart(4)}   ${String(out.length).padEnd(5)} ${out.slice(0, 70)}`,
  );
}

console.log("\n\n=== 详细对比：p=0.3 vs p=1.0 ===");
const low = applyVocabAt(SRC, 0.3);
const high = applyVocabAt(SRC, 1.0);
console.log(`\n【原文】\n${SRC}`);
console.log(`\n【p=0.3, score=${aiScore(low).score}】\n${low}`);
console.log(`\n【p=1.0, score=${aiScore(high).score}】\n${high}`);
console.log(`\n句子数: 原文 ${splitSentences(SRC).length} / p=0.3 后 ${splitSentences(low).length} / p=1.0 后 ${splitSentences(high).length}`);
