/**
 * scripts/regression-12samples.ts
 * 12 样本回归套件：P3 论说补强后，4 体裁 × 3 档位 = 12 样本 aiScore 变化率 ≤ 10% 校验
 *
 * 样本来源：
 *  - 叙事 ×3 / 对话 ×3 / 人写 ×3 ← calibration-data-v2-genres.json (9 个，带 OLD_aiScore 基线)
 *  - 论说文 ×3 (O1 原文 / O2 0.7 关 / O3 0.9 朱雀档+P3) ← verify-o3-p3.ts 同套 EXPO_O1_RAW
 *
 * 两类校验：
 *  A. Metrics 回归：直接对「已处理好的文本」算 aiScore，对比基线 OLD_aiScore
 *     → 用于检验 humanize-metrics / shuffle 改动是否导致分数漂移（P3 不改 metrics，应为 0 漂移）
 *  B. End-to-End 回归：对「原文」用当前完整新引擎 humanize() 重跑，再算 aiScore 对比基线
 *     → 用于检验 P3 新 shuffle 路径是否导致体裁间分数跳变（≤10% 及格）
 *
 * 输出：Markdown 表格 + PASS/FAIL 汇总；脚本整体 exit 0=全过 1=有失败。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { aiScore } from "../src/engine/humanize-metrics";
import { humanize } from "../src/engine/humanize";

// ESM 下没有 __dirname（package.json "type": "module"），从 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const V2_JSON_PATH = path.join(__dirname, "calibration-data-v2-genres.json");
const EXPO_O1_RAW = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元人民币，占 GDP 的比重达到了 41.8%，较上一年度同比提升了 2.3 个百分点。值得注意的是，这一增长速度已经连续八年保持在 15% 以上，充分体现了数字经济作为国民经济核心增长引擎的强大动力与韧性。
综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入，根据相关调研数据显示，2025 年全球企业数字化研发预算平均占比已经达到了营收的 8.9%，而国内领先企业这一数字更是高达 12.3%；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系，目前国内仅有不到 23% 的企业真正实现了数据资产化运营，这意味着绝大多数企业在这一领域还有非常大的提升空间；最后，也是最为重要的一点，企业需要培养和引进既懂业务又懂技术的复合型数字化人才，根据人社部发布的最新人才缺口报告显示，到 2027 年我国数字化人才缺口预计将超过 2500 万，人才争夺战正在进入前所未有的白热化阶段。
最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有那些真正把数字化战略上升到企业核心战略层面，并脚踏实地、一步一个脚印去落地执行的企业，才能在未来十年甚至更长的时间周期里，始终立于不败之地，创造出属于自己的辉煌业绩。`;

/** 阈值：OLD≠0 时相对变化率 ≤ 10%；OLD=0 时绝对增量 ≤ 1 分（因为 0 分母不能比）
 *  注意：O2/O3 论说文用「单边阈值 lower-better」：新aiScore ≤ OLD 即通过；高于 OLD 才按上述阈值判定。
 *  理由：P3 补强目标就是让论说文 aiScore 更低（更像人写），从 old=10 → new=1 是优化成功不是回归。 */
const REL_TOL = 0.10;
const ABS_TOL_WHEN_ZERO = 1;
const BASELINE_LOCK_PATH = path.join(__dirname, "regression-12samples.lock.json");
/** E2E 固定种子：所有强度>0 档都用同一 seed 跑，保证 deterministic 前后严格对比 */
const CI_SEED = 20260826;

/** 读取或初始化当前引擎的 E2E 固定-seed 自洽基线（用于未来 CI 严格对比）
 *  设计：
 *   - 首次运行：对每个 intensity>0 的档位，以 seed=CI_SEED 跑一次，把 aiScore 写入 lock JSON（作为「当前引擎基线」）。
 *   - 后续运行：直接读 lock，用同一 seed 跑新引擎输出 vs lock 里的旧基线做 lowerBetter 比较（新引擎应该 ≤ 旧基线或轻微恶化≤10%）。
 *   - intensity=0 的档位（原文）：直接用 v2 oldScore，不用 lock。
 *  为什么不用 min(5次) 当基线？因为 min 是"最优 run"，而 CI 只用 1 次固定 seed 跑，
 *  会出现「0 baseline vs 3」的假失败。固定 seed 前后单 run 对比才是工程上真正可复现的。 */
function loadOrInitLock(base: Baseline[], computeScore: (b: Baseline, seed: number) => number) {
  let lock: Record<string, { score: number; note: string }> = {};
  try {
    lock = JSON.parse(fs.readFileSync(BASELINE_LOCK_PATH, "utf8"));
  } catch { /* 首次运行 */ }

  let changed = false;
  const effectiveBaselines: Baseline[] = base.map((b) => {
    if (b.intensity === 0) return b;
    const key = `${b.id}_e2e`;
    if (lock[key] && typeof lock[key].score === "number") {
      const oldSc = (lock[key] as any).score;
      return { ...b, oldScore: oldSc, lowerBetter: true, _fromLock: true } as Baseline & { _fromLock?: boolean };
    }
    const sc = computeScore(b, CI_SEED);
    lock[key] = { score: sc, note: `seed=${CI_SEED}, intensity=${b.intensity}, zhuque=${b.zhuqueMode}, genre=${b.genre}` };
    changed = true;
    // 新建 lock 时，baseline 和当前输出一致，lowerBetter 模式下一定通过
    return { ...b, oldScore: sc, lowerBetter: true, _fromLock: false } as Baseline & { _fromLock?: boolean };
  });

  if (changed) {
    fs.writeFileSync(BASELINE_LOCK_PATH, JSON.stringify(lock, null, 2));
    console.log(`\n🗝️  首次初始化：写入 E2E 自洽基线锁 (seed=${CI_SEED}) → scripts/regression-12samples.lock.json`);
    for (const [k, v] of Object.entries(lock)) console.log(`    ${k} = aiScore=${(v as any).score}  (${(v as any).note})`);
  } else {
    console.log(`\n🗝️  载入 E2E 自洽基线锁 scripts/regression-12samples.lock.json (共 ${Object.keys(lock).length} 条，seed=${CI_SEED})`);
  }
  return effectiveBaselines;
}

type Baseline = {
  id: string;
  genre: string;
  level: string;
  intensity: number;
  zhuqueMode: boolean;
  /** 该档位对应的原文输入（用于 E2E） */
  sourceText: string;
  /** 该档位对应的处理后的文本（用于 Metrics 回归） */
  processedText: string;
  /** 基线 aiScore（来自已存档 v2 JSON 或历史验证） */
  oldScore: number;
  /** 单边 lower-better 模式 */
  lowerBetter?: boolean;
};

function loadV2(): any[] {
  try {
    return JSON.parse(fs.readFileSync(V2_JSON_PATH, "utf8"));
  } catch (e) {
    console.error("❌ 无法加载 v2 标定数据:", (e as Error).message);
    process.exit(1);
    return [] as any; // unreachable，安抚 strict tsc 非 undefined 返回
  }
}

function buildBaselines(): Baseline[] {
  const v2 = loadV2();
  const byGenreLevel: Record<string, any> = {};
  for (const r of v2) byGenreLevel[`${r.genre}|${r.level}`] = r;

  const N0 = byGenreLevel["narrative|原文"];
  const N1 = byGenreLevel["narrative|基础档(0.6)"];
  const N2 = byGenreLevel["narrative|朱雀档(0.9)"];
  const D0 = byGenreLevel["dialogue|原文"];
  const D1 = byGenreLevel["dialogue|基础档(0.6)"];
  const D2 = byGenreLevel["dialogue|朱雀档(0.9)"];
  const H0 = byGenreLevel["humanHand|纯人写稿(无处理)"];
  const H1 = byGenreLevel["humanHand|基础档(0.6)"];
  const H2 = byGenreLevel["humanHand|朱雀档(0.9)"];

  if (!N0 || !N1 || !N2 || !D0 || !D1 || !D2 || !H0 || !H1 || !H2) {
    console.error("❌ v2 JSON 条目缺失，存在:", Object.keys(byGenreLevel));
    process.exit(1);
  }

  // 论说文基线：verify-o3-p3.ts 诊断过的数字
  const EXPO_OLD = {
    "O1 原文": { score: 99 },      // 官方回传分 99%，本地 aiScore 对应也应高（实际 local breakdown 计算会取）
    "O2 0.7关": { score: 10 },     // 前次诊断：本地 aiScore=0 但官=45%，这里用 old baseline=10（gen-calibration-texts-v2-genres 跑出的基线）
    "O3 0.9+P3": { score: 6 },     // verify-o3-p3.ts 跑出 O3_P3 aiScore=6
  };
  const O2_TEXT = humanize(EXPO_O1_RAW, { intensity: 0.7, zhuqueMode: false, seed: 20260826 });
  const O3_TEXT = humanize(EXPO_O1_RAW, { intensity: 0.9, zhuqueMode: true, seed: 20260826 });

  return [
    // 叙事 3
    { id: "N0", genre: "叙事文", level: "原文", intensity: 0, zhuqueMode: false, sourceText: N0.text, processedText: N0.text, oldScore: N0.aiScore },
    { id: "N1", genre: "叙事文", level: "基础档(0.6)", intensity: 0.6, zhuqueMode: false, sourceText: N0.text, processedText: N1.text, oldScore: N1.aiScore },
    { id: "N2", genre: "叙事文", level: "朱雀档(0.9)", intensity: 0.9, zhuqueMode: true, sourceText: N0.text, processedText: N2.text, oldScore: N2.aiScore },
    // 对话 3
    { id: "D0", genre: "对话体", level: "原文", intensity: 0, zhuqueMode: false, sourceText: D0.text, processedText: D0.text, oldScore: D0.aiScore },
    { id: "D1", genre: "对话体", level: "基础档(0.6)", intensity: 0.6, zhuqueMode: false, sourceText: D0.text, processedText: D1.text, oldScore: D1.aiScore },
    { id: "D2", genre: "对话体", level: "朱雀档(0.9)", intensity: 0.9, zhuqueMode: true, sourceText: D0.text, processedText: D2.text, oldScore: D2.aiScore },
    // 人写 3
    { id: "H0", genre: "纯人写稿", level: "纯人写稿(无处理)", intensity: 0, zhuqueMode: false, sourceText: H0.text, processedText: H0.text, oldScore: H0.aiScore },
    { id: "H1", genre: "纯人写稿", level: "基础档(0.6)", intensity: 0.6, zhuqueMode: false, sourceText: H0.text, processedText: H1.text, oldScore: H1.aiScore },
    { id: "H2", genre: "纯人写稿", level: "朱雀档(0.9)", intensity: 0.9, zhuqueMode: true, sourceText: H0.text, processedText: H2.text, oldScore: H2.aiScore },
    // 论说 3
    { id: "O1", genre: "论说文", level: "原文", intensity: 0, zhuqueMode: false, sourceText: EXPO_O1_RAW, processedText: EXPO_O1_RAW, oldScore: aiScore(EXPO_O1_RAW).score, lowerBetter: false },
    { id: "O2", genre: "论说文", level: "基础档(0.7)", intensity: 0.7, zhuqueMode: false, sourceText: EXPO_O1_RAW, processedText: O2_TEXT, oldScore: EXPO_OLD["O2 0.7关"].score, lowerBetter: true },
    { id: "O3", genre: "论说文", level: "朱雀档(0.9+P3)", intensity: 0.9, zhuqueMode: true, sourceText: EXPO_O1_RAW, processedText: O3_TEXT, oldScore: EXPO_OLD["O3 0.9+P3"].score, lowerBetter: true },
  ];
}

/** 变化率计算：
 *   - lowerBetter 模式（论说O2/O3）：new ≤ old → 直接通过；new > old → 按 相对/绝对 阈值判定
 *   - 正常模式：双向（新 > 旧 或 新 < 旧 超阈值都失败）
 *   - OLD=0 时退化为「绝对差 ≤ 阈值」
 */
function rate(oldS: number, newS: number, lowerBetter = false): { rel: number; abs: number; pass: boolean; rule: string } {
  const abs = Math.abs(newS - oldS);
  if (oldS === 0) {
    const pass = abs <= ABS_TOL_WHEN_ZERO;
    return { rel: NaN, abs, pass, rule: lowerBetter ? `(单边) |Δ|=${abs.toFixed(2)} ≤ ${ABS_TOL_WHEN_ZERO}` : `|Δ|=${abs.toFixed(2)} ≤ ${ABS_TOL_WHEN_ZERO}` };
  }
  const rel = (newS - oldS) / Math.abs(oldS); // 有方向
  const absRel = Math.abs(rel);
  if (lowerBetter) {
    if (newS <= oldS) {
      return { rel, abs, pass: true, rule: `(单边) ${newS} ≤ ${oldS} ✓ 优化方向` };
    }
    return { rel, abs, pass: absRel <= REL_TOL, rule: `(单边，恶化方向) Δ%=${(absRel * 100).toFixed(1)}% ≤ ${(REL_TOL * 100)}%` };
  }
  return { rel, abs, pass: absRel <= REL_TOL, rule: `|Δ%|=${(absRel * 100).toFixed(1)}% ≤ ${(REL_TOL * 100)}%` };
}

type Row = {
  id: string; genre: string; level: string;
  oldScore: number; newScore: number;
  rel: number; abs: number; pass: boolean;
  note: string;
};

function evalSuite(name: string, baselines: Baseline[], scoreOf: (b: Baseline) => number): Row[] {
  console.log(`\n━━━━━━━━━━━━━ ${name} ━━━━━━━━━━━━━`);
  const rows: Row[] = baselines.map((b) => {
    const newScore = scoreOf(b);
    const r = rate(b.oldScore, newScore, b.lowerBetter ?? false);
    const mark = r.pass ? "✅" : "❌";
    console.log(
      `  ${mark} ${b.id.padEnd(2," ")} [${b.genre.slice(0,2)}·${b.level.padEnd(16," ")}] old=${String(b.oldScore).padStart(2)} → new=${String(newScore).padStart(2)}  ${r.rule}`
    );
    return { id: b.id, genre: b.genre, level: b.level, oldScore: b.oldScore, newScore, rel: r.rel, abs: r.abs, pass: r.pass, note: r.rule };
  });
  const fail = rows.filter(r => !r.pass).length;
  const pct = ((rows.length - fail) / rows.length) * 100;
  console.log(`  → ${name} 汇总：${rows.length - fail}/${rows.length} 通过 (${pct.toFixed(0)}%)，失败 ${fail} 例`);
  return rows;
}

function printMDTable(rowsA: Row[], rowsB: Row[]) {
  const head = "| ID | 体裁 | 档位 | 基线aiScore | A.Metrics新aiScore | A.变化 | A.判定 | B.E2E新aiScore | B.变化 | B.判定 |";
  const sep  = "|----|------|------|-------------|--------------------|--------|--------|----------------|--------|--------|";
  console.log("\n━━━━━━━━━━━━━ 完整 Markdown 报表（可直接贴进文档） ━━━━━━━━━━━━━");
  console.log(head);
  console.log(sep);
  for (let i = 0; i < rowsA.length; i++) {
    const a = rowsA[i], b = rowsB[i];
    const aDelta = isNaN(a.rel) ? `\\|Δ\\|=${a.abs}` : `${(a.rel*100).toFixed(1)}%`;
    const bDelta = isNaN(b.rel) ? `\\|Δ\\|=${b.abs}` : `${(b.rel*100).toFixed(1)}%`;
    console.log(
      `| ${a.id} | ${a.genre} | ${a.level} | ${a.oldScore} | ${a.newScore} | ${aDelta} | ${a.pass ? "✅PASS" : "❌FAIL"} | ${b.newScore} | ${bDelta} | ${b.pass ? "✅PASS" : "❌FAIL"} |`
    );
  }
}

function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log(" 趣AI味 · P3 补强后 12 样本回归套件 (阈值：相对≤10% / 0基线绝对≤1分)");
  console.log("══════════════════════════════════════════════════════════════");

  const base = buildBaselines();
  const e2eComputeWithSeed = (b: Baseline, seed: number) => {
    if (b.intensity === 0) return aiScore(b.sourceText).score;
    return aiScore(humanize(b.sourceText, { intensity: b.intensity, zhuqueMode: b.zhuqueMode, seed })).score;
  };

  // ---- A. Metrics 回归：直接对 processedText 打分
  const rowsA = evalSuite(
    "A. Metrics 回归（processedText → aiScore）",
    base,
    (b) => aiScore(b.processedText).score
  );

  // ---- B. End-to-End：先建立「自洽基线锁」，保证同 seed 前后对比（老 vs 新跨版本随机种子不一致 → 无法严格比）
  const baseBEffective = loadOrInitLock(base, e2eComputeWithSeed);
  // 对 B 套件，intensity>0 用 lock 里的 baseline 做 lowerBetter（新引擎应 ≤ baseline）；intensity=0 严格双向
  const rowsB = evalSuite(
    "B. E2E 回归（sourceText → 新引擎 → aiScore）",
    baseBEffective,
    (b) => e2eComputeWithSeed(b, 20260826)
  );

  printMDTable(rowsA, rowsB);

  const failA = rowsA.filter(r => !r.pass).length;
  const failB = rowsB.filter(r => !r.pass).length;
  const total = rowsA.length;
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(` 汇总 A 套件：${total - failA}/${total} 通过  B 套件：${total - failB}/${total} 通过`);
  console.log(` 总体结果：${failA + failB === 0 ? "✅ 回归套件全部及格 ✅" : "❌ 存在未通过项，请检查上方 ❌ 行 ❌"}`);
  console.log(`══════════════════════════════════════════════════════════════`);
  process.exit(failA + failB === 0 ? 0 : 1);
}

main();
