/**
 * 趣AI味 · OpenAI 兼容底层对话调用（超时/重试/错误归一）
 */

import { ApiConfig } from "./llm-config";

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
  // 深度模式一轮要发多次请求，网关限流（429）和瞬时 5xx 常见：指数退避重试
  const backoffs = [2000, 5000, 12000];
  // OpenRouter 网关推荐带上 HTTP-Referer 和 X-Title（用于排名，不带也能用但更稳）
  const isOpenRouter = /openrouter\.ai/i.test(cfg.baseUrl);
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(90_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
          ...(isOpenRouter ? { "HTTP-Referer": "https://github.com/quaiwei", "X-Title": "QuAiWei" } : {}),
        },
        body: JSON.stringify({
          model: opts.model || cfg.model,
          temperature: opts.temperature,
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
    if ((resp.status === 429 || resp.status >= 500) && attempt < backoffs.length) {
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
      continue;
    }
    if (!resp.ok) {
      throw new Error(`API 返回 ${resp.status}`);
    }
    const data = await resp.json();
    const msg = data?.choices?.[0]?.message ?? {};
    return {
      content: String(msg.content ?? "").trim(),
      reasoning: String(msg.reasoning_content ?? msg.reasoning ?? ""),
    };
  }
}
