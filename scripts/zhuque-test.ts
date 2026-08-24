/**
 * 朱雀检测测试：去味前 → 去味后 → 朱雀真实分对比
 * 前置：在腾讯云 EdgeOne 控制台创建 AI 网关，拿到网关域名 + API Key
 * 用法：
 *   $env:ZHUQUE_GATEWAY = "https://xxx.edgeone.app"
 *   $env:ZHUQUE_API_KEY = "your-key"
 *   npx tsx scripts/zhuque-test.ts
 */
declare const process: { env: Record<string, string | undefined>; exit(code?: number): never };

import { humanize, aiScore } from "../src/engine/humanize.ts";

const GATEWAY = process.env.ZHUQUE_GATEWAY || "";
const API_KEY = process.env.ZHUQUE_API_KEY || "";

if (!GATEWAY || !API_KEY) {
  console.error("❌ 需要设置 ZHUQUE_GATEWAY 和 ZHUQUE_API_KEY 环境变量");
  console.error("   PowerShell:");
  console.error('   $env:ZHUQUE_GATEWAY = "https://xxx.edgeone.app"');
  console.error('   $env:ZHUQUE_API_KEY = "your-key"');
  process.exit(1);
}

const ZHUQUE_URL = GATEWAY.replace(/\/+$/, "") + "/v1/providers/zhuque-text/classify";

/** 调朱雀检测 API，返回 AI 概率（0-100，越高越像 AI） */
async function zhuqueDetect(text: string): Promise<{
  score: number;
  ratio: number;
  segments: { text: string; label: number; conf: number }[];
}> {
  const resp = await fetch(ZHUQUE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ text, is_merge: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`朱雀 API 返回 ${resp.status}`);
  const data = await resp.json();
  if (data.status !== "success") throw new Error(`朱雀检测失败：${data.msg || "未知错误"}`);
  return {
    score: Math.round((data.softmax_confidence ?? 0) * 100),
    ratio: data.ratio_confidence ?? 0,
    segments: (data.segment_labels || []).map((s: { text: string; label: number; conf: number }) => ({
      text: s.text,
      label: s.label,
      conf: s.conf,
    })),
  };
}

const LABEL_MAP: Record<number, string> = { 0: "人写", 1: "AI", 2: "疑似AI" };

const SAMPLE = `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。
综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。
然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。
从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。
因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的发展。`;

async function main() {
  console.log("=".repeat(80));
  console.log("  朱雀检测对比测试");
  console.log(`  网关：${GATEWAY}`);
  console.log("=".repeat(80));

  // 1. 原文送检
  console.log("\n── 1. 原文（AI 稿）送朱雀检测 ──");
  const localBefore = aiScore(SAMPLE);
  console.log(`  本地代理分：${localBefore.score}`);
  const t0 = Date.now();
  const zhuqueBefore = await zhuqueDetect(SAMPLE);
  console.log(`  朱雀真实分：${zhuqueBefore.score}（AI 占比 ${zhuqueBefore.ratio}）`);
  console.log(`  耗时：${Date.now() - t0}ms`);
  zhuqueBefore.segments.slice(0, 3).forEach((s) => {
    console.log(`    [${LABEL_MAP[s.label] || s.label} conf=${s.conf.toFixed(2)}] ${s.text.slice(0, 50)}…`);
  });

  // 2. 本地引擎去味后送检
  console.log("\n── 2. 本地引擎去味（强度 0.9）后送朱雀检测 ──");
  const humanized = humanize(SAMPLE, { intensity: 0.9, seed: 42, zhuqueMode: true });
  const localAfter = aiScore(humanized);
  console.log(`  本地代理分：${localBefore.score} → ${localAfter.score}（降 ${localBefore.score - localAfter.score}）`);
  const t1 = Date.now();
  const zhuqueAfter = await zhuqueDetect(humanized);
  console.log(`  朱雀真实分：${zhuqueBefore.score} → ${zhuqueAfter.score}（降 ${zhuqueBefore.score - zhuqueAfter.score}）`);
  console.log(`  AI 占比：${zhuqueBefore.ratio} → ${zhuqueAfter.ratio}`);
  console.log(`  耗时：${Date.now() - t1}ms`);
  zhuqueAfter.segments.slice(0, 5).forEach((s) => {
    console.log(`    [${LABEL_MAP[s.label] || s.label} conf=${s.conf.toFixed(2)}] ${s.text.slice(0, 50)}…`);
  });

  console.log("\n  去味后文本预览：");
  console.log("  " + humanized.slice(0, 300) + "…");

  // 3. 汇总
  console.log("\n" + "=".repeat(80));
  console.log("  汇总");
  console.log("=".repeat(80));
  console.log(`  本地代理分：${localBefore.score} → ${localAfter.score}（降 ${localBefore.score - localAfter.score}）`);
  console.log(`  朱雀真实分：${zhuqueBefore.score} → ${zhuqueAfter.score}（降 ${zhuqueBefore.score - zhuqueAfter.score}）`);
  const passed = zhuqueAfter.score < 30;
  console.log(`  朱雀判定：${passed ? "✅ 像人写（<30 分）" : "❌ 仍判为 AI（≥30 分）"}`);
}

main().catch((e) => console.error("Fatal:", e));