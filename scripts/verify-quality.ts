/**
 * 质量校验：确保「……」占位已消除、黑话本体不再作为替身泄漏。
 * 用法：node --experimental-strip-types src/engine/verify-quality.ts（或 npx tsx ...）
 * 任一硬性校验失败即非零退出（CI 可感知）。
 *
 * v0.8.6 自校验：核心校验逻辑抽为 runQualityChecks 导出，被
 * scripts/verify-quality.test.ts 直接断言——门禁自身失效时 vitest 会亮红，
 * 而不是让所有"通过"信号静默失真。
 */
import { humanize } from "../src/engine/humanize.ts";
import { VOCAB } from "../src/engine/humanize-vocab.ts";
declare const process: { exit(code?: number): never };

export const LEAK_WORDS = [
  "赋能",
  "基于",
  "诸如",
  "闭环",
  "生态",
  "护城河",
  "飞轮",
  "对齐",
  "心智",
  "沉淀",
  "反哺",
  "在……背景下",
];

const text =
  "值得注意的是，基于大数据，技术赋能传统产业已成为趋势。诸如电商、物流等赛道，" +
  "我们要构建生态闭环，打造护城河，让飞轮转起来。团队需对齐心智，沉淀经验，反哺业务，" +
  "在高质量发展的背景下稳步推进。";

/** 单次扫描：返回 {省略号残留, 黑话泄漏次数} */
export function scanOutput(out: string): { ellipsis: boolean; leak: number } {
  let leak = 0;
  for (const w of LEAK_WORDS) if (out.includes(w)) leak++;
  return { ellipsis: out.includes("……"), leak };
}

/* ---------------------------------------------------------------------------
 * 词表配对卫生（2026-10-05 新增）
 *
 * 起因：CLI 端到端实跑抓到真缺陷——「统筹」→「一盘棋」。源词是动词、
 * 替身是名词，接宾语即崩：「统筹好效率」→「一盘棋好效率」。
 * 而当时的两道门禁都抓不到：
 *   - verify-quality 只查 LEAK_WORDS 这 12 个**指定黑话词**，不查语法；
 *   - scan-bugs 的 v7/v8/金丝雀探针全是**针对已知 bug 的定点回归**，
 *     语料里根本没有「统筹」这类词，改词表不会惊动它们。
 *
 * 所以这里加的是**结构性扫描**：不看具体词条，而是对整张 VOCAB 做
 * 「源词 + 替身接宾语后是否仍成立」的实跑判定。任何一条命中即失败。
 * 这类检查的价值在于——下次有人再加一个名词性替身，它会当场红。
 * ------------------------------------------------------------------------- */

/** 不能直接接宾语的替身特征词：名词性 / 副词性短语。
 *  判据是「作为动词的宾语或定语时读不通」，与具体词条无关。 */
export const UNGRAMMATICAL_AS_VERB = [
  "一盘棋", // 名词：「统筹好」→「一盘棋好」
  "通盘", // 副词：「全方位推进」→「通盘推进」
  "成体系", // 动词短语：「系统性的改革」→「成体系的改革」
  "抓手",
  "格局",
  "机制",
];

/** 探针语料：源词 + 能在真实语境里带出宾语的句式 */
function grammarProbe(from: string): string {
  return `我们需要${from}好效率与深度的关系。`;
}

/** 跑一个候选替换，判定输出是否仍是通顺中文。
 *  判据刻意保守：只在**替换确实发生**且**产出仍是名词/副词接宾语**时判失败，
 *  宁可漏过也不误伤——门禁误报会让整套 check:release 失去可信度。
 *
 *  v0.9.24：改为 export 供测试直接断言。
 *  之前它只被 scanVocabGrammar 内部调用，而真实词表里**一个崩的组合都没有**
 *  （scanVocabGrammar 实跑恒返回 []），于是「检出问题」这半边从未被执行过——
 *  门禁自己失效时没有 vitest 会亮红。导出后可以直接喂已知会崩的串来验证判据。 */
export function isGrammaticallyBroken(from: string, out: string): string | null {
  if (out === grammarProbe(from)) return null; // 没替换，天然无问题
  for (const bad of UNGRAMMATICAL_AS_VERB) {
    // 替身出现 + 紧跟「好/推进/建设」这类宾语标记 ⇒ 主谓不搭
    const re = new RegExp(bad + "(好|推进|建设|落实|开展)");
    if (re.test(out)) return bad;
  }
  return null;
}

/** 全表扫描：返回所有触发「接宾语即崩」的词条。 */
export function scanVocabGrammar(): { from: string; bad: string }[] {
  const hits: { from: string; bad: string }[] = [];
  const seen = new Set<string>();
  for (const from of Object.keys(VOCAB)) {
    if (seen.has(from)) continue;
    seen.add(from);
    const probe = grammarProbe(from);
    // 广撒网：40 个种子足以让每个候选替身都至少被抽中一次（词池通常 ≤4）
    for (let seed = 0; seed < 40; seed++) {
      const bad = isGrammaticallyBroken(from, humanize(probe, { intensity: 1.0, seed }));
      if (bad) {
        hits.push({ from, bad });
        break;
      }
    }
  }
  return hits;
}

/** 完整校验（25 种子 × 双强度）。供脚本 main 与测试共用。 */
export function runQualityChecks() {
  // 强度 1.0：p=1.0 应 100% 替换，且因已删除「替身=原词」无效项，输出须零泄漏、零字面省略号
  let hardEllipsis = false;
  let hardLeak = 0;
  for (let seed = 0; seed < 25; seed++) {
    const s = scanOutput(humanize(text, { intensity: 1.0, seed }));
    if (s.ellipsis) hardEllipsis = true;
    hardLeak += s.leak;
  }

  // 强度 0.7：按设计约 13% 套话保留，仅作信息统计
  let softLeak = 0;
  for (let seed = 0; seed < 25; seed++) {
    softLeak += scanOutput(humanize(text, { intensity: 0.7, seed })).leak;
  }

  return { hardEllipsis, hardLeak, softLeak };
}

/* ----------------------------- CLI 入口 ----------------------------- */

const r = runQualityChecks();
const { hardEllipsis, hardLeak, softLeak } = r;

console.log("[强度1.0] 含字面省略号(……):", hardEllipsis ? "❌ 有" : "✅ 无");
console.log(
  "[强度1.0] 黑话本体泄漏:",
  hardLeak === 0 ? "✅ 0（无效替身已清除）" : `❌ ${hardLeak}`,
);
console.log(`[强度0.7] 黑话保留 ${softLeak} 次（按设计，强度<1 故意不全改）`);

// 词表配对卫生：接宾语即崩的源词→替身组合（2026-10-05 新增）
const grammarHits = scanVocabGrammar();
console.log(
  "[词表卫生] 接宾语即崩的替换:",
  grammarHits.length === 0
    ? "✅ 0（全表扫描未发现名词/副词性替身顶替动词）"
    : `❌ ${grammarHits.map((h) => `${h.from}→${h.bad}`).join("，")}`,
);

console.log("\n示例输出(强度0.7, seed=3):\n" + humanize(text, { intensity: 0.7, seed: 3 }));

// 硬性校验：强度 1.0 必须零泄漏、零字面省略号，且词表配对不得崩
const hardFails =
  (hardEllipsis ? 1 : 0) + (hardLeak === 0 ? 0 : 1) + (grammarHits.length > 0 ? 1 : 0);
if (hardFails > 0) {
  console.error(
    `\n❌ 质量校验失败：省略号残留=${hardEllipsis}，黑话泄漏=${hardLeak} 次，` +
      `词表配对崩=${grammarHits.length} 组`,
  );
  process.exit(1);
}
console.log("\n✅ 质量校验通过（强度1.0 零泄漏、零省略号、词表配对全通）");
