/**
 * 趣AI味 · OpenAI 兼容底层对话调用（超时/重试/错误归一）
 */

import { ApiConfig, effectiveKeys } from "./llm-config";

/* ----------------------------- 底层调用 ----------------------------- */

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export async function chat(
  cfg: ApiConfig,
  messages: ChatMessage[],
  opts: { temperature: number; maxTokens: number; model?: string },
): Promise<{ content: string; reasoning: string }> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  // Key 池：429/401/403 先换下一个 Key 立即重试（Key 轮换），池耗尽或网络瞬断
  // 再走指数退避（深度模式一轮发多次请求，网关限流常见）
  const keys = effectiveKeys(cfg);
  if (keys.length === 0) throw new Error("未配置 API Key");
  let keyIdx = 0;
  const backoffs = [2000, 5000, 12000];
  // OpenRouter 网关推荐带上 HTTP-Referer 和 X-Title（用于排名，不带也能用但更稳）
  const isOpenRouter = /openrouter\.ai/i.test(cfg.baseUrl);
  const model = opts.model || cfg.model;
  // kimi-k3 网关限制 temperature 只能为 1（实测 400 报错）
  const temperature = /kimi/i.test(model) ? 1 : opts.temperature;
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(90_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keys[keyIdx]}`,
          ...(isOpenRouter ? { "HTTP-Referer": "https://github.com/quaiwei", "X-Title": "QuAiWei" } : {}),
        },
        body: JSON.stringify({
          model,
          temperature,
          // 思考型模型的 reasoning 要吃掉不少 token，不设 max_tokens 时
          // 网关默认预算常被思考烧光，content 返回空串。Ox Alpha 支持 131K 输出，
          // 这里给足预算（16000 ≈ 8000 字中文，改写绰绰有余 + 推理空间）
          max_tokens: opts.maxTokens,
          messages,
          // 推理强度（仅推理模型支持）：OpenRouter 通过 reasoning.effort 传入
          ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
        }),
      });
    } catch (e: unknown) {
      // 网络瞬断也走退避重试
      if (attempt < backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
      throw e;
    }
    // 限流/鉴权失败：优先换 Key（立即，不等待）；池耗尽再退避等待，
    // 退避后从第一个 Key 重新试（限流窗口恢复后第一个 Key 往往最有效）
    if ((resp.status === 429 || resp.status === 401 || resp.status === 403) && keyIdx < keys.length - 1) {
      keyIdx++;
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < backoffs.length) {
      keyIdx = 0;
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
      continue;
    }
    if (!resp.ok) {
      throw new Error(`API 返回 ${resp.status}${resp.status === 429 ? "（网关限流，已轮换 Key 并退避重试仍失败，稍后再试或回退本地引擎）" : ""}`);
    }
    const data = await resp.json();
    const msg = data?.choices?.[0]?.message ?? {};
    return {
      content: String(msg.content ?? "").trim(),
      reasoning: String(msg.reasoning_content ?? msg.reasoning ?? ""),
    };
  }
}
