import { describe, it, expect, vi, afterEach } from "vitest";
import { chat } from "./llm-chat";
import type { ApiConfig } from "./llm-config";

function resp(status: number, content = "改写后的文本。"): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
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
