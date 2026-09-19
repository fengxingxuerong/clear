/**
 * 趣AI味 · OpenAI 兼容底层对话调用（超时/重试/错误归一）
 */

import { ApiConfig, effectiveKeys } from "./llm-config";

/* ----------------------------- 底层调用 ----------------------------- */

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/* ----------------------------- 调用计数（v0.8.5 预算） -----------------------------
 * 深度闭环一篇最多能烧 15+ 次调用（竞争/改写/质检/修复/评判），maxWaitSeconds 只限
 * 时间不限次数——计费类网关还需要次数预算。粒度说明：按逻辑调用计（重试/换 Key 不
 * 重复计），深度闭环在轮间检查预算，轮内不中断，超了带当前最优结果收场。 */
let apiCallCount = 0;

export function resetApiCallCount(): void {
  apiCallCount = 0;
}

export function getApiCallCount(): number {
  return apiCallCount;
}

/**
 * 预算到点、拒绝再发起下一次重试。与"通道故障"区分开：后者可以降级放行/换 Key，
 * 而这个必须一路上抛到深模式闭环，被误当成"质检通道异常"会让**未核查的稿被放行**。
 */
export class BudgetStoppedError extends Error {
  constructor() {
    super("已达调用预算/时限，停止后续重试");
    this.name = "BudgetStopped";
  }
}

export async function chat(
  cfg: ApiConfig,
  messages: ChatMessage[],
  opts: { temperature: number; maxTokens: number; model?: string },
  /** 调用方传入才生效，且**只用于决定是否继续重试/换 Key**——首个请求永远允许发出。
   *  预算的语义只有调用方知道：这里是"别再烧下一轮"，而收稿终审那类安全调用
   *  必须允许越过时限跑完（否则"未核查的稿"会被静默交付）。 */
  overBudget?: () => boolean,
): Promise<{ content: string; reasoning: string }> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  // Key 池：429/401/403 先换下一个 Key 立即重试（Key 轮换），池耗尽或网络瞬断
  // 再走指数退避（深度模式一轮发多次请求，网关限流常见）
  const keys = effectiveKeys(cfg);
  if (keys.length === 0) throw new Error("未配置 API Key");
  apiCallCount++;
  let keyIdx = 0;
  const backoffs = [2000, 5000, 12000];
  // v0.8.7 鉴权失效记忆：401/403 表示 Key 本身无效（配额封禁/被删），重试无意义——
  // 退避后不再使用；429 是限流，窗口恢复后 Key 仍可用，保持从首个 Key 重来
  const authDead = new Set<number>();
  /** 是否刚发生过退避等待：退避后下一轮重选 Key（跳过失效 Key）。
   *  注意换 Key（keyIdx++ continue）不算退避，attempt 计数不变语义即"立即重试"。 */
  let afterBackoff = false;
  // OpenRouter 网关推荐带上 HTTP-Referer 和 X-Title（用于排名，不带也能用但更稳）
  const isOpenRouter = /openrouter\.ai/i.test(cfg.baseUrl);
  const model = opts.model || cfg.model;
  // kimi-k3 网关限制 temperature 只能为 1（实测 400 报错）
  const temperature = /kimi/i.test(model) ? 1 : opts.temperature;
  for (let attempt = 0; ; attempt++) {
    // 到点就不再发起**下一次**尝试（首个请求已在上面发出）。429 换 Key 与退避都走这里。
    if (attempt > 0 && overBudget?.()) throw new BudgetStoppedError();
    // 仅退避后重选 Key：跳过已鉴权失效的（401/403），首个可用 Key 优先。
    // 不能按 attempt>0 判断——换 Key 立即重试也是新 attempt，会覆盖 keyIdx++ 轮换。
    if (afterBackoff) {
      afterBackoff = false;
      keyIdx = keys.findIndex((_, i) => !authDead.has(i));
      if (keyIdx < 0) {
        throw new Error(
          `API 返回 401/403：Key 池 ${keys.length} 个全部鉴权失效，请检查 Key 有效性`,
        );
      }
    }
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(90_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keys[keyIdx]}`,
          ...(isOpenRouter
            ? { "HTTP-Referer": "https://github.com/quaiwei", "X-Title": "QuAiWei" }
            : {}),
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
        afterBackoff = true;
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
      throw e;
    }
    // 限流/鉴权失败：优先换 Key（立即，不等待）；池耗尽再退避等待，
    // 退避后从第一个未失效的 Key 重新试（限流窗口恢复后第一个 Key 往往最有效；
    // 401/403 鉴权已死的 Key 跳过，不浪费调用）
    if (
      (resp.status === 429 || resp.status === 401 || resp.status === 403) &&
      keyIdx < keys.length - 1
    ) {
      if (resp.status !== 429) authDead.add(keyIdx);
      keyIdx++;
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < backoffs.length) {
      keyIdx = 0;
      afterBackoff = true;
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
      continue;
    }
    if (resp.status !== 429 && (resp.status === 401 || resp.status === 403)) authDead.add(keyIdx);
    if (!resp.ok) {
      // 吸取网关响应体里的具体错误原因（如「模型不存在」「配额用尽」），
      // 截断到 200 字符防超长/敏感堆栈刷屏；解析失败静默忽略不影响主错误信息
      let detail = "";
      try {
        const body: unknown = await resp.json();
        const raw =
          typeof body === "object" && body !== null
            ? ((body as Record<string, unknown>).error ??
              (body as Record<string, unknown>).message ??
              (body as Record<string, unknown>).detail)
            : body;
        const text = typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : "";
        if (text) detail = `：${text.slice(0, 200)}`;
      } catch {
        // 响应体非 JSON（如网关 HTML 错误页）→ 不附加
      }
      const dead = authDead.size ? `（失效 Key ${authDead.size}/${keys.length} 个已跳过重试）` : "";
      throw new Error(
        `API 返回 ${resp.status}${resp.status === 429 ? "（网关限流，已轮换 Key 并退避重试仍失败，稍后再试或回退本地引擎）" : ""}${dead}${detail}`,
      );
    }
    const data = await resp.json();
    const msg = data?.choices?.[0]?.message ?? {};
    return {
      content: String(msg.content ?? "").trim(),
      reasoning: String(msg.reasoning_content ?? msg.reasoning ?? ""),
    };
  }
}
