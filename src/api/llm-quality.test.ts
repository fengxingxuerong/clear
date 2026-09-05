import { describe, it, expect, vi, afterEach } from "vitest";
import { localHardGate, processCandidate, coherenceIssues } from "./llm-quality";
import { buildRevisionPrompt } from "./llm-prompts";
import { ZHUQUE_DETECT_SYSTEM } from "./zhuque-semantic";
import { humanizeViaApiDeep } from "./llm-humanize";
import { DEFAULT_API } from "./llm-config";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 构造 n 个可见字符的句子（n 含句号） */
function sent(n: number): string {
  return "字".repeat(Math.max(1, n - 1)) + "。";
}

describe("localHardGate（本地指纹+忠实度硬门槛）", () => {
  it("数字被篡改必被抓（忠实度）", () => {
    const issues = localHardGate("营收增长23%，海外占比提升。", "营收增长32%，海外占比提升。");
    expect(issues.some((s) => s.includes("23"))).toBe(true);
  });

  it("垫词复读必被抓（指纹）", () => {
    const issues = localHardGate(
      "事情定下来了。",
      "说白了，这事就这么定。说白了，别再问了。",
    );
    expect(issues.some((s) => s.includes("指纹：") && s.includes("垫词复读"))).toBe(true);
  });

  it("统计型节奏指纹（CV 过平/标准差带）不进硬门槛，避免空烧 API", () => {
    // 6 句、句长 12/16/20/24/28/32：样本标准差 ≈6.9 落入 4.5~8.5 特征带，CV ≈0.31 偏平，
    // 但无任何硬指纹 → 门槛应放行（节奏问题交给评分修订收敛）
    const text = [12, 16, 20, 24, 28, 32].map(sent).join("");
    expect(localHardGate(text, text)).toEqual([]);
  });
});

describe("buildRevisionPrompt（篇章层定向修法）", () => {
  it("痕迹命中篇章层时附对应修法", () => {
    const p = buildRevisionPrompt("正文", 55, 10, ["论点骨架工整", "泛指主语空转"]);
    expect(p).toContain("对应修法");
    expect(p).toContain("段落重新切分"); // 骨架 → 重切段落
    expect(p).toContain("泛指主语"); // 指代 → 落地
  });

  it("无篇章层痕迹时不附修法块", () => {
    const p = buildRevisionPrompt("正文", 55, 10, ["中英间空格"]);
    expect(p).not.toContain("对应修法");
  });
});

describe("深度闭环 × 朱雀检测员提示词对齐", () => {
  it("评分请求使用 ZHUQUE_DETECT_SYSTEM，修订请求带定向修法", async () => {
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key" };
    const systems: string[] = [];
    const users: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        try {
          const body = JSON.parse(String(init?.body));
          const msgs: Array<{ role: string; content: string }> = body.messages ?? [];
          systems.push(msgs.find((m) => m.role === "system")?.content ?? "");
          users.push(msgs.find((m) => m.role === "user")?.content ?? "");
        } catch {
          /* 解析失败按通用响应处理 */
        }
        let content = "改写后的文本，人工智能改变了生活。就这样。";
        const sys = systems[systems.length - 1] ?? "";
        if (sys.includes("质检员")) content = "PASS";
        else if (sys.includes("复刻检测员")) content = "论点骨架工整\n42";
        return new Response(
          JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const r = await humanizeViaApiDeep("原文内容。", cfg, undefined, 10, 2);
    expect(r.text).not.toBe("");
    // 评分阶段走的是朱雀检测员提示词（篇章层），不是通用检测员
    expect(systems.some((s) => s === ZHUQUE_DETECT_SYSTEM)).toBe(true);
    // 评判痕迹「论点骨架工整」命中篇章修法，第 2 轮修订请求应携带「对应修法」
    expect(users.some((u) => u.includes("对应修法") && u.includes("段落重新切分"))).toBe(true);
    expect(r.roundScores).toEqual([42, 42]);
  });
});

describe("coherenceIssues（重排衔接断裂，v0.8.5）", () => {
  it("「其次」没有前半句 → 失散", () => {
    const issues = coherenceIssues("其次，成本也是要考虑的。总体不算贵。");
    expect(issues.some((s) => s.includes("衔接词失散") && s.includes("其次"))).toBe(true);
  });

  it("配对完整 / 无承接词 → 不报", () => {
    expect(coherenceIssues("首先，质量重要。其次，成本也要考虑。")).toEqual([]);
    expect(coherenceIssues("眼下，行业变化很快。谁也说不准下一步。")).toEqual([]);
  });

  it("开篇孤代词 → 报", () => {
    const issues = coherenceIssues("这就是为什么大家更愿意选它的原因。");
    expect(issues.some((s) => s.includes("开篇孤代词"))).toBe(true);
  });

  it("衔接断裂进 localHardGate（喂修复轮）", () => {
    const issues = localHardGate("原文内容。", "其次，价格便宜。别的都还行。");
    expect(issues.some((s) => s.includes("衔接词失散"))).toBe(true);
  });
});

describe("深度闭环调用预算（v0.8.5）", () => {
  it("超 maxApiCalls 后带最优结果收场，note 注明次数", async () => {
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key", maxApiCalls: 5 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const sys: string = body.messages?.[0]?.content ?? "";
        let content = "改写后的文本，人工智能改变了生活。就这样。";
        if (sys.includes("质检员")) content = "PASS";
        else if (sys.includes("复刻检测员")) content = "论点骨架工整\n42";
        return new Response(
          JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const r = await humanizeViaApiDeep("原文内容。", cfg, undefined, 10, 4);
    expect(r.text).not.toBe("");
    // 第一轮耗 5 次调用（改写+质检+评判×3），轮间触发预算 → 只有 1 轮分数
    expect(r.roundScores).toEqual([42]);
    expect(r.hitTarget).toBe(false);
    expect(r.note).toContain("调用上限 5 次");
  });
});

describe("processCandidate（硬门槛打回路径）", () => {
  it("LLM 质检放行但数字被改 → 本地硬门槛打回并进修复", async () => {
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key" };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const sys: string = body.messages?.[0]?.content ?? "";
        calls.push(sys);
        // 质检第一次放行（放走数字篡改稿），修复后仍由质检判定
        let content = "PASS";
        if (sys.includes("改写专家")) content = "改写稿：营收增长32%。";
        return new Response(
          JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const r = await processCandidate("原文：营收增长23%。", "改写稿：营收增长32%。", cfg, 0.6);
    expect(r.qc.pass).toBe(false);
    expect(r.score).toBeNull();
    expect(r.qc.issues.some((s) => s.includes("23"))).toBe(true);
    // 触发了一次修复请求（修复提示词 = 改写专家 system + 打回清单 user）
    expect(calls.filter((s) => s.includes("改写专家")).length).toBeGreaterThan(0);
  });
});