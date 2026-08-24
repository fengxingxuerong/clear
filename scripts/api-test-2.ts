/**
 * 快速补跑：忠实度 + runHumanize 统一分发
 */
declare const process: { env: Record<string, string | undefined>; exit(code?: number): never };
import { humanizeViaApi, runHumanize, type ApiConfig } from "../src/api/llm.ts";
import { checkFidelityLocal, crossChunkCleanup } from "../src/engine/humanize.ts";

const API_KEY = process.env.HUMANIZER_API_KEY || process.env.SHANGTANG_API_KEY || "";
const BASE_URL = "https://token.sensenova.cn/v1";
const MODEL = "deepseek-v4-flash";
const cfg: ApiConfig = { enabled: true, baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL, temperature: 0.9, deepMode: false, judgeModel: "", altModel: "", style: "casual" };

const SAMPLE_NUM = `据统计，2025年中国数字经济规模达到56万亿元，占GDP比重42%。值得注意的是，这一数字较2020年增长了23%。与此同时，人工智能产业的年复合增长率达到35.7%。因此，我们需要在技术创新与风险管控之间找到平衡。`;
const SAMPLE = `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的发展。`;

async function main() {
  // Step 4: 忠实度
  console.log("── 4. 忠实度校验（含数字文本经 LLM 改写后）──");
  try {
    const t0 = Date.now();
    const llmText = await humanizeViaApi(SAMPLE_NUM, cfg, 0.7);
    const cleaned = crossChunkCleanup(llmText);
    const fid = checkFidelityLocal(SAMPLE_NUM, cleaned);
    console.log(`✅ LLM 改写 + 忠实度校验（${Date.now() - t0}ms）`);
    console.log(`  忠实度：${fid.pass ? "✅ 通过（数字/术语完整）" : "❌ " + fid.problems.join("；")}`);
    console.log(`  改写预览：${cleaned.slice(0, 250)}…`);
  } catch (e: unknown) {
    console.log(`❌ 忠实度测试失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // Step 5: runHumanize
  console.log("\n── 5. runHumanize 统一分发入口 ──");
  try {
    const t1 = Date.now();
    const r = await runHumanize(SAMPLE, 0.7, cfg, undefined, false);
    const dt = Date.now() - t1;
    console.log(`✅ runHumanize 完成（${dt}ms）`);
    console.log(`  使用 API：${r.usedApi ? "是" : "否（回退本地引擎）"}`);
    console.log(`  评分：${r.before.score} → ${r.after.score}（降 ${r.before.score - r.after.score}）`);
    if (r.note) console.log(`  备注：${r.note}`);
    console.log(`  文本预览：${r.text.slice(0, 250)}…`);
  } catch (e: unknown) {
    console.log(`❌ runHumanize 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
main();