import { describe, it, expect, vi, afterEach } from "vitest";
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
