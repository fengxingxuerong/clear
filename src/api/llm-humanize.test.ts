import { describe, it, expect, vi, afterEach } from "vitest";
import { humanizeViaApi, humanizeViaApiDeep } from "./llm-humanize.ts";
import { DEFAULT_API } from "./llm-config.ts";

/** 构造 OpenAI 兼容 200 响应 */
function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LLM 空输出防护", () => {
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key" };

  it("单轮：空内容拒绝并提示回退，绝不把空串当去味结果", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ choices: [{ message: { content: "" } }] })),
    );
    await expect(humanizeViaApi("值得注意的是，人工智能很重要。", cfg)).rejects.toThrow(
      /空内容/
    );
  });

  it("深度模式零轮完成：拒绝而不是静默返回空串", async () => {
    // maxRounds=0 直接命中收尾路径（等价于预算耗尽且无任何轮次产出）
    await expect(
      humanizeViaApiDeep("值得注意的是，人工智能很重要。", cfg, undefined, 10, 0)
    ).rejects.toThrow(/本地引擎/);
  });
});
