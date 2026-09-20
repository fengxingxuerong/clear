import { describe, it, expect, vi, afterEach } from "vitest";
import {
  localHardGate,
  processCandidate,
  coherenceIssues,
  fabricationIssues,
  truncationIssues,
  fabricationReview,
  deletionStubIssues,
  inflationIssues,
  structureIssues,
  addedContentSignals,
} from "./llm-quality";
import { fingerprintCheck, humanize } from "../engine/humanize";
import { restoreMixedSpacing } from "../engine/humanize-shuffle";
import { buildRevisionPrompt } from "./llm-prompts";
import { ZHUQUE_DETECT_SYSTEM } from "./zhuque-semantic";
import { humanizeViaApiDeep } from "./llm-humanize";
import { DEFAULT_API } from "./llm-config";

/** OpenAI 兼容响应 mock（同 llm.test.ts） */
function okJson(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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
    const issues = localHardGate("事情定下来了。", "说白了，这事就这么定。说白了，别再问了。");
    expect(issues.some((s) => s.includes("指纹：") && s.includes("垫词复读"))).toBe(true);
  });

  it("统计型节奏指纹（CV 过平/标准差带）不进硬门槛，避免空烧 API", () => {
    // 6 句、句长 12/16/20/24/28/32：样本标准差 ≈6.9 落入 4.5~8.5 特征带，CV ≈0.31 偏平，
    // 但无任何硬指纹 → 门槛应放行（节奏问题交给评分修订收敛）
    const text = [12, 16, 20, 24, 28, 32].map(sent).join("");
    expect(localHardGate(text, text)).toEqual([]);
  });

  it("末句无句读（截断稿）必被抓（v0.9.4 完结性守卫）", () => {
    // 2026-09-12 实测 s3 事故签名：R3 输出被 token 截断，末句悬在名词上
    const original = sent(30) + sent(28) + sent(26);
    const truncated = "大语言模型这两年挺火，但不是没毛病。训练费";
    const issues = localHardGate(original, truncated);
    expect(issues.some((s) => s.includes("末句未完结"))).toBe(true);
  });

  it("严重缩水（< 原文 40%）必被抓，正常压缩（60%）不误杀", () => {
    const original = Array.from({ length: 10 }, () => sent(12)).join("");
    // 候选只剩 2 句（20% < 40%）：即使句读完整也判严重缩水
    const shrunken = sent(12) + sent(12);
    const issues = localHardGate(original, shrunken);
    expect(issues.some((s) => s.includes("严重缩水"))).toBe(true);
    // 候选保留 6 句（60%）：正常压缩带内，完结性守卫不应报任何问题
    const normal = Array.from({ length: 6 }, () => sent(12)).join("");
    const truncRelated = localHardGate(original, normal).filter(
      (s) => s.includes("末句未完结") || s.includes("严重缩水"),
    );
    expect(truncRelated).toEqual([]);
  });

  it("truncationIssues：空候选直接报空稿", () => {
    expect(truncationIssues(sent(10), "   ").some((s) => s.includes("候选稿为空"))).toBe(true);
  });

  it("deletionStubIssues：删减残留孤词句（v0.9.5 P4）", () => {
    const original = "数字化转型是构建企业核心竞争力的必由之路。这条路要走很久。";
    // 直测：实测 s3 事故——修订轮把首句删剩「竞争力。」孤词
    //（原文中「竞争力」前邻「心」非句读 = 被截断残片）
    expect(deletionStubIssues(original, "竞争力。这条路要走很久。").length).toBe(1);
    // 误伤检查：原文里本就独立的短句不报（「这条路要走很久」>6 字超限）；
    // 原文没有的词（「别急」）不报
    expect(deletionStubIssues(original, "这条路要走很久。别急。")).toHaveLength(0);
  });

  it("deletionStubIssues：删减残留孤词句（v0.9.5 P4）", () => {
    const original = "数字化转型是构建企业核心竞争力的必由之路。这条路要走很久。";
    // 实测 s3 事故：修订轮把首句删剩「竞争力。」孤词 → localHardGate 应报
    const issues = localHardGate(original, "数字化这事要紧。竞争力。这条路要走很久。");
    expect(issues.some((s) => s.includes("删减残留"))).toBe(true);
    // 原文里本就独立的短句不误伤
    const clean = localHardGate(original, "数字化转型是必由之路。这条路要走很久。别犹豫。");
    expect(clean.some((s) => s.includes("删减残留"))).toBe(false);
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
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
describe("质检通道异常可见化（v0.8.6）", () => {
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k" };

  it("质检 API 整体挂掉时放行，但 issues 留痕", async () => {
    // 404 不触发换 Key / 退避，llm-chat 直接抛错——processCandidate 质检通道进 catch
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const r = await processCandidate("原文：营收增长23%。", "改写稿：营收增长23%。", cfg, 0.6);
    expect(r.qc.pass).toBe(true); // 防停摆：放行
    expect(r.qc.issues.join("")).toContain("质检通道异常"); // 可见化：留痕
    // 评分阶段同样失败：score 为 null 但不抛错（调用方兜底已有测试覆盖）
    expect(r.score).toBeNull();
  });
});

describe("编造兜底（v0.8.9）", () => {
  // 实测 LLM 为求"接地气"现编人物与经历，而 LLM 质检对此类漏判严重（只抓得住数字/术语）
  const orig = "人工智能提升了生产效率，也带来就业结构变化。";

  it("改写稿凭空出现第一人称经历/亲属 → 判定编造", () => {
    const bad = "人工智能提升了生产效率。我舅去年体检查出结节，我们公司还招了三个数据标注的。";
    expect(fabricationIssues(orig, bad)).toHaveLength(1);
    expect(fabricationIssues(orig, bad)[0]).toContain("疑似编造");
  });

  it("原文本就有的表述不算编造（不误伤真人原稿）", () => {
    const origHas = "我朋友在厂里做质检，我妈也说这东西方便。人工智能提升了生产效率。";
    const out = "人工智能真提升了生产效率。我朋友在厂里做质检，我妈也说这东西方便。";
    expect(fabricationIssues(origHas, out)).toHaveLength(0);
  });

  it("localHardGate 已并入编造检查", () => {
    const bad = "人工智能提升了生产效率。有一次我去医院，我邻居家孩子数学不好。";
    expect(localHardGate(orig, bad).some((i) => i.includes("疑似编造"))).toBe(true);
  });
});

describe("fabricationReview 编造专项复核（v0.9.4 P1.5）", () => {
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key", judgeModel: "glm-5.2" };
  const orig = "数字化转型能提升运营效率。率先完成布局的企业往往能抢占先机。";

  function stubReviewer(reply: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const sys: string = body.messages?.[0]?.content ?? "";
        // 编造审查员的 system 以「你是事实核查员」开头，与其他角色区分
        if (sys.includes("事实核查员")) return okJson(reply);
        // 其他角色（质检员等）一律 PASS，保证只测审查员解析逻辑
        return okJson("PASS");
      }),
    );
  }

  it("正常 JSON：提取编造清单", async () => {
    stubReviewer(
      '{"fabrications": ["「我踩过不少坑」：原文无此经历", "「一定」：原文为往往，概率变绝对"]}',
    );
    const fabs = await fabricationReview(
      orig,
      "数字化转型能提升运营效率。我踩过不少坑，率先布局的一定占先机。",
      cfg,
    );
    expect(fabs).toHaveLength(2);
    expect(fabs[0]).toContain("我踩过不少坑");
  });

  it("JSON 前后带说明文字：容错提取", async () => {
    stubReviewer('好的，核查结果如下：\n{"fabrications": []}\n以上就是全部结论。');
    const fabs = await fabricationReview(orig, "改写稿内容。", cfg);
    expect(fabs).toEqual([]);
  });

  it("JSON 内含花括号与引号转义：状态机不被内容截断", async () => {
    stubReviewer(
      '{"fabrications": ["改写稿新增「{方法论}体系」：原文无，且引号内出现\\"嵌套\\""]}',
    );
    const fabs = await fabricationReview(orig, "改写稿内容。", cfg);
    expect(fabs).toHaveLength(1);
  });

  it("模型输出垃圾文本：抛错（由调用方降级跳过）", async () => {
    stubReviewer("我觉得这份改写稿没什么问题，不需要修改。");
    await expect(fabricationReview(orig, "改写稿内容。", cfg)).rejects.toThrow("未返回有效 JSON");
  });
});

describe("processCandidate（修复成功路径）", () => {
  it("修复稿必须接管交付与评分（回归：旧实现返回被打回的那一稿）", async () => {
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "test-key" };
    const reqs: { sys: string; user: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const msgs = JSON.parse(String(init?.body)).messages ?? [];
        const sys: string = msgs[0]?.content ?? "";
        const user: string = msgs[1]?.content ?? "";
        reqs.push({ sys, user });
        let content = "PASS"; // 质检默认放行
        if (sys.includes("改写专家"))
          content = "改写稿：营收增长23%，海外占比提升。"; // 修好了
        else if (sys.includes("复刻检测员")) content = "句长过于均匀\n18"; // 评分行
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const r = await processCandidate(
      "原文：营收增长23%，海外占比提升。",
      "改写稿：营收增长32%，海外占比提升。",
      cfg,
      0.6,
    );
    expect(r.qc.pass).toBe(true);
    // 交付的是修复稿，而不是被本地硬门槛打回的数字篡改稿
    expect(r.shuffled).toContain("23%");
    expect(r.shuffled).not.toContain("32%");
    // 评委评的也必须是最终交付那一稿。判别词要取检测员提示词独有的「复刻检测员」：
    // "质检员"提示词含"检测员"字样，而改写专家提示词里也提到"朱雀"，两者都会串台
    const judge = reqs.find((q) => q.sys.includes("复刻检测员"));
    expect(judge?.user).toContain("23%");
    expect(judge?.user).not.toContain("32%");
    expect(r.score).toBe(18);
  });
});

describe("空格口径必须与硬门槛一致（v0.8.8「空格跟随原文排版」）", () => {
  const orig = "本文使用 GPT-4 模型处理 1750 亿参数，实测准确率为 92.5%。";
  const tight = "这篇拿GPT-4跑了1750亿参数，准确率实测92.5%，效果还行。";

  it("回填造出的空格不得进否决理由——否则每个候选都必死", () => {
    const restored = restoreMixedSpacing(orig, tight);
    // 先确认前提成立：回填确实造出了空格把柄，否则这条测试没在测东西
    expect(fingerprintCheck(restored).issues.some((i) => i.name === "中英数字间空格")).toBe(true);
    // 但它不能成为打回理由：processCandidate 先补齐再打门槛，豁免前每个候选都被判死
    expect(localHardGate(orig, restored).filter((s) => s.includes("空格"))).toEqual([]);
  });

  it("原文本身无空格时不得凭空造出空格（回填触发条件仍是 1 处）", () => {
    const noSpace = "这篇拿GPT-4跑了1750亿参数，效果还行。";
    expect(restoreMixedSpacing(noSpace, noSpace)).toBe(noSpace);
  });
});

/**
 * v0.9.14 编造复核的取值口径：chat() 把正文与 reasoning 分开返回、不合并，
 * 只读 content 会让一次输出位置偏移变成"复核失败"——候选期=静默丢稿，终审=静默放行。
 * 兜底与 qualityCheck（本文件 :52）同口径。
 */
describe("fabricationReview 取值兜底（v0.9.14）", () => {
  const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", judgeModel: "glm-5.2" };
  const resp = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("JSON 只在 reasoning 里也要能解析出编造项", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        resp({
          choices: [
            {
              message: {
                content: "",
                reasoning_content: '{"fabrications":["裸机450克：原文无此限定"]}',
              },
            },
          ],
        }),
      ),
    );
    const fabs = await fabricationReview("重量仅为450克。", "裸机450克，放包里不沉。", cfg);
    expect(fabs).toEqual(["裸机450克：原文无此限定"]);
  });

  it("两处都没有 JSON 才抛错（调用方据此说明「未做否决」）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resp({ choices: [{ message: { content: "我看没有新增" } }] })),
    );
    await expect(fabricationReview("原文。", "改写。", cfg)).rejects.toThrow(/未返回有效 JSON/);
  });
});

/* ─────────── v0.9.14 增殖守卫 + 新增内容披露 ───────────
 * 阈值不是拍的，来自实测：真 LLM 深度产物 9 份长度比 58%~113%（合法上限 113%），
 * 本地引擎 225 次最大 100%，异常样本 artifacts/deai-test/out/s1-议论文.llm-deep.txt = 250%。
 * 所以硬线 150%、110~150% 只披露。下面全部用这些真实数字当夹具。
 */
describe("inflationIssues：增殖守卫（truncationIssues 缺的半边）", () => {
  const ORIG = "数字化转型提升了效率。".repeat(20); // 220 字
  const rep = (src: string, times: number) => src.repeat(times);

  it("250% 的稿子（实测异常样本的比例）必须被打回", () => {
    const inflated = rep(ORIG, 5); // 500%
    const r = inflationIssues(ORIG, inflated);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("信息增殖");
  });

  it("113% 的合格稿不得误杀（实测合法上限）", () => {
    const base = "这段内容讲的是行业变化。".repeat(30); // 420 字
    const grown = base + "补充了一句背景说明。".repeat(6); // ≈110~115%
    const ratio = grown.replace(/\s/g, "").length / base.replace(/\s/g, "").length;
    expect(ratio).toBeLessThanOrEqual(1.5);
    expect(inflationIssues(base, grown)).toEqual([]);
  });

  it("必须真接在 localHardGate 上（只定义不接线等于没有）", () => {
    const issues = localHardGate(ORIG, rep(ORIG, 4));
    expect(issues.some((i) => i.includes("信息增殖"))).toBe(true);
  });

  it("本地引擎产物一律不得触发（它是只换词不增词的参照系）", () => {
    for (const src of [
      "值得注意的是，随着人工智能技术的发展，相关工具应运而生。综上所述，效率得到了提升。",
      "张总：这个季度的指标完成得怎么样了？李工：主流程已经联调完毕。",
    ]) {
      for (const [intensity, zhuque] of [
        [0.6, false],
        [0.9, true],
        [1, true],
      ] as [number, boolean][]) {
        for (let seed = 0; seed < 8; seed++) {
          const o = humanize(src, { intensity, zhuqueMode: zhuque, seed });
          expect(inflationIssues(src, o)).toEqual([]);
        }
      }
    }
  });
});

describe("addedContentSignals：新增内容只披露、不否决", () => {
  it("凭空多出 16 处第一人称 → 必须说出来（s1 实测值）", () => {
    const orig = "AI 工具改变了工作方式。".repeat(10);
    const out =
      orig +
      "我家楼下的快递柜".repeat(4) +
      "我认识一个做质检的老哥".repeat(4) +
      "我朋友说可以".repeat(8);
    const sig = addedContentSignals(orig, out);
    expect(sig.some((x) => x.includes("第一人称"))).toBe(true);
  });

  it("正常改写（第一人称 +1）不得报警，避免把口语化误当编造", () => {
    const orig = "这个方案能提升效率。".repeat(12);
    const out = orig + "我觉得还行。";
    expect(addedContentSignals(orig, out).some((x) => x.includes("第一人称"))).toBe(false);
  });

  it("110%~150% 这段给提示但不否决", () => {
    const base = "内容略。".repeat(100); // 200 字
    const grown = base + "追加一点。".repeat(12); // ≈130%
    const sig = addedContentSignals(base, grown);
    expect(sig.some((x) => x.includes("篇幅"))).toBe(true);
    expect(inflationIssues(base, grown)).toEqual([]);
  });
});

describe("inflationIssues 的规模下限（被既有测试抓出来后钉住）", () => {
  it("原文只有 5 字时不得按比例否决（短句补全是正常现象）", () => {
    // 这正是接入后第一个撞红的既有夹具：原文 5 字、mock 改写 21 字 = 420%
    expect(inflationIssues("挺好的", "这个方案确实挺好的，用起来也方便。")).toEqual([]);
  });
  it("比例超线但绝对增量不足 60 字时也不否决", () => {
    const orig = "这段文字讲行业变化。".repeat(5); // 60 字，刚好过下限
    const out = orig + "补一句。".repeat(5); // 80 字 = 133%，增量 20
    expect(inflationIssues(orig, out)).toEqual([]);
  });
  it("三条件齐备才否决（对照 s1 实测：391→977）", () => {
    const orig = "行业正在发生变化，企业需要适应新的节奏。".repeat(10); // 200 字
    const out = orig.repeat(3) + "另外我还认识几个做这行的朋友，去年聊过。".repeat(4);
    expect(inflationIssues(orig, out).length).toBe(1);
  });
});
/**
 * v0.9.14 #30：LLM 通道的结构元素保真。
 * 触发是一次真跑批：D0-对话原文交付稿把 `【场景：…】` 整行删了、说话人职务标注 4→0，
 * 而闭环评委判它 6 分「达标」。本地引擎早就有 P8 场景块保真，LLM 通道没有对应的那一半。
 */
describe("structureIssues（结构元素点数）", () => {
  const SCENE_SRC = [
    "【场景：一家创业公司的会议室，周一上午的项目周会】",
    "张总（项目经理）：大家早上好，今天开周会。",
    "李工（前端负责人）：前端进展顺利，核心页面都完成了。",
  ].join("\n");

  it("场景块整行消失 → 红（D0 实测形态）", () => {
    const out = "张总：大家早上好。\n李工：前端挺顺利的。";
    expect(structureIssues(SCENE_SRC, out).join(" / ")).toMatch(/场景块/);
  });

  it("说话人职务标注从有到全无 → 红；还留着一个 → 绿（宁放不误杀）", () => {
    // 夹具不带场景块行，单独测"职务标注"这一维（否则场景块那条会一起红）
    const ROLE_SRC = "张总（项目经理）：大家早上好。\n李工（前端负责人）：前端进展顺利。";
    const allGone = "张总：大家早上好。\n李工：前端进展顺利。";
    expect(structureIssues(ROLE_SRC, allGone).join(" ")).toMatch(/职务标注/);
    const keepOne = "张总（项目经理）：大家早上好。\n李工：前端进展顺利。";
    expect(structureIssues(ROLE_SRC, keepOne)).toEqual([]);
  });

  it("Markdown 标题被吃掉 → 红", () => {
    const src = "## 一、现状\n内容若干。\n## 二、对策\n内容若干。";
    expect(structureIssues(src, "现状是这样。对策是那样。").join(" ")).toMatch(/标题/);
  });

  /**
   * 这条是**范围声明**：列举标记（首先 / 一是 / 1.）是引擎主动拆的
   * （breakEnumerationStructure、总结类过渡词直删都是核心去味手段），
   * 结构守卫一旦去数它们，就会和去味本身打架，把合格稿全部判死。
   * 所以这里必须绿。
   */
  it("列举标记被拆掉必须**不**红——守卫不许和去味设计打架", () => {
    const src = "具体来说：首先，加大投入；其次，治理数据；最后，培养人才。";
    const out = "加大投入这件事得先做，数据治理也得跟上，人才更是绕不开。";
    expect(structureIssues(src, out)).toEqual([]);
  });

  it("空稿/空原文不崩", () => {
    expect(structureIssues("", "abc")).toEqual([]);
    expect(structureIssues("abc", "")).toEqual([]);
    expect(structureIssues("abc", "   ")).toEqual([]);
  });

  it("必须真接在 localHardGate 上（防只定义不接线）", () => {
    const out = "张总：早。\n李工：顺利。";
    expect(localHardGate(SCENE_SRC, out).join(" / ")).toMatch(/结构丢失/);
  });
});
