/** v0.6.1 常驻通道端到端冒烟：预置配置直接跑真实网关（临时脚本） */
import { DEFAULT_API, effectiveKeys, humanizeViaApi, judgeWithCritique } from "../src/api/llm.ts";
// node 无同源代理：测试时把预置的相对路径替换为网关直连（与浏览器经代理转发等价）
DEFAULT_API.baseUrl = "https://token.sensenova.cn/v1";

console.log("预置 Key 池:", effectiveKeys(DEFAULT_API).length, "个");
console.log("默认配置:", DEFAULT_API.enabled ? "常驻启用" : "关闭", "|", DEFAULT_API.baseUrl, "|", DEFAULT_API.model, "| 评判:", DEFAULT_API.judgeModel, "| 备选:", DEFAULT_API.altModel);

const sample = `值得注意的是，随着人工智能技术的快速发展，AI写作工具应运而生。综上所述，人工智能技术至关重要，它不仅极大地提升了内容生产的效率，而且有效地降低了创作门槛。然而，传统的写作方式仍然发挥着不可替代的作用。因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的输出。`;

console.log("\n--- 单轮 LLM 去味（deepseek-v4-flash，走预置 Key 池）---");
const t0 = Date.now();
try {
  const out = await humanizeViaApi(sample, DEFAULT_API, 0.7);
  console.log(`✅ ${((Date.now() - t0) / 1000).toFixed(1)}s\n${out}`);
} catch (e) {
  console.log("❌", e?.message || e);
  process.exit(1);
}

console.log("\n--- 交叉评判（glm-5.2）---");
try {
  const r = await judgeWithCritique(await humanizeViaApi(sample, DEFAULT_API, 0.7), DEFAULT_API);
  console.log("评分:", r.score, "| 痕迹:", r.critique.slice(0, 3).join("；") || "无");
} catch (e) {
  console.log("❌", e?.message || e);
}
