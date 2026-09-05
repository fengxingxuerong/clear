/**
 * llm-judge 直接测试（覆盖报告 P2 盲区：reasoning 兜底 / 中位数聚合 / 交叉均值）。
 * mock fetch 按 chat 请求体中的 system 提示词特征返回对应内容。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { judgeWithCritique, judgeScoreStable, judgeAiScore, errMsg } from "./llm-judge";
import { DEFAULT_API } from "./llm-config";

afterEach(() => {
  vi.unstubAllGlobals();
});

function okJson(content: string, reasoning = ""): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content, ...(reasoning ? { reasoning_content: reasoning } : {}) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** 读 chat 请求里的 system 内容，交给回调生成响应 */
function stubChat(reply: (sys: string) => { content?: string; reasoning?: string }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { messages: { content: string }[] };
      const sys = body.messages?.[0]?.content ?? "";
      calls.push(sys);
      const r = reply(sys);
      return okJson(r.content ?? "", r.reasoning ?? "");
    }),
  );
  return { calls: () => calls };
}

describe("judgeWithCritique（痕迹清单 + 末行整数解析）", () => {
  it("标准输出：痕迹在前、独立整数行在后", async () => {
    stubChat(() => ({ content: "句长过于均匀\n过渡词残留\n35" }));
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k" };
    const r = await judgeWithCritique("测试文本", cfg);
    expect(r.score).toBe(35);
    expect(r.critique).toEqual(["句长过于均匀", "过渡词残留"]);
  });

  it("从后往前找分数行（痕迹里含数字不干扰）", async () => {
    stubChat(() => ({ content: "有 3 处过渡词残留\n20 处书面化\n48" }));
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k" };
    const r = await judgeWithCritique("测试文本", cfg);
    expect(r.score).toBe(48);
  });

  it("思考型模型 content 空：reasoning 兜底取最后的数字", async () => {
    stubChat(() => ({ content: "", reasoning: "分析……最终分数是 42，检查完毕 42" }));
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k" };
    const r = await judgeWithCritique("测试文本", cfg);
    expect(r.score).toBe(42);
    expect(r.critique).toEqual([]);
  });

  it("content 与 reasoning 都无数字：抛错", async () => {
    stubChat(() => ({ content: "完全没给出评分", reasoning: "" }));
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k" };
    await expect(judgeWithCritique("测试文本", cfg)).rejects.toThrow(/未给出数字/);
  });
});

describe("judgeScoreStable（中位数 / 交叉均值聚合）", () => {
  it("单模型 3 次采样取中位数（离群值被吸收）", async () => {
    let i = 0;
    stubChat(() => {
      i++;
      return { content: `${[30, 90, 32][i - 1]}` }; // 中位数 32
    });
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k" };
    const r = await judgeScoreStable("测试文本", cfg);
    expect(r.score).toBe(32);
  });

  it("交叉模型：主 + 交叉各一票取均值，保留交叉模型痕迹", async () => {
    let i = 0;
    const { calls } = stubChat(() => {
      i++;
      // 第 1 次主模型 40，第 2 次交叉模型 70（带痕迹）
      return i === 1 ? { content: "40" } : { content: "对仗过于工整\n70" };
    });
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", model: "main-m", judgeModel: "cross-m" };
    const r = await judgeScoreStable("测试文本", cfg);
    expect(r.score).toBe(55); // (40+70)/2
    expect(r.critique).toEqual(["对仗过于工整"]); // 交叉模型痕迹优先
    expect(calls().length).toBe(2);
  });

  it("交叉模型部分失败：剩一票也出结果", async () => {
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: { body?: string }) => {
        i++;
        if (i === 2) return new Response("no", { status: 404 });
        const body = JSON.parse(init?.body ?? "{}") as { messages: { content: string }[] };
        void body;
        return okJson("50");
      }),
    );
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", model: "main-m", judgeModel: "cross-m" };
    const r = await judgeScoreStable("测试文本", cfg);
    expect(r.score).toBe(50);
  });

  it("全部失败：抛最后一次错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 404 })),
    );
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k" };
    await expect(judgeScoreStable("测试文本", cfg)).rejects.toThrow();
  });
});

describe("judgeAiScore（裸打分 + reasoning 兜底）", () => {
  it("content 首个数字即分数", async () => {
    stubChat(() => ({ content: "72" }));
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k" };
    expect(await judgeAiScore("测试文本", cfg)).toBe(72);
  });

  it("content 空时从 reasoning 尾部数字兜底", async () => {
    stubChat(() => ({ content: "", reasoning: "我认为是 15 分" }));
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k" };
    expect(await judgeAiScore("测试文本", cfg)).toBe(15);
  });
});

describe("errMsg", () => {
  it("Error → message；其他类型 → String", () => {
    expect(errMsg(new Error("boom"))).toBe("boom");
    expect(errMsg(123)).toBe("123");
    expect(errMsg(null)).toBe("null");
  });
});
