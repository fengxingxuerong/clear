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

/**
 * v0.9.13 ① 首轮好区即收手（省掉一半调用）
 *
 * 依据：2026-09-19 四篇真送网关，修订轮 2/2 负收益（15→46/49、89→92）。
 * 旧达标线 `max(绝对目标 10, 首轮×0.35)` 在首轮 15 分时算出目标 10，
 * 于是把一个已经在好区的稿子拖着再改一轮、改坏，再白烧约一半预算。
 */
describe("首轮好区即收手，不再开修订轮（v0.9.13）", () => {
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key" };
  const TEXT = "值得注意的是，人工智能正在深刻地改变着我们的生活方式。";
  const A = "时间往前倒几年，这类工具还没几个人用，现在情况已经完全不一样了，值得慢慢琢磨。";
  const B = "往回看几年，用这东西的没几个，如今完全不同了，值得琢磨琢磨。";

  /** 按调用序打桩：质检员 → 改写专家（第 1 次给 A，其后给 B）→ 评判（每轮 3 样本取中位） */
  function stub(scores: number[], qcVerdicts: string[]) {
    let judge = 0;
    let qc = 0;
    let writer = 0;
    const ok = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as {
        messages: { role: string; content: string }[];
      };
      const sys = body.messages?.[0]?.content ?? "";
      if (sys.includes("质检员")) {
        const v = qcVerdicts[Math.min(qc, qcVerdicts.length - 1)];
        qc++;
        return ok(v);
      }
      if (sys.includes("改写专家")) {
        writer++;
        return ok(writer === 1 ? A : B);
      }
      const s = scores[Math.min(Math.floor(judge / 3), scores.length - 1)];
      judge++;
      return ok(`句长过于均匀\n${s}`);
    });
    return { fetch, writers: () => writer, qcCalls: () => qc };
  }

  it("首轮 15 分：好区内，改写调用只有 1 次（修订轮根本没开）", async () => {
    const s = stub([15, 49], ["PASS"]);
    vi.stubGlobal("fetch", s.fetch);
    const deep = await humanizeViaApiDeep(TEXT, cfg, undefined, 10, 4, 0.6);
    expect(s.writers()).toBe(1);
    expect(deep.roundScores).toEqual([15]);
    expect(deep.targetUsed).toBe(15); // 绝不往下追到 10
    expect(deep.hitTarget).toBe(true);
    expect(deep.note).toContain("人写带");
    expect(deep.note).not.toMatch(/^；/); // 追加时不留前导分号
  });

  it("首轮 8 分：绝对目标 10 仍然生效（好区不放宽目标，只停止修订）", async () => {
    const s = stub([8], ["PASS"]);
    vi.stubGlobal("fetch", s.fetch);
    const deep = await humanizeViaApiDeep(TEXT, cfg, undefined, 10, 4, 0.6);
    expect(deep.targetUsed).toBe(10);
    expect(s.writers()).toBe(1);
  });

  it("对照：首轮 86 分不在好区 → 修订轮照开，自适应放宽不受影响", async () => {
    const s = stub([86, 30], ["PASS"]);
    vi.stubGlobal("fetch", s.fetch);
    const deep = await humanizeViaApiDeep(TEXT, cfg, undefined, 10, 4, 0.6);
    expect(s.writers()).toBeGreaterThanOrEqual(2);
    expect(deep.roundScores).toEqual([86, 30]);
    expect(deep.targetUsed).toBe(Math.max(10, Math.round(86 * 0.35)));
    expect(deep.note).toContain("评判锚点");
  });
});

/**
 * v0.9.13 ② 质检结论按稿归属
 *
 * 依据：s3 真跑交付的是过检稿，日志却报着被淘汰候选的两条"谓语丢失"
 * （实测交付稿里根本没有那两处），等于让人去核对一个不存在的缺陷。
 */
describe("质检结论只描述真正交付的那一稿（v0.9.13）", () => {
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key" };
  const TEXT = "值得注意的是，人工智能正在深刻地改变着我们的生活方式。";

  it("第 2 轮被淘汰稿的问题不算到交付稿头上", async () => {
    let qc = 0;
    let writer = 0;
    const ok = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as {
          messages: { role: string; content: string }[];
        };
        const sys = body.messages?.[0]?.content ?? "";
        if (sys.includes("质检员")) {
          qc++;
          // 第 1 稿过检，第 2 稿（修订版）被判塌句 → 本轮弃用
          return ok(qc === 1 ? "PASS" : "FAIL\n人工智能技术。：谓语丢失");
        }
        if (sys.includes("改写专家")) {
          writer++;
          return ok(
            writer === 1
              ? "时间往前倒几年，这类工具还没几个人用，现在情况已经完全不一样了，值得慢慢琢磨。"
              : "人工智能技术。说白了就是这样的。",
          );
        }
        return ok(`句长过于均匀\n60`); // 首轮 60 分：不在好区，才会进修订轮
      }),
    );
    const deep = await humanizeViaApiDeep(TEXT, cfg, undefined, 10, 2, 0.6);
    expect(qc).toBeGreaterThanOrEqual(2); // 确实跑到了被判 FAIL 的那一轮（修复链也调质检，故 ≥2）
    expect(deep.qcPassed).toEqual([true, false]);
    expect(deep.qcIssues, "被淘汰稿的质检问题被算到了交付稿上").toEqual([]);
    expect(deep.text).toContain("时间往前倒几年");
  });

  it("质检通道无输出（异常放行）时不崩，仍交付非空稿", async () => {
    let writer = 0;
    const ok = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as {
          messages: { role: string; content: string }[];
        };
        const sys = body.messages?.[0]?.content ?? "";
        if (sys.includes("质检员")) {
          writer++;
          // 第 2 次质检通道无输出 → 走"通道异常放行"，issues 非空但 pass=true
          return ok(writer === 1 ? "PASS" : "");
        }
        if (sys.includes("改写专家")) return ok("人工智能技术。说白了就是这样的。");
        return ok(`句长过于均匀\n60`);
      }),
    );
    const deep = await humanizeViaApiDeep(TEXT, cfg, undefined, 10, 2, 0.6);
    expect(deep.qcPassed.length).toBeGreaterThanOrEqual(1);
    expect(deep.text.length).toBeGreaterThan(0);
  });
});

/**
 * v0.9.14 编造否决：严格保真开启时，收稿终审发现"原文没有的事实性新增"即拒绝交付。
 *
 * 依据（2026-09-19 s2 种草文真跑）：原文"重量仅为450克"→交付稿"**裸机**450克"、
 * "完全满足日常需求"→"**出门一天**够用"、无第一人称→"**我觉得**算省心"。
 * 当时终审抓到了，却只往 note 写一句"请人工核对"，稿子照样交付。
 *
 * 同时锁 v0.9.14 补的不对称：终审原先只在主循环收场那条路径上跑，
 * "竞争段首轮就达标"的稿子反而不过终审——好区收手会让这条路径变多，故必须一致。
 */
describe("编造否决（strictFidelity 下终审不再只警告，v0.9.14）", () => {
  const TEXT = "值得注意的是，人工智能正在深刻地改变着我们的生活方式。";
  const GOOD = "时间往前倒几年，这类工具还没几个人用，现在情况已经完全不一样了，值得慢慢琢磨。";
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key", strictFidelity: true };
  const fabsJson = (items: string[]) => JSON.stringify({ fabrications: items });

  /** 候选期复核给 clean、终审按需给结果；分数固定 15（好区内，才会走提前收手） */
  function stubStrict(finalReview: string, contest = false) {
    let reviews = 0;
    const calls: string[] = [];
    const ok = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as {
        messages: { role: string; content: string }[];
      };
      const sys = body.messages?.[0]?.content ?? "";
      if (sys.includes("事实核查员")) {
        reviews++;
        calls.push("review");
        return ok(reviews === 1 ? fabsJson([]) : finalReview);
      }
      if (sys.includes("质检员")) {
        calls.push("qc");
        return ok("PASS");
      }
      if (sys.includes("改写专家")) {
        calls.push("rewrite");
        return ok(GOOD);
      }
      calls.push("judge");
      return ok("句长过于均匀\n15");
    });
    vi.stubGlobal("fetch", fetch);
    return { reviews: () => reviews, calls, contest };
  }

  it("终审抓到编造 → 拒绝交付（不再只写 note）", async () => {
    const s = stubStrict(fabsJson(["裸机450克：原文只说重量仅为450克"]));
    await expect(humanizeViaApiDeep(TEXT, cfg, undefined, 10, 2, 0.6)).rejects.toThrow(
      /编造复核否决.*裸机450克/,
    );
    expect(s.reviews()).toBe(2); // 候选期一次、终审一次
  });

  it("竞争段首轮即达标同样要过终审（此前这条路径不做终审）", async () => {
    const s = stubStrict(fabsJson(["出门一天够用：原文无时长"]), true);
    await expect(
      humanizeViaApiDeep(TEXT, { ...cfg, contestSamples: 2 }, undefined, 10, 2, 0.6),
    ).rejects.toThrow(/编造复核否决/);
    // 两个候选都判 15 → 提前收手；终审必须仍发生
    expect(s.reviews()).toBeGreaterThan(2);
  });

  it("终审干净 → 正常交付，且好区收手说明照写", async () => {
    stubStrict(fabsJson([]));
    const deep = await humanizeViaApiDeep(TEXT, cfg, undefined, 10, 2, 0.6);
    expect(deep.text).toBe(GOOD);
    expect(deep.hitTarget).toBe(true);
    expect(deep.note).toContain("人写带");
  });

  it("终审通道本身异常（模型没给 JSON）不阻断交付，但必须说明「未做否决」", async () => {
    stubStrict("我不是 JSON");
    const deep = await humanizeViaApiDeep(TEXT, cfg, undefined, 10, 2, 0.6);
    expect(deep.text).toBe(GOOD);
    // 静默跳过会让用户以为稿子过了事实核查——这比多一次失败更糟
    expect(deep.note).toContain("编造复核未能完成");
    expect(deep.note).toContain("未经事实核查");
  });
});

/**
 * v0.9.14 竞争段定锚口径回归：锚点必须取各候选有效分里的**最低分**，不是首个过检分。
 * 同一篇两份合格稿判 46 与 15：抢先锚到 46 → 目标 17 → 15 分反而不达标 → 白开一轮修订。
 */
describe("竞争段按最低分定锚（v0.9.14）", () => {
  const TEXT = "值得注意的是，人工智能正在深刻地改变着我们的生活方式。";
  const GOOD = "时间往前倒几年，这类工具还没几个人用，现在情况已经完全不一样了，值得慢慢琢磨。";

  it("单独回退定锚那一行即红：expected 16 to be 15（12.9 实测见 CHANGELOG）", async () => {
    let judge = 0;
    let writer = 0;
    const seq = [46, 15, 15]; // 每候选 3 次评判取中位 → 首候选 46、次候选 15
    const ok = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as {
          messages: { role: string; content: string }[];
        };
        const sys = body.messages?.[0]?.content ?? "";
        if (sys.includes("事实核查员") || sys.includes("质检员")) return ok("PASS");
        if (sys.includes("改写专家")) {
          writer++;
          return ok(GOOD);
        }
        const s = seq[Math.min(Math.floor(judge / 3), seq.length - 1)];
        judge++;
        return ok(`句长过于均匀\n${s}`);
      }),
    );
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key", contestSamples: 2 };
    const deep = await humanizeViaApiDeep(TEXT, cfg, undefined, 10, 4, 0.6);
    expect(deep.targetUsed).toBe(15); // 锚到首候选 46 会算出 16，15 分反而"不达标"
    expect(deep.hitTarget).toBe(true);
    expect(writer).toBe(2); // 两个竞争者，且没有第三个（修订轮没开）
    expect(deep.note).toContain("人写带");
  });
});
