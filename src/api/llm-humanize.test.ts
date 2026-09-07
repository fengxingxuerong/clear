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

describe("调用预算跨块共享（v0.8.6 修复）", () => {
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key", maxApiCalls: 2 };

  /** 改写稿假人：需通过 localHardGate（指纹/忠实度/连贯性），且不能像原文 */
  const GOOD_REWRITE =
    "时间往前倒几年，这类工具还没几个人用，现在情况已经完全不一样了，值得慢慢琢磨。";

  /** 按系统提示词角色返回：质检员→PASS，检测员→痕迹+分数 */
  function rolePlayFetch(): { fetch: ReturnType<typeof vi.fn>; count: () => number } {
    let n = 0;
    const f = vi.fn(async (_url: string, init?: { body?: string }) => {
      n++;
      const body = JSON.parse(init?.body ?? "{}") as {
        messages: { role: string; content: string }[];
      };
      const sys = body.messages?.[0]?.content ?? "";
      if (sys.includes("质检员")) {
        // 质检通道：PASS 放行
        return okJson({ choices: [{ message: { content: "PASS" } }] });
      }
      if (sys.includes("改写专家")) {
        // 改写通道：返回能过本地硬门槛的正文（须先于评判判定——
        // SYSTEM_PROMPT 正文中提及"朱雀"，按包含词判定会误入语义层分支）
        return okJson({ choices: [{ message: { content: GOOD_REWRITE } }] });
      }
      // 评判/语义层检测员通道：痕迹清单 + 末行独立 0-100 整数
      return okJson({
        choices: [{ message: { content: "句长过于均匀\n35" } }],
      });
    });
    return { fetch: f, count: () => n };
  }

  it("budgetShared=true：不清零计数，后续块继承已消耗预算", async () => {
    const { fetch, count } = rolePlayFetch();
    vi.stubGlobal("fetch", fetch);
    // 块1：正常跑完（每轮 1 改写 + 1 质检 + 3 评判 = 5 次调用）
    const deep1 = await humanizeViaApiDeep(
      "值得注意的是，人工智能很重要。",
      cfg,
      undefined,
      10,
      1,
      0.6,
    );
    const afterBlock1 = count();
    expect(afterBlock1).toBeGreaterThanOrEqual(2);
    expect(deep1.text).toBe(GOOD_REWRITE);
    // 块2：budgetShared=true 继承累计预算——maxApiCalls=2 已被块1用尽，
    // 不应再发任何请求；无结果时抛错（由上层分块循环捕获回退本地），note 注明超预算
    const callsBefore = count();
    await expect(
      humanizeViaApiDeep(
        "另一段文字同样值得注意，需要认真琢磨。",
        cfg,
        undefined,
        10,
        1,
        0.6,
        true,
      ),
    ).rejects.toThrow(/调用上限/);
    expect(count()).toBe(callsBefore); // 预算未重置：块2 零请求
  });

  it("budgetShared=false（默认）：每次闭环从零计数，行为不变", async () => {
    const { fetch, count } = rolePlayFetch();
    vi.stubGlobal("fetch", fetch);
    const deep = await humanizeViaApiDeep(
      "值得注意的是，人工智能很重要。",
      cfg,
      undefined,
      10,
      1,
      0.6,
    );
    // 独立调用重置计数：本次闭环自身的请求不被历史预算拦截
    expect(count()).toBeGreaterThanOrEqual(2);
    expect(deep.roundScores.length).toBeGreaterThan(0);
    expect(deep.text).toBe(GOOD_REWRITE);
  });
});

describe("评判锚点：达标线宽严自适应（v0.8.8）", () => {
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key" };
  /** 改写稿假人：需通过 localHardGate（指纹/忠实度/连贯性），且不能像原文 */
  const GOOD_REWRITE =
    "时间往前倒几年，这类工具还没几个人用，现在情况已经完全不一样了，值得慢慢琢磨。";

  /** 按评判调用序次返回预设分数序列（无交叉评判 → 同模型 3 样本取中位数，
   *  即每轮候选消耗 3 次评判调用） */
  function judgeSeqFetch(scores: number[]): ReturnType<typeof vi.fn> {
    let judgeCalls = 0;
    return vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as {
        messages: { role: string; content: string }[];
      };
      const sys = body.messages?.[0]?.content ?? "";
      if (sys.includes("质检员")) {
        return okJson({ choices: [{ message: { content: "PASS" } }] });
      }
      if (sys.includes("改写专家")) {
        return okJson({ choices: [{ message: { content: GOOD_REWRITE } }] });
      }
      const s = scores[Math.min(Math.floor(judgeCalls / 3), scores.length - 1)];
      judgeCalls++;
      return okJson({ choices: [{ message: { content: `句长过于均匀\n${s}` } }] });
    });
  }

  it("严评评判员（首轮 86）：目标放宽到 ≤30，30 分即达标提前收手", async () => {
    vi.stubGlobal("fetch", judgeSeqFetch([86, 30]));
    const deep = await humanizeViaApiDeep(
      "值得注意的是，人工智能很重要。",
      cfg,
      undefined,
      10, // 绝对目标：严评下永不达标（这正是被修掉的问题）
      4,
      0.6,
    );
    expect(deep.targetUsed).toBe(Math.max(10, Math.round(86 * 0.35))); // 86×0.35=30.1→30
    expect(deep.roundScores).toEqual([86, 30]); // 第 2 轮 30 ≤ 30 → 提前收手，不白烧 3/4 轮
    expect(deep.hitTarget).toBe(true);
    expect(deep.note).toContain("评判锚点");
  });

  it("首轮已很低（8 分）：维持绝对目标 10 不放宽，立即达标", async () => {
    vi.stubGlobal("fetch", judgeSeqFetch([8]));
    const deep = await humanizeViaApiDeep(
      "值得注意的是，人工智能很重要。",
      cfg,
      undefined,
      10,
      4,
      0.6,
    );
    expect(deep.targetUsed).toBe(10);
    expect(deep.roundScores).toEqual([8]);
    expect(deep.hitTarget).toBe(true);
    expect(deep.note).not.toContain("评判锚点");
  });
});
