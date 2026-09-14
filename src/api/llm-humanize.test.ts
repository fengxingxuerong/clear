import { describe, it, expect, vi, afterEach } from "vitest";
import { humanizeViaApi, humanizeViaApiDeep } from "./llm-humanize.ts";
import { DEFAULT_API } from "./llm-config.ts";
import { buildRevisionPrompt } from "./llm-prompts.ts";
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

describe("LLM 空输出防护", () => {
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key" };

  it("单轮：空内容拒绝并提示回退，绝不把空串当去味结果", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ choices: [{ message: { content: "" } }] })),
    );
    await expect(humanizeViaApi("值得注意的是，人工智能很重要。", cfg)).rejects.toThrow(/空内容/);
  });

  it("深度模式零轮完成：拒绝而不是静默返回空串", async () => {
    // maxRounds=0 直接命中收尾路径（等价于预算耗尽且无任何轮次产出）
    await expect(
      humanizeViaApiDeep("值得注意的是，人工智能很重要。", cfg, undefined, 10, 0),
    ).rejects.toThrow(/本地引擎/);
  });

  // v0.8.9 P0：实测深度闭环第 2 轮拿到空 content 就 break，158~242s 后静默交付
  // 首轮未达标稿。现改为降级重试（token 预算翻倍 → 换备选模型），重试仍空才放弃。
  it("深度：空响应走降级重试，而非一次失败即放弃", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return okJson({ choices: [{ message: { content: "" } }] });
      }),
    );
    await expect(
      humanizeViaApiDeep(
        "值得注意的是，人工智能正在深刻地改变着我们的生活方式。",
        cfg,
        undefined,
        10,
        1,
      ),
    ).rejects.toThrow(/空内容|本地引擎/);
    // 默认档 + token 预算翻倍档 = 2 次尝试（未配 altModel，故无第三档）
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("调用预算跨块共享（v0.8.6 修复）", () => {
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key", maxApiCalls: 2 };

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

describe("首轮多候选竞争（v0.8.9）", () => {
  const cfgBase = { ...DEFAULT_API, enabled: true, apiKey: "test-key", maxApiCalls: 0 };
  const text = "值得注意的是，人工智能正在深刻地改变着我们的生活方式。";

  // 依据：实测同一 temperature=0.9 的改写稿质量在 20~88 分间横跳（极差 89），
  // 而评判尺子极稳（同文本重复评判极差 2）——瓶颈是采样运气，多采几稿取最优最直接。
  it("contestSamples=2：同模型采样两稿，note 记录两候选", async () => {
    const { fetch } = rolePlayFetch();
    vi.stubGlobal("fetch", fetch);
    const r = await humanizeViaApiDeep(
      text,
      { ...cfgBase, contestSamples: 2 },
      undefined,
      10,
      1,
      0.6,
    );
    expect(r.note).toContain("#1");
    expect(r.note).toContain("#2");
  });

  it("contestSamples 缺省(=1) 不进竞争段，调用数明显更少", async () => {
    const a = rolePlayFetch();
    vi.stubGlobal("fetch", a.fetch);
    await humanizeViaApiDeep(text, { ...cfgBase }, undefined, 10, 1, 0.6);
    const n1 = a.count();

    vi.unstubAllGlobals();
    const b = rolePlayFetch();
    vi.stubGlobal("fetch", b.fetch);
    await humanizeViaApiDeep(text, { ...cfgBase, contestSamples: 3 }, undefined, 10, 1, 0.6);
    const n3 = b.count();

    expect(n3).toBeGreaterThan(n1);
  });
  // v0.8.9：修订轮实测频繁反向优化（76→88、竞争稿 70 → 修订稿 89）。
  // 分数不优于当前最优即判定修订无收益，立即收手，不再烧完预算。
  it("修订未优于当前最优时提前收手（bestScore 作基线，首轮哨兵 999 不误停）", async () => {
    const { fetch } = rolePlayFetch(); // 所有轮固定判 35 分
    vi.stubGlobal("fetch", fetch);
    const r = await humanizeViaApiDeep(text, { ...cfgBase }, undefined, 10, 4, 0.6);
    expect(r.note).toContain("未优于当前最优");
    expect(r.text).toBe(GOOD_REWRITE); // 仍带最优稿返回，不是空串
  });
});

describe("修订提示词：质检反馈分类（v0.8.9）", () => {
  // 实测问题：质检的「新增表姐、朋友等具体人物，原文无此内容」与评判的「句长过于均匀」
  // 混在一个列表里，模型把前者也当 AI 痕迹去"消除"，结果越改越偏。
  const critique = [
    "句长过于均匀",
    "新增表姐、朋友等具体人物，原文无此内容",
    "遗漏\u201c数据标注师\u201d等专有名词",
  ];
  const p = buildRevisionPrompt("正文内容", 70, 24, critique);

  it("新增/遗漏类识别为事实错误，单独成区且排在 AI 痕迹之前", () => {
    expect(p).toContain("必须先修的事实错误");
    expect(p).toContain("新增表姐");
    expect(p).toContain("遗漏");
    expect(p.indexOf("必须先修的事实错误")).toBeLessThan(p.indexOf("残留 AI 痕迹"));
  });

  it("纯 AI 味痕迹仍留在痕迹区，不被误判成事实错误", () => {
    const tail = p.slice(p.indexOf("残留 AI 痕迹"));
    expect(tail).toContain("句长过于均匀");
    expect(tail).not.toContain("新增表姐");
  });

  it("无质检问题时退化为原行为，不出现事实错误区", () => {
    const q = buildRevisionPrompt("正文内容", 70, 24, ["句长过于均匀"]);
    expect(q).not.toContain("必须先修的事实错误");
  });
});
