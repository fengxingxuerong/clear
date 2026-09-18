/**
 * runHumanize 统一分发测试（覆盖报告 P2 盲区）：
 * API 优先 / 失败回退本地 / 未启用 API 直走本地 / 本地择优透传 / 长文分块拼接。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { runHumanize } from "./llm";
import { DEFAULT_API } from "./llm-config";

afterEach(() => {
  vi.unstubAllGlobals();
});

function okJson(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。";

/** 改写专家角色判定（质检员/检测员不在 runHumanize 单轮路径出现） */
function stubRewrite(reply: string | (() => Response)) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: { body?: string }) => {
      void init;
      return typeof reply === "string" ? okJson(reply) : reply();
    }),
  );
}

describe("runHumanize 分发", () => {
  it("API 未启用：直走本地引擎，usedApi=false", async () => {
    const cfg = { ...DEFAULT_API, enabled: false };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.usedApi).toBe(false);
    expect(r.engine).toBe("local");
    expect(r.degrade.join("")).toContain("未启用 API");
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.before.score).toBeGreaterThanOrEqual(r.after.score - 5); // 本地分不显著上升
  });

  it("API 启用单轮：走 LLM，输出经 crossChunkCleanup 后返回", async () => {
    stubRewrite("时间往前倒几年，这类工具还没几个人用，现在情况已经完全不一样了，值得慢慢琢磨。");
    // DEFAULT_API.deepMode 默认 true，单轮路径须显式关闭
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: false };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.usedApi).toBe(true);
    expect(r.engine).toBe("llm");
    expect(r.degrade).toEqual([]); // 全程 LLM，不得留降级痕迹
    expect(r.text).toContain("时间往前倒几年");
    expect(r.note).toBe("");
  });

  it("API 失败（404 无退避）：回退本地引擎，note 注明原因，结果不丢", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 404 })),
    );
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: false };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.usedApi).toBe(false);
    // 旧文案在这里会显示「未配置/未启用 API」——用户明明付了调用，那是假话
    expect(r.engine).toBe("local");
    expect(r.degrade.join("")).toContain("API 调用失败");
    expect(r.note.startsWith("⚠️")).toBe(true);
    expect(r.note).toMatch(/API 调用失败，已回退本地引擎/);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("API 空输出：视为失败回退本地（不把空串当结果）", async () => {
    stubRewrite("");
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: false };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.usedApi).toBe(false);
    expect(r.engine).toBe("local");
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("本地择优设置透传：bestOf 开启时返回 tried/rejected 信息", async () => {
    const cfg = { ...DEFAULT_API, enabled: false };
    const r = await runHumanize(SAMPLE, 0.7, cfg, undefined, false, undefined, {
      bestOf: true,
      candidates: 3,
    });
    expect(r.bestOf).toBeDefined();
    expect(r.bestOf!.tried).toBeGreaterThan(0);
    expect(r.bestOf!.tried).toBeLessThanOrEqual(3);
  });

  it("长文分块：超阈值文本逐块处理拼接，note 标注块数", async () => {
    // 每段约 550 字 × 4 段 ≈ 2200 字（> CHUNK_THRESHOLD=1200，CHUNK_SIZE=1000 → 多块）
    const unit =
      "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生，并且在内容生产领域获得了广泛的应用场景，成为了许多从业者日常工作中不可或缺的辅助手段之一，无论是新闻稿件的初稿撰写，还是营销文案的多版本迭代，都能看到这类工具活跃的身影。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本，同时还推动了组织内部协作方式的整体变革与持续演进，让跨部门的信息流转变得更加顺畅透明。然而，技术的变革也带来了一系列值得关注的挑战，比如内容同质化的隐忧、原创性判定的争议，以及对从业者技能结构的重塑压力。与此同时，如何平衡创新与风险，成为至关重要的课题，既不能因噎废食地拒绝新工具，也不能不加甄别地全盘接受，需要在实践探索中逐步建立相应的使用规范与质量标准。";
    const long = Array.from({ length: 4 }, () => unit).join("\n\n");
    stubRewrite("这是改写后的段落内容，读起来像人写的，节奏也更自然了一些。");
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: false };
    const r = await runHumanize(long, 0.7, cfg);
    expect(r.usedApi).toBe(true);
    expect(r.note).toMatch(/长文分块处理（\d+ 块）/);
    expect(r.text).toContain("这是改写后的段落内容");
  });

  it("深度模式：走 humanizeViaApiDeep 闭环，note 汇总各轮评分", async () => {
    // 样本不含英文术语——改写稿假人不保留原词时忠实度校验会打回
    const sample =
      "值得注意的是，随着智能技术的快速发展，写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。";
    // 角色化 mock：改写专家→正文，质检员→PASS，检测员→分数
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { messages: { content: string }[] };
        const sys = body.messages?.[0]?.content ?? "";
        if (sys.includes("质检员")) return okJson("PASS");
        if (sys.includes("改写专家"))
          return okJson(
            "时间往前倒几年，这类工具还没几个人用。现在情况完全不一样了，写作成本降了不少，效率也上来了。不过用得多了，内容同质化的担心也在，使用规范还得慢慢建立。",
          );
        return okJson("句长过于均匀\n35");
      }),
    );
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: true };
    const r = await runHumanize(sample, 0.7, cfg);
    expect(r.usedApi).toBe(true);
    expect(r.roundScores.length).toBeGreaterThan(0);
    expect(r.note).toMatch(/深度去味|评分/);
  });
});
