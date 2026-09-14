/**
 * v0.9.3 合议庭（judge-panel）单元测试
 * 覆盖：痕迹语义归一交叉定罪 / 加权中位数 / 席位容错（单席失败不连坐）/
 *       全席失败抛错 / 分数解析（思考型 reasoning 兜底）
 * 按项目测试纪律：mock fetch 时用 system 提示词角色判定（检测员/改写专家），
 * 不用 includes("PASS") 误判。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { judgeByPanel, type JudgeSeat } from "./judge-panel";

const SEATS: JudgeSeat[] = [
  { id: "a", baseUrl: "https://gw-a/v1", apiKey: "k1", model: "m1" },
  { id: "b", baseUrl: "https://gw-b/v1", apiKey: "k2", model: "m2" },
  { id: "c", baseUrl: "https://gw-c/v1", apiKey: "k3", model: "m3" },
];

/** mock 响应工厂：按调用 URL（含网关域名）路由到不同席 */
function mockFetchBySeat(responses: Record<string, { content?: string; reasoning?: string; status?: number }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      for (const [gw, resp] of Object.entries(responses)) {
        if (String(url).includes(gw)) {
          if (resp.status) return new Response("err", { status: resp.status });
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: resp.content ?? "",
                    reasoning_content: resp.reasoning ?? "",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return new Response("{}", { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("judgeByPanel 合议庭聚合", () => {
  it("三席一致：痕迹交叉定罪（≥2 票），分数取中位", async () => {
    mockFetchBySeat({
      "gw-a": { content: "句长过于均匀\n过渡词残留\n62" },
      "gw-b": { content: "句子长度过于一致\n套话开头\n58" },
      "gw-c": { content: "句长过于均匀\n词汇书面化\n70" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    // 三席分 62/58/70 → 中位 62
    expect(r.score).toBe(62);
    expect(r.validCount).toBe(3);
    // 「句长过于均匀」三席中两席指出（a、c 原文 + b 归一后同桶）→ 定罪
    expect(r.critique.some((c) => c.includes("句长"))).toBe(true);
    // 「词汇书面化」只有 c 一票 → 不定罪
    expect(r.critique.some((c) => c.includes("词汇书面化") && !c.includes("席"))).toBe(false);
    expect(r.spread).toBe(12); // 70-58
  });

  it("单席失败不连坐：其余两席继续出结果", async () => {
    mockFetchBySeat({
      "gw-a": { content: "句长过于均匀\n40" },
      "gw-b": { status: 401 },
      "gw-c": { content: "句长过于均匀\n44" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    expect(r.validCount).toBe(2);
    expect(r.score).toBe(42); // (40+44)/2 中位
    // 两席均指出句长 → 交叉定罪成立
    expect(r.critique.some((c) => c.includes("句长"))).toBe(true);
    // 失败席留痕
    expect(r.seats.find((s) => s.id === "b")?.score).toBeNull();
  });

  it("全席失败抛错（上层回退单裁判）", async () => {
    mockFetchBySeat({
      "gw-a": { status: 401 },
      "gw-b": { status: 401 },
      "gw-c": { status: 401 },
    });
    await expect(judgeByPanel("测试文本", SEATS)).rejects.toThrow(/合议庭全部席位失败/);
  });

  it("思考型模型 content 空：reasoning 兜底取末位数字", async () => {
    mockFetchBySeat({
      "gw-a": { reasoning: "思考中...最终判断 35 分" },
      "gw-b": { content: "句长过于均匀\n35" },
      "gw-c": { content: "句长过于均匀\n35" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    expect(r.score).toBe(35);
    expect(r.validCount).toBe(3);
  });

  it("无交叉痕迹（各席意见全不同）：critique 为空，分数仍有效", async () => {
    mockFetchBySeat({
      "gw-a": { content: "句长过于均匀\n30" },
      "gw-b": { content: "标点过于规整\n30" },
      "gw-c": { content: "用词重复很多\n30" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    expect(r.score).toBe(30);
    expect(r.critique).toEqual([]);
  });

  it("席位权重：主力席双倍展开后中位偏移", async () => {
    const weighted: JudgeSeat[] = [
      { ...SEATS[0], weight: 3 },
      { ...SEATS[1], weight: 1 },
    ];
    mockFetchBySeat({
      "gw-a": { content: "句长过于均匀\n20" },
      "gw-b": { content: "句长过于均匀\n80" },
    });
    const r = await judgeByPanel("测试文本", weighted);
    // 展开 [20,20,20,80] → 中位 20
    expect(r.score).toBe(20);
  });
});
