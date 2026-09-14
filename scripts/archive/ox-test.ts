declare const process: { env: Record<string, string | undefined> };
import { humanizeViaApi, judgeScoreStable, type ApiConfig } from "../src/api/llm.ts";
import { aiScore, fingerprintCheck, crossChunkCleanup } from "../src/engine/humanize.ts";

const cfg: ApiConfig = {
  enabled: true,
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY || process.env.HUMANIZER_API_KEY || "",
  model: "stealth/ox-alpha",
  temperature: 0.9,
  deepMode: false,
  judgeModel: "",
  altModel: "",
  style: "casual",
  reasoningEffort: "max",
};

const SAMPLE = `值得注意的是，随着人工智能技术的快速发展，AI写作工具应运而生。
综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。
然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。
从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。`;

async function main() {
  const before = aiScore(SAMPLE);
  console.log(`原文分: ${before.score}（套话 ${before.formulaicHits}）`);

  const t0 = Date.now();
  const raw = await humanizeViaApi(SAMPLE, cfg, 0.7);
  const cleaned = crossChunkCleanup(raw);
  const after = aiScore(cleaned);
  console.log(`\n改写: ${Date.now() - t0}ms · ${before.score} → ${after.score}（降 ${before.score - after.score}）`);
  console.log(`预览: ${cleaned.slice(0, 300)}`);
  const fp = fingerprintCheck(cleaned);
  console.log(`指纹: ${fp.pass ? "✅ 通过" : fp.issues.length + " 项"}`);

  const t1 = Date.now();
  const judge = await judgeScoreStable(cleaned, cfg);
  console.log(`\nLLM 评判: ${Date.now() - t1}ms · ${judge.score} 分`);
  if (judge.critique.length) console.log(`残留痕迹: ${judge.critique.join("；")}`);
}
main().catch((e) => console.error("ERROR:", e));