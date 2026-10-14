/**
 * mutator/measure.ts —— 用**本地确定性 aiScore** 测量标注对，回答三个可客观验证的问题
 *
 * 用法：npx tsx artifacts/mutator/measure.ts
 *
 * ## 三个问题（都不依赖任何 LLM 裁判的主观判断）
 *
 *  Q1 **区分力**：aiScore 能不能把「真人写」和「AI 腔」分开？
 *      → Δ = aiScore(AI化) − aiScore(人写)。若 Δ 不稳定为正，说明评分尺子
 *        对自己领域的核心对立面无判别力——那比任何病句都严重。
 *
 *  Q2 **刻度单调**：轻→中→重三档 AI 化，分数是否单调递增？
 *      → 若不单调，说明刻度是"非单射"的，用户拖动强度滑块时看到的分数变化不可信。
 *
 *  Q3 **去味有效性 + 负收益**：
 *      · AI 化稿去味后降了多少（有效性）
 *      · **人写稿去味后分数是否上升**（负收益）——人写稿才是"不该被改"的对照组。
 *
 * ## 多采样聚合（v2）
 *
 * 单次采样下"Δ 为负"有两种解释：① 尺子无判别力；② 这次变异恰好改得不够。
 * 所以按 (体裁, 档位) 聚合 n 次采样，看**方向正确率**与**极差**——
 * 稳定反转 = ①，随机横跳 = ②。这是把"4/9 反转"这句结论变可信的唯一办法。
 *
 * 评分固定 seed 保证可复现（引擎是确定性的，同 seed 同输入必同输出）。
 */
import { readFileSync } from "node:fs";
import { aiScore, humanize } from "../../src/engine/humanize.ts";

const SEED = 20260905;
const INTENSITY = Number(process.env.MEASURE_INTENSITY || "0.9");
const PAIRS_FILE = process.env.MUT_PAIRS || "artifacts/mutator/pairs.json";

/**
 * 套话密度（诊断用，不参与门禁）——数 AI 高频套话词的命中次数。
 *
 * 用途：把「aiScore 为什么不动」归因到**套话**还是**句式**。
 * aiScore 的主成分是 formulaicHits（套话表），若套话密度涨而分数不涨，
 * 就说明分数被其它成分（句长/burstiness）拖回去了——这正是 heavyB 要验证的。
 */
const CLICHE =
  /值得注意的是|综上所述|与此同时|不仅|而且|具有重要意义|进一步地?|需要指出的是|赋能|闭环|底层逻辑|总而言之|由此可见|毋庸置疑|不言而喻|在[^，。]{1,8}的背景下|值得注意的是/g;
const clicheCount = (s: string) => (s.match(CLICHE) || []).length;

interface Pair {
  genre: string;
  level: string;
  run: number;
  human: string;
  variant: string;
  error?: string;
}

const data = JSON.parse(readFileSync(PAIRS_FILE, "utf8")) as {
  model: string;
  runs?: number[];
  levels?: string[];
  pairs: Pair[];
};
const pairs = data.pairs.filter((p) => p.variant);

interface Row {
  genre: string;
  level: string;
  run: number;
  humanScore: number;
  variantScore: number;
  delta: number;
  variantAfter: number;
  drop: number;
  humanAfter: number;
  humanSide: number;
  hFormulaic: number;
  vFormulaic: number;
  hStruct: number;
  vStruct: number;
  hCliche: number;
  vCliche: number;
}

const rows: Row[] = pairs.map((p) => {
  const h = aiScore(p.human);
  const v = aiScore(p.variant);
  const vAfter = aiScore(humanize(p.variant, { intensity: INTENSITY, seed: SEED }));
  const hAfter = aiScore(humanize(p.human, { intensity: INTENSITY, seed: SEED }));
  return {
    genre: p.genre,
    level: p.level,
    run: p.run,
    humanScore: h.score,
    variantScore: v.score,
    delta: v.score - h.score,
    variantAfter: vAfter.score,
    drop: v.score - vAfter.score,
    humanAfter: hAfter.score,
    humanSide: hAfter.score - h.score,
    hFormulaic: h.formulaicHits,
    vFormulaic: v.formulaicHits,
    hStruct: h.structureHits,
    vStruct: v.structureHits,
    hCliche: clicheCount(p.human),
    vCliche: clicheCount(p.variant),
  };
});

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const runs = data.runs?.length ?? 1;
const levels = data.levels ?? [...new Set(rows.map((r) => r.level))];
console.log(
  `模型=${data.model}｜去味参数 intensity=${INTENSITY} seed=${SEED}｜样本 ${rows.length} 对（${runs} 次采样/档）｜档位 ${levels.join("/")}\n`,
);
console.log(`数据文件：${PAIRS_FILE}\n`);

console.log("━━━ 真人文本基线（aiScore 绝对值）━━━");
const humanBase = new Map<string, number>();
for (const r of rows) if (!humanBase.has(r.genre)) humanBase.set(r.genre, r.humanScore);
for (const [g, s] of humanBase) console.log(`  ${g.padEnd(11)} ${String(s).padStart(3)}`);
const hv = [...humanBase.values()];
console.log(
  `  ⇒ 同为"人写"，跨度 ${Math.min(...hv)} ~ ${Math.max(...hv)}（${Math.max(...hv) - Math.min(...hv)} 分）——绝对值跨体裁不可比\n`,
);

console.log("━━━ Q1 区分力（按 体裁×档位 聚合）━━━");
console.log("体裁        档位    人写  AI化均值(极差)   Δ均值   方向正确");
console.log("─".repeat(74));
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.genre}|${r.level}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}
let m = 0;
let n = 0;
for (const [k, rs] of groups) {
  const [g, lv] = k.split("|");
  const vs = rs.map((r) => r.variantScore);
  const ds = rs.map((r) => r.delta);
  const okDir = ds.filter((d) => d > 0).length;
  m += okDir;
  n += ds.length;
  const dm = avg(ds);
  console.log(
    `${g.padEnd(11)} ${lv.padEnd(7)} ${String(rs[0].humanScore).padStart(3)}  ` +
      `${String(Math.round(avg(vs))).padStart(4)}(±${Math.max(...vs) - Math.min(...vs)})   ` +
      `${(dm >= 0 ? "+" : "") + dm.toFixed(1)}`.padStart(8) +
      `   ${okDir}/${ds.length}`,
  );
}
console.log(
  `\n  ⇒ 总方向正确率 ${m}/${n} = ${((m / n) * 100).toFixed(0)}%（AI 化后分数上升的比例）`,
);
const allDelta = rows.map((r) => r.delta);
console.log(
  `  ⇒ Δ 均值 ${avg(allDelta).toFixed(1)}｜范围 ${Math.min(...allDelta)} ~ ${Math.max(...allDelta)}`,
);

console.log("\n━━━ Q2 刻度单调（按档位声明顺序）与套话密度对照 ━━━");
for (const g of [...new Set(rows.map((r) => r.genre))]) {
  const present = levels.filter((lv) => groups.has(`${g}|${lv}`));
  if (present.length < 2) continue;
  const sc = present.map((lv) =>
    Math.round(avg(groups.get(`${g}|${lv}`)!.map((r) => r.variantScore))),
  );
  const cl = present.map((lv) => Math.round(avg(groups.get(`${g}|${lv}`)!.map((r) => r.vCliche))));
  // ⚠️ 只有 ≥3 档才谈"单调"：2 档时 `sc[2]` 是 undefined，比较恒为 false，
  //    会把"只有两个点"误报成"非单调"（heavyA/heavyB 拆因实验就是 2 档）。
  const mono = sc.length < 3 ? null : sc[0] <= sc[1] && sc[1] <= sc[2];
  const clMono = cl.length < 3 ? null : cl[0] <= cl[1] && cl[1] <= cl[2];
  const mark = mono === null ? "· " : mono ? "✅" : "⚠️";
  console.log(
    `  ${mark} ${g.padEnd(11)} 分数 ${sc.map((v) => String(v).padStart(4)).join(" →")}` +
      `   套话 ${cl.map((v) => String(v).padStart(3)).join("→")}` +
      (clMono === false ? "  ←套话非单调" : ""),
  );
  console.log(`     ${" ".repeat(11)} 档位 ${present.map((lv) => lv.padStart(6)).join(" →")}`);
}

console.log("\n━━━ Q3 去味有效性 & 负收益 ━━━");
const drops = rows.map((r) => r.drop);
const sides = rows.map((r) => r.humanSide);
console.log(
  `  AI 化稿去味降幅：均值 ${avg(drops).toFixed(1)}｜范围 ${Math.min(...drops)} ~ ${Math.max(...drops)}｜无效(≤0) ${drops.filter((d) => d <= 0).length}/${rows.length}`,
);
console.log(
  `  ⚠ 人写稿去味后分数变化：均值 ${avg(sides).toFixed(1)}｜范围 ${Math.min(...sides)} ~ ${Math.max(...sides)}`,
);
console.log(`  ⚠ 人写稿被"改差"的（分数上升）${sides.filter((s) => s > 0).length}/${rows.length}`);

console.log("\n━━━ 逐项成分（Δ 是哪个成分贡献的）━━━");
console.log("体裁        档位   套话(人→AI)  公式化命中(人→AI)  结构命中(人→AI)   Δ");
for (const [k, rs] of groups) {
  const [g, lv] = k.split("|");
  const dm = avg(rs.map((r) => r.delta));
  console.log(
    `${g.padEnd(11)} ${lv.padEnd(7)} ${String(rs[0].hCliche).padStart(4)}→${String(Math.round(avg(rs.map((r) => r.vCliche)))).padEnd(5)} ` +
      `${String(rs[0].hFormulaic).padStart(6)}→${String(Math.round(avg(rs.map((r) => r.vFormulaic)))).padEnd(5)} ` +
      `${String(rs[0].hStruct).padStart(6)}→${String(Math.round(avg(rs.map((r) => r.vStruct)))).padEnd(5)} ` +
      `${(dm >= 0 ? "+" : "") + dm.toFixed(1)}`,
  );
}
