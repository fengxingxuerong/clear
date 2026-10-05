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
function mockFetchBySeat(
  responses: Record<string, { content?: string; reasoning?: string; status?: number }>,
) {
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

describe("痕迹归一与解析细节（v0.9.9 补深）", () => {
  it("全票定罪：三席同桶时不加「N/M 席指出」标注，输出首席原文", async () => {
    mockFetchBySeat({
      "gw-a": { content: "对仗工整\n50" },
      "gw-b": { content: "排比结构明显\n50" },
      "gw-c": { content: "对仗过于工整\n50" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    expect(r.critique).toHaveLength(1);
    // 全票时输出首报席的原始表述（不改写为桶名）
    expect(r.critique[0]).toBe("对仗工整");
  });

  it("两席重合：标注「2/3 席指出」，示例取首报席原文", async () => {
    mockFetchBySeat({
      "gw-a": { content: "句长均匀\n60" },
      "gw-b": { content: "句子长度很一致\n60" },
      "gw-c": { content: "标点过于规整\n60" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    expect(r.critique).toHaveLength(1);
    expect(r.critique[0]).toBe("句长均匀（2/3 席指出）");
  });

  it("超长未归一痕迹归入同一「其他痕迹」桶：不同表述也能交叉定罪", async () => {
    mockFetchBySeat({
      "gw-a": { content: "这是一个超过十二个字的自定义痕迹描述\n55" },
      "gw-b": { content: "另一种完全不同样式的超长自定义痕迹\n55" },
      "gw-c": { content: "句长过于均匀\n55" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    // 两条 >12 字表述归入同一「其他痕迹」桶 → 2 票交叉定罪（输出首席原文）
    expect(r.critique).toHaveLength(1);
    expect(r.critique[0]).toBe("这是一个超过十二个字的自定义痕迹描述（2/3 席指出）");
  });

  it("≤12 字小众痕迹：两席字面重合即定罪，保留原文不改名", async () => {
    mockFetchBySeat({
      "gw-a": { content: "结尾模板化\n45" },
      "gw-b": { content: "结尾模板化\n45" },
      "gw-c": { content: "虚构人物事例\n45" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    expect(r.critique).toContain("结尾模板化（2/3 席指出）");
  });

  it("单席有效：spread 为 null（无法计算分歧）", async () => {
    mockFetchBySeat({
      "gw-a": { content: "句长过于均匀\n33" },
      "gw-b": { status: 404 },
      "gw-c": { status: 404 },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    expect(r.validCount).toBe(1);
    expect(r.score).toBe(33);
    expect(r.spread).toBeNull();
  });

  it("装饰分数行解析与序号剥离：critique 不带编号、分数行不入清单", async () => {
    mockFetchBySeat({
      "gw-a": { content: "1. 句长过于均匀\n2. 对仗工整\n得分：85" },
      "gw-b": { content: "一、句长过于均匀\n二、标点过于规整\n70" },
      "gw-c": { content: "句长过于均匀\n62" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    // 85/70/62 → 中位 70
    expect(r.score).toBe(70);
    // 「句长过于均匀」三席归一同桶 → 全票定罪
    const changju = r.critique.find((c) => c.includes("句长"));
    expect(changju).toBeTruthy();
    expect(changju).not.toMatch(/^\d/); // 序号已剥离
    // 席 a 的 critique：分数行「得分：85」不进清单，序号剥离后两条
    const seatA = r.seats.find((s) => s.id === "a")!;
    expect(seatA.critique).toEqual(["句长过于均匀", "对仗工整"]);
  });
});

describe("分数解析边界补深（b16@171 / 165 行）", () => {
  it("J1 空席位：同步抛「合议庭无席位」，不发起任何请求", async () => {
    await expect(judgeByPanel("x", [])).rejects.toThrow(/合议庭无席位/);
  });

  it("J2 三席混合：a 超范围分 150 落空抛错、b reasoning 兜底 62 且 scoreLineIdx=-1、c 正常 40", async () => {
    mockFetchBySeat({
      // content 末行 150：s<=100 落空 → 解析循环走完仍 null → 177 行抛「无有效分数」→ 错误席
      "gw-a": { content: "句长过于均匀\n150" },
      // content 无数字 → 解析落空；reasoning 含「62」→ 171 行 reasoning 兜底；
      // content 各行都不含数字 → scoreLineIdx=-1 → critique 取全部行
      "gw-b": { content: "过渡词残留\n用词重复", reasoning: "综合判断给出 62 分" },
      "gw-c": { content: "句长过于均匀\n40" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    // 有效票 62/40 → 加权中位 round((40+62)/2)=51；席间满分差 22；有效席 2
    expect(r.score).toBe(51);
    expect(r.spread).toBe(22);
    expect(r.validCount).toBe(2);
    const seatA = r.seats.find((s) => s.id === "a")!;
    expect(seatA.score).toBeNull();
    expect(seatA.error).toContain("无有效分数");
    const seatB = r.seats.find((s) => s.id === "b")!;
    expect(seatB.score).toBe(62); // reasoning 兜底
    // scoreLineIdx=-1 → 不截断，critique 取全部行（无分数行可剥离）
    expect(seatB.critique).toEqual(["过渡词残留", "用词重复"]);
    // 两票重合桶不存在（b 两票各一桶、c 一票）→ 不定罪
    expect(r.critique).toEqual([]);
  });

  /*
   * 覆盖注释（结构性说明，非用例）：
   * - b16@171（`score === null && r.reasoning`）的各子态：reasoning 真且含数字
   *   → J2 的 gw-b（reasoning 兜底 62）；reasoning 真但 match(/\d+/g) 为 null
   *   → J4；reasoning 为空串（falsy）→ J3；score 已在 content 解析命中 →
   *   本文件其余正常席用例。四条子态全部有实测用例覆盖。
   * - 165 行 `if (s >= 0 && s <= 100)` 的 `s >= 0` false 支结构性不可达：
   *   s 由 /^…(\d{1,3})…$/ 捕获组 parseInt 得来，\d 恒非负，s>=0 恒真——
   *   该支是防御性写法，测试无法（也不应）触达。
   */
  it("J3 content 与 reasoning 皆空：走 reasoning falsy 支 → 无有效分数错误席", async () => {
    mockFetchBySeat({
      "gw-a": { content: "句长过于均匀\n40" },
      "gw-b": { content: "", reasoning: "" },
      "gw-c": { content: "句长过于均匀\n44" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    expect(r.validCount).toBe(2);
    expect(r.score).toBe(42); // (40+44)/2
    const seatB = r.seats.find((s) => s.id === "b")!;
    expect(seatB.score).toBeNull();
    expect(seatB.error).toContain("无有效分数");
    expect(seatB.critique).toEqual([]);
  });

  it("J4 reasoning 非空但无数字：nums && nums.length 为 false → 仍抛「无有效分数」", async () => {
    mockFetchBySeat({
      "gw-a": { content: "句长过于均匀\n40" },
      // content 无数字行 → 解析落空；reasoning 真但不含任何数字 → 兜底支 false
      "gw-b": {
        content: "句长过于均匀",
        reasoning: "整体看下来很像真人写的，没有别的要补充",
      },
      "gw-c": { content: "句长过于均匀\n44" },
    });
    const r = await judgeByPanel("测试文本", SEATS);
    expect(r.validCount).toBe(2);
    expect(r.score).toBe(42);
    const seatB = r.seats.find((s) => s.id === "b")!;
    expect(seatB.score).toBeNull();
    expect(seatB.error).toContain("无有效分数");
  });
});
