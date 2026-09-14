/**
 * SenseNova 网关实测：3 Key × 5 模型连通性 + 去味效果冒烟（纯 JS，临时脚本）
 */
const BASE = "https://token.sensenova.cn/v1/chat/completions";
const KEYS = [
  "***REMOVED***",
  "***REMOVED***",
  "***REMOVED***",
];
const MODELS = ["deepseek-v4-flash", "sensenova-6.8-flash-lite", "deepseek-v4-pro", "glm-5.2", "kimi-k3"];

async function chat(key, model, prompt, maxTokens = 800) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.9,
      }),
    });
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, ms, text: "", err: `HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 80)}` };
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) return { ok: false, ms, text: "", err: `空 content（finish=${j?.choices?.[0]?.finish_reason}）` };
    return { ok: true, ms, text: content };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, text: "", err: String(e?.message || e).slice(0, 120) };
  }
}

console.log("===== 连通性（Key1 测 5 模型，挂了换 Key2 复测） =====");
const alive = new Set();
for (const m of MODELS) {
  const r = await chat(KEYS[0], m, "回复两个字：收到", 100);
  if (r.ok) { alive.add(m); console.log(`✅ ${m}: ${r.ms}ms "${r.text.slice(0, 20)}"`); }
  else {
    const r2 = await chat(KEYS[1], m, "回复两个字：收到", 100);
    if (r2.ok) { alive.add(m); console.log(`✅ ${m}: Key1 挂(${r.err})，Key2 可用 ${r2.ms}ms`); }
    else console.log(`❌ ${m}: ${r.err} | Key2 也不行: ${r2.err}`);
  }
}

const probeModel = alive.has("deepseek-v4-flash") ? "deepseek-v4-flash" : [...alive][0];
console.log(`\n===== 3 Key 验证（模型 ${probeModel}） =====`);
for (let i = 0; i < KEYS.length; i++) {
  const r = await chat(KEYS[i], probeModel, "回复两个字：收到", 100);
  console.log(r.ok ? `✅ Key${i + 1}: ${r.ms}ms` : `❌ Key${i + 1}: ${r.err}`);
}

const SAMPLE = `值得注意的是，随着人工智能技术的快速发展，AI写作工具应运而生。综上所述，人工智能技术至关重要，它不仅极大地提升了内容生产的效率，而且有效地降低了创作门槛。然而，传统的写作方式仍然发挥着不可替代的作用。因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的输出。`;
const HUMANIZE_PROMPT = `把下面这段AI味很重的中文改写得更像人写的。要求：1.删掉"值得注意的是/综上所述/然而/因此"这类套话引导词或换成口语说法；2.句长要有长有短，别每句都差不多长；3.词汇换口语（极大地→大幅/一下子，至关重要→很关键）；4.数字、专名、事实原样保留；5.不改变原意，不增删内容。只输出改写结果，不要解释。\n\n${SAMPLE}`;

console.log("\n===== 去味冒烟（活模型前 3 个） =====");
const tested = [...alive].slice(0, 3);
for (const m of tested) {
  const r = await chat(KEYS[0], m, HUMANIZE_PROMPT);
  if (r.ok) console.log(`\n--- ${m} (${r.ms}ms) ---\n${r.text.slice(0, 220)}`);
  else console.log(`\n--- ${m} 失败: ${r.err}`);
}
