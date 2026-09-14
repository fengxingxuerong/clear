/**
 * 趣AI味 · API 功能测试（真实 LLM 通道）
 * 测试：单轮 LLM 改写 → 深度去味闭环 → LLM 评判 → 跨块清理 → 忠实度校验
 * 用法：npx tsx scripts/api-test.ts
 * 前置：$env:HUMANIZER_API_KEY = "sk-xxx"
 */
declare const process: { env: Record<string, string | undefined>; exit(code?: number): never };
import { loadPresetKeys } from "../src/api/llm-config.ts";
import {
  humanizeViaApi,
  humanizeViaApiDeep,
  judgeScoreStable,
  runHumanize,
  type ApiConfig,
  DEEP_TARGET_SCORE,
  DEEP_MAX_ROUNDS,
} from "../src/api/llm.ts";
import { aiScore, fingerprintCheck, checkFidelityLocal, crossChunkCleanup } from "../src/engine/humanize.ts";

// —— API 配置（从环境变量读取，不硬编码到代码） ——
// 运行前设置：$env:HUMANIZER_API_KEY = "sk-xxx"
const API_KEY = process.env.HUMANIZER_API_KEY || process.env.SHANGTANG_API_KEY || loadPresetKeys()[0] || "";
if (!API_KEY) {
  console.error("❌ 未找到 API Key（需要 HUMANIZER_API_KEY 环境变量）");
  console.error("   PowerShell: $env:HUMANIZER_API_KEY = 'sk-xxx'");
  process.exit(1);
}
const BASE_URL = process.env.HUMANIZER_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://token.sensenova.cn/v1";
const MODEL = "deepseek-v4-flash";

const cfg: ApiConfig = {
  enabled: true,
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  model: MODEL,
  temperature: 0.9,
  deepMode: true,
  judgeModel: "",
  altModel: "",
  style: "casual",
};

// —— 测试文本 ——
const SAMPLE = `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。
综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。
然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。
从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。
因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的发展。`;

const SAMPLE_WITH_NUMBERS = `据统计，2025年中国数字经济规模达到56万亿元，占GDP比重42%。
值得注意的是，这一数字较2020年增长了23%。与此同时，人工智能产业的年复合增长率达到35.7%。
因此，我们需要在技术创新与风险管控之间找到平衡。`;

async function main() {
  console.log("=".repeat(80));
  console.log("  趣AI味 · API 功能测试（真实 LLM 通道）");
  console.log(`  模型：${MODEL} · 网关：${BASE_URL}`);
  console.log("=".repeat(80));

  // ---- 1. 基础连通性测试 ----
  console.log("\n── 1. 基础连通性测试（单轮 LLM 改写）──");
  const before = aiScore(SAMPLE);
  console.log(`原文 AI 味评分：${before.score}（套话 ${before.formulaicHits}）`);

  const t0 = Date.now();
  try {
    const llmText = await humanizeViaApi(SAMPLE, cfg, 0.7);
    const dt = Date.now() - t0;
    const cleaned = crossChunkCleanup(llmText);
    const after = aiScore(cleaned);
    console.log(`✅ LLM 单轮改写成功（${dt}ms）`);
    console.log(`  改写后评分：${before.score} → ${after.score}（降 ${before.score - after.score}）`);
    console.log(`  改写预览：${cleaned.slice(0, 200)}…`);

    // 指纹 + 忠实度
    const fp = fingerprintCheck(cleaned);
    console.log(`  指纹体检：${fp.pass ? "✅ 通过" : `${fp.issues.length} 项残留`}`);
    if (!fp.pass) fp.issues.forEach((i) => console.log(`    · ${i.name} ×${i.count}`));
  } catch (e: unknown) {
    const dt = Date.now() - t0;
    console.log(`❌ 单轮改写失败（${dt}ms）：${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // ---- 2. LLM 评判测试 ----
  console.log("\n── 2. LLM 评判测试（用 LLM 当检测员打分）──");
  try {
    const llmText = await humanizeViaApi(SAMPLE, cfg, 0.7);
    const cleaned = crossChunkCleanup(llmText);
    const t1 = Date.now();
    const judge = await judgeScoreStable(cleaned, cfg);
    const dt = Date.now() - t1;
    console.log(`✅ LLM 评判成功（${dt}ms）`);
    console.log(`  LLM 评判分：${judge.score}（0=纯人写，100=纯AI）`);
    if (judge.critique.length > 0) {
      console.log(`  残留痕迹：${judge.critique.join("；")}`);
    }
  } catch (e: unknown) {
    console.log(`❌ LLM 评判失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- 3. 深度去味闭环测试 ----
  console.log("\n── 3. 深度去味闭环（改写→评分→未达标自动再改写）──");
  console.log(`  目标：≤${DEEP_TARGET_SCORE} 分 · 最多 ${DEEP_MAX_ROUNDS} 轮`);
  try {
    const t2 = Date.now();
    const deep = await humanizeViaApiDeep(
      SAMPLE,
      cfg,
      (round, score, stage) => {
        console.log(`  第 ${round} 轮：${stage ?? ""}评分 ${score ?? "失败"}${score !== null && score <= DEEP_TARGET_SCORE ? " ✅达标" : ""}`);
      },
      DEEP_TARGET_SCORE,
      3, // 收敛到 3 轮控制总时长
      0.7,
    );
    const dt = Date.now() - t2;
    console.log(`✅ 深度去味完成（${dt}ms，${dt / 1000}s）`);
    console.log(`  达标：${deep.hitTarget ? "✅ 是" : "❌ 否"}`);
    console.log(`  各轮评分：${deep.roundScores.map((s) => (s < 0 ? "失败" : s)).join(" → ")}`);
    if (deep.note) console.log(`  备注：${deep.note}`);
    console.log(`  最终文本预览：${deep.text.slice(0, 200)}…`);

    const finalScore = aiScore(deep.text);
    const fp = fingerprintCheck(deep.text);
    console.log(`  本地代理分：${finalScore.score}（套话 ${finalScore.formulaicHits}）`);
    console.log(`  指纹体检：${fp.pass ? "✅ 通过" : `${fp.issues.length} 项`}`);
  } catch (e: unknown) {
    console.log(`❌ 深度去味失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- 4. 忠实度校验（数字文本）----
  console.log("\n── 4. 忠实度校验（含数字文本经 LLM 改写后）──");
  try {
    const llmText = await humanizeViaApi(SAMPLE_WITH_NUMBERS, cfg, 0.7);
    const cleaned = crossChunkCleanup(llmText);
    const fid = checkFidelityLocal(SAMPLE_WITH_NUMBERS, cleaned);
    console.log(`✅ 忠实度校验：${fid.pass ? "通过" : "❌ 有问题"}`);
    if (!fid.pass) fid.problems.forEach((p) => console.log(`    · ${p}`));
    console.log(`  改写预览：${cleaned.slice(0, 200)}…`);
  } catch (e: unknown) {
    console.log(`❌ 忠实度测试失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- 5. 统一分发入口（runHumanize）----
  console.log("\n── 5. 统一分发入口 runHumanize（API 优先，失败回退本地引擎）──");
  try {
    const t3 = Date.now();
    const r = await runHumanize(SAMPLE, 0.7, cfg, (round, score, stage) => {
      console.log(`  进度：${stage ?? ""}第 ${round} 轮，评分 ${score ?? "失败"}`);
    }, false);
    const dt = Date.now() - t3;
    console.log(`✅ runHumanize 完成（${dt}ms）`);
    console.log(`  使用 API：${r.usedApi ? "是" : "否（回退本地引擎）"}`);
    console.log(`  评分：${r.before.score} → ${r.after.score}（降 ${r.before.score - r.after.score}）`);
    if (r.note) console.log(`  备注：${r.note}`);
    console.log(`  最终文本预览：${r.text.slice(0, 200)}…`);
  } catch (e: unknown) {
    console.log(`❌ runHumanize 失败：${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\n" + "=".repeat(80));
  console.log("  API 功能测试完成");
  console.log("=".repeat(80));
}

main().catch((e) => console.error("Fatal:", e));