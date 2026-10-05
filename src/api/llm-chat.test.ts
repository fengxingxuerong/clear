import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { chat } from "./llm-chat";
import type { ApiConfig } from "./llm-config";

function resp(status: number, content = "改写后的文本。"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const cfg: ApiConfig = {
  enabled: true,
  baseUrl: "https://api.example.com/v1",
  apiKey: "k1",
  apiKeys: "k1\nk2\nk3",
  model: "test-model",
  temperature: 0.9,
  deepMode: false,
  judgeModel: "",
  altModel: "",
  style: "casual",
};

function authOf(init?: RequestInit): string {
  return (init?.headers as Record<string, string>).Authorization;
}

describe("Key 池轮换（429/401 → 换下一个 Key 立即重试）", () => {
  it("429 依次轮换，第 3 个 Key 成功；Auth 头按序用完全部 Key", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(authOf(init));
        return calls.length <= 2 ? resp(429) : resp(200);
      }),
    );
    const r = await chat(cfg, [{ role: "user", content: "原文" }], {
      temperature: 0.9,
      maxTokens: 100,
    });
    expect(r.content).toContain("改写");
    expect(calls).toEqual(["Bearer k1", "Bearer k2", "Bearer k3"]);
  });

  it("401 同样触发轮换（鉴权失败不等退避）", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(authOf(init));
        return calls.length <= 1 ? resp(401) : resp(200);
      }),
    );
    await chat(cfg, [{ role: "user", content: "原文" }], {
      temperature: 0.9,
      maxTokens: 100,
    });
    expect(calls).toEqual(["Bearer k1", "Bearer k2"]);
  });

  it("池耗尽后退避重试，并从首个 Key 重新开始（限流窗口恢复后首个 Key 往往最有效）", async () => {
    vi.useFakeTimers(); // 退避档位到 12s，真时钟会拖慢测试且定时器泄漏会污染后续用例
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(authOf(init));
        return calls.length <= 3 ? resp(429) : resp(200);
      }),
    );
    const pending = chat(cfg, [{ role: "user", content: "原文" }], {
      temperature: 0.9,
      maxTokens: 100,
    });
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;
    expect(calls).toEqual(["Bearer k1", "Bearer k2", "Bearer k3", "Bearer k1"]);
  });

  it("网络瞬断（fetch reject）走指数退避后成功", async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n === 1) throw new Error("ECONNRESET");
        return resp(200);
      }),
    );
    const pending = chat(cfg, [{ role: "user", content: "原文" }], {
      temperature: 0.9,
      maxTokens: 100,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await pending;
    expect(r.content).toContain("改写");
    expect(n).toBe(2);
  });
});

describe("重试耗尽与失效 Key 跳过（v0.8.7）", () => {
  it("429 重试彻底耗尽：最终抛错且错误信息含限流提示", async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        return resp(429);
      }),
    );
    const pending = chat(cfg, [{ role: "user", content: "原文" }], {
      temperature: 0.9,
      maxTokens: 100,
    });
    // 先挂上 rejects 断言（避免 unhandled rejection），再推进定时器消费退避序列
    const assertion = pending.catch((e: unknown) => {
      expect((e as Error).message).toMatch(/网关限流/);
      // 流程：3 Key 轮换（3 次）→ 退避 → 从头 3 Key（3 次）→ 退避 → …，
      // attempt 耗尽时共 6 次请求（attempt 0/1/2 三轮退避前各 3 次中前两轮）
      expect(n).toBeGreaterThanOrEqual(6);
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it("401 鉴权失效的 Key 退避后不再使用（429 的仍可用）", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const auth = authOf(init);
        calls.push(auth);
        // k1、k2 都 401（鉴权死），k3 正常
        if (auth === "Bearer k3") return resp(200);
        return resp(401);
      }),
    );
    const pending = chat(cfg, [{ role: "user", content: "原文" }], {
      temperature: 0.9,
      maxTokens: 100,
    });
    const assertion = pending.then(
      (r) => {
        expect(r.content).toContain("改写");
        // k1、k2 各试一次后标记失效，退避后永远跳过，只用 k3
        expect(calls.filter((a) => a === "Bearer k1").length).toBe(1);
        expect(calls.filter((a) => a === "Bearer k2").length).toBe(1);
        expect(calls[calls.length - 1]).toBe("Bearer k3");
      },
      (e: unknown) => {
        throw e;
      },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("全部 Key 401：轮换耗尽即抛错（含失效统计，不浪费退避重试）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resp(401)),
    );
    // 401 依次轮换 k1→k2→k3 后池尽，authDead 记满 3 个，401 无退避直接抛
    await expect(
      chat(cfg, [{ role: "user", content: "原文" }], { temperature: 0.9, maxTokens: 100 }),
    ).rejects.toThrow(/401（失效 Key 3\/3 个已跳过重试）/);
  });
});

describe("错误详情透传（v0.8.7：网关响应体里的具体原因）", () => {
  it("OpenAI 风格 error 对象：404 带上「模型不存在」详情", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "The model `xxx` does not exist" } }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(
      chat({ ...cfg, apiKey: "k1", apiKeys: undefined }, [{ role: "user", content: "原文" }], {
        temperature: 0.9,
        maxTokens: 100,
      }),
    ).rejects.toThrow(/404.*The model `xxx` does not exist/);
  });

  it("顶层 message / detail 字段与字符串 error 同样可提取；超长截断到 200 字符", async () => {
    const long = "配额".repeat(150);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: long }), { status: 402 })),
    );
    const err = (await chat(
      { ...cfg, apiKey: "k1", apiKeys: undefined },
      [{ role: "user", content: "原文" }],
      {
        temperature: 0.9,
        maxTokens: 100,
      },
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain(long.slice(0, 200));
    expect(err.message).not.toContain(long.slice(0, 201));
  });

  it("响应体非 JSON（网关 HTML 错误页）：错误信息保持干净不含垃圾正文", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>Bad Gateway</html>", { status: 404 })),
    );
    await expect(
      chat({ ...cfg, apiKey: "k1", apiKeys: undefined }, [{ role: "user", content: "原文" }], {
        temperature: 0.9,
        maxTokens: 100,
      }),
    ).rejects.toThrow(/^API 返回 404$/);
  });

  /**
   * 响应体**不是普通对象**时的分支（llm-chat.ts 行 139）。
   *
   * `typeof body === "object" && body !== null ? (body.error ?? body.message ?? body.detail) : body`
   * —— 三元表达式的 `: body` 那一支。此前三条用例的响应体都是对象，
   * 这一支从未走过；而 `typeof null === "object"` 为真这个坑尤其要钉住。
   *
   * 探针实测真值（探针稿在 .covtmp，跑完即删）：
   *   body 是数组    → "API 返回 400"（无详情：数组不是字符串，JSON 后又被 ? 判掉）
   *   body 是字符串  → "API 返回 400：纯字符串错误"
   *   body 是数字    → "API 返回 400：42"
   *   body 是 null    → "API 返回 400"（raw 为 null → 不附加）
   */
  it("响应体是数组/字符串/数字/null 时的错误信息口径（行 139 三元的 else 支）", async () => {
    const call = async (payload: unknown) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(payload), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      return (
        (await chat(
          { ...cfg, apiKey: "k1", apiKeys: undefined },
          [{ role: "user", content: "原文" }],
          { temperature: 0.9, maxTokens: 100 },
        ).catch((e: unknown) => e)) as Error
      ).message;
    };
    // 字符串 body：原样透出
    expect(await call("纯字符串错误")).toBe("API 返回 400：纯字符串错误");
    // 数字 body：JSON.stringify 后透出
    expect(await call(42)).toBe("API 返回 400：42");
    // 数组 body：不是字符串且 JSON 后不产生内容 → 不附加详情
    expect(await call(["a", "b"])).toBe("API 返回 400");
    // null：typeof null === "object" 但 body !== null 为假 → 走 : body = null → 不附加
    expect(await call(null)).toBe("API 返回 400");
  });

  it("error 是对象时整段 JSON 透出（不是只取 message）", async () => {
    // 探针实测：{error:{message:"模型不存在"}} 出来的是 {"message":"模型不存在"}
    // —— 因为 `??` 取到 error 整个对象，随后 typeof raw !== "string" 走 JSON.stringify。
    // 这个口径要钉住：用户看到的是 JSON 而不是干净的一句中文。
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "模型不存在" } }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const err = (await chat(
      { ...cfg, apiKey: "k1", apiKeys: undefined },
      [{ role: "user", content: "原文" }],
      { temperature: 0.9, maxTokens: 100 },
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('API 返回 400：{"message":"模型不存在"}');
  });
});

/**
 * v0.9.14 预算到点后不再发起「下一次尝试」。
 * 语义要说准：首个请求永远允许发出（该不该发这一稿由调用方的 attempts 循环决定），
 * 这里掐的是 429 换 Key / 退避 2+5+12s 的重试链——到点后不再sleep、不再试。
 */
describe("预算到点停止重试（v0.9.14）", () => {
  it("predicate 为真时：只发首个请求，之后抛 BudgetStopped（不 sleep、不再换 Key）", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        return resp(429);
      }),
    );
    let budget = false;
    const p = () => budget;
    const pr = chat(
      cfg,
      [{ role: "user", content: "原文" }],
      { temperature: 0.9, maxTokens: 100 },
      p,
    );
    await vi.waitFor(async () => {
      budget = true;
    });
    await expect(pr).rejects.toThrow(/预算|时限/);
    expect(n).toBe(1); // 首个请求已发出；退避与换 Key 都被停住
  });

  it("不传 predicate 时行为不变：429 仍按 Key 池轮换", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(authOf(init));
        return calls.length <= 2 ? resp(429) : resp(200);
      }),
    );
    const r = await chat(cfg, [{ role: "user", content: "原文" }], {
      temperature: 0.9,
      maxTokens: 100,
    });
    expect(r.content).toBeTruthy();
    expect(calls).toHaveLength(3);
  });
});

/* ─────────── 入口前置与网络异常退避（2026-10-05） ───────────
 *
 * 这两条都是**用户看得见的失败路径**：
 *  ① 没配 Key 时若不拦，会拿空 Authorization 去请求网关，拿到一个语焉不详的 401；
 *  ② fetch 直接抛（断网/代理挂/DNS 失败）时若不重试，用户会看到"网络错误"就丢掉稿子。
 * ②的退避档位是 2s+5s+12s 真等待，所以必须挂假定时器，否则一次用例 19 秒。 */
describe("入口前置校验与网络异常退避", () => {
  it("行 52：Key 池为空时立即抛「未配置 API Key」，一个请求都不发", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return resp(200);
      }),
    );
    const noKey: ApiConfig = { ...cfg, apiKey: "", apiKeys: "" };
    await expect(
      chat(noKey, [{ role: "user", content: "原文" }], { temperature: 0.9, maxTokens: 100 }),
    ).rejects.toThrow("未配置 API Key");
    // 关键断言：没配 Key 就绝不能发请求（否则用户拿到的是网关 401，而不是可读提示）
    expect(calls).toBe(0);
  });

  it("行 105-113：fetch 抛异常时按 2s/5s/12s 退避重试，重试成功即返回", async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        // 前两次是网络瞬断（fetch 直接 reject），第三次恢复
        if (n <= 2) throw new TypeError("fetch failed");
        return resp(200);
      }),
    );
    const pending = chat(cfg, [{ role: "user", content: "原文" }], {
      temperature: 0.9,
      maxTokens: 100,
    });
    // 先挂断言再推进定时器，避免 unhandled rejection
    const assertion = pending.then((r) => {
      expect(r.content).toBeTruthy();
      expect(n).toBe(3);
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it("行 112：网络异常退避彻底耗尽后，把原始异常原样抛出（不吞错）", async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        throw new TypeError("fetch failed");
      }),
    );
    const pending = chat(cfg, [{ role: "user", content: "原文" }], {
      temperature: 0.9,
      maxTokens: 100,
    });
    const assertion = pending.then(
      () => {
        throw new Error("本该抛错却成功了");
      },
      (e: unknown) => {
        // 耗尽后必须把原始异常抛出去，用户才能看到"网络错误"而不是一个含糊的文案
        expect((e as Error).message).toBe("fetch failed");
        // 首轮 + 3 档退避 = 4 次（attempt 0/1/2 退避，attempt 3 时 attempt<3 已假）
        expect(n).toBe(4);
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });
});

/**
 * 请求体的两处「按条件改写」
 *
 * 都在发请求**之前**决定，且都是「不这么做就 400」的硬约束：
 * ① kimi 系列网关限制 temperature 只能为 1（源码注释记着实测 400）
 * ② OpenRouter 网关带上 HTTP-Referer / X-Title（不带也能用，但排名会吃亏）
 */
describe("请求体改写：kimi 温度锁定 + OpenRouter 头", () => {
  const bodies: { temperature?: number; headers: Record<string, string> }[] = [];

  beforeEach(() => {
    bodies.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push({
          temperature: (JSON.parse(String(init.body)) as { temperature?: number }).temperature,
          headers: init.headers as Record<string, string>,
        });
        return resp(200, "改写后的文本。");
      }),
    );
  });

  const msgs = [{ role: "user" as const, content: "hi" }];
  const withModel = (model: string): ApiConfig => ({ ...cfg, model });
  const opts = { temperature: 0.3, maxTokens: 100 };

  it.each(["kimi-k2", "Kimi-k3", "moonshot/kimi-latest"])(
    "kimi 系模型 %s → temperature 被强制成 1",
    async (model) => {
      await chat(withModel(model), msgs, opts);
      expect(bodies[0].temperature).toBe(1); // 传进去的 0.3 被忽略
    },
  );

  it.each(["gpt-4o", "claude-3"])("非 kimi 模型 %s → temperature 原样透传", async (model) => {
    await chat(withModel(model), msgs, opts);
    expect(bodies[0].temperature).toBe(0.3);
  });

  it("opts.model 覆盖 cfg.model 时，锁定依然生效", async () => {
    // 这条容易漏：判定用的是 `opts.model || cfg.model` 的**结果**，
    // 而不是只查 cfg.model。cfg 配的是 gpt-4o、单次请求指定 kimi-k3 → 仍须锁 1。
    await chat(withModel("gpt-4o"), msgs, { ...opts, model: "kimi-k3" });
    expect(bodies[0].temperature).toBe(1);
  });

  it.each([
    ["https://openrouter.ai/api/v1", true],
    ["https://OPENROUTER.AI/api/v1", true], // 大小写不敏感
    ["https://api.example.com/v1", false],
  ])("baseUrl=%s → OpenRouter 头存在与否 = %s", async (baseUrl, expected) => {
    await chat({ ...cfg, baseUrl }, msgs, opts);
    const h = bodies[0].headers;
    if (expected) {
      expect(h["HTTP-Referer"]).toBe("https://github.com/quaiwei");
      expect(h["X-Title"]).toBe("QuAiWei");
    } else {
      expect(h["HTTP-Referer"]).toBeUndefined();
      expect(h["X-Title"]).toBeUndefined();
    }
  });

  it("尾部多余斜杠不会拼出双斜杠", async () => {
    let seen = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen = url;
        return resp(200);
      }),
    );
    await chat({ ...cfg, baseUrl: "https://api.example.com/v1///" }, msgs, opts);
    expect(seen).toBe("https://api.example.com/v1/chat/completions");
  });
});
