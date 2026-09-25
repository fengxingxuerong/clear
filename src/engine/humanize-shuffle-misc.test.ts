/**
 * humanize-shuffle 结构级去味函数的行为锁测试（v0.9.16 测试迭代补盲）。
 *
 * 此前这些导出没有任何直接测试（覆盖率 0% 的重灾区）：
 *  - breakSummaryTail（总分总骨架拆解）
 *  - injectSelfQA（自问自答注入）
 *  - dismantleExpositionTrilogy（论述三部曲拆毁）
 *  - classifyExpositionScore（论说文概率分）
 *  - preDetectHumanFingerprint（纯人写原稿预检，H0 降级依据）
 *
 * 全部用确定性 rng（固定值/固定序列）锁行为，不做随机性断言。
 */
import { describe, expect, it } from "vitest";
import {
  breakSummaryTail,
  classifyExpositionScore,
  dismantleExpositionTrilogy,
  injectSelfQA,
  preDetectHumanFingerprint,
} from "./humanize-shuffle.ts";

/** 固定 rng：所有概率分支都命中（0 < x < 1 的"中间"行为） */
const rngMid = () => 0.5;
/** 固定 rng：高值（>0.8 的概率分支不命中） */
const rngHigh = () => 0.95;

describe("breakSummaryTail（总分总骨架拆解）", () => {
  it("少于 4 句原样返回", () => {
    const sents = ["正文一。", "正文二。", "综上所述，就这么回事。"];
    expect(breakSummaryTail(sents, rngMid, 0.9)).toEqual({ sentences: sents });
  });

  it("强度 < 0.5 原样返回（轻度档不破坏结构）", () => {
    const sents = ["一。", "二。", "三。", "综上所述，完。"];
    expect(breakSummaryTail(sents, rngMid, 0.4)).toEqual({ sentences: sents });
  });

  it("末句无总结签名原样返回", () => {
    const sents = ["一。", "二。", "三。", "今天天气不错。"];
    expect(breakSummaryTail(sents, rngMid, 0.9)).toEqual({ sentences: sents });
  });

  it("命中「综上所述」：总结句被移出末尾、句子数守恒", () => {
    const sents = ["第一点说成本。", "第二点说良率。", "第三点说交付。", "综上所述，这方案可行。"];
    const { sentences: out } = breakSummaryTail(sents, rngMid, 0.9);
    expect(out).toHaveLength(4);
    expect(out[out.length - 1]).not.toContain("综上所述");
    // 内容守恒：句子集合不变，只是位置移动
    expect([...out].sort()).toEqual([...sents].sort());
  });

  it("强度 ≥ 0.75 且 ≥ 5 句：额外返回分段的 splitAfter", () => {
    const sents = ["一。", "二。", "三。", "四。", "五。", "总而言之，就是这些。"];
    const { sentences: out, splitAfter } = breakSummaryTail(sents, rngMid, 0.8);
    expect(out).toHaveLength(6);
    expect(splitAfter).toBeDefined();
    expect(splitAfter!).toBeGreaterThan(0);
    expect(splitAfter!).toBeLessThan(out.length);
  });
});

describe("injectSelfQA（自问自答注入）", () => {
  const base = ["一句开头。", "二句展开。", "三句补充。", "四句收着。", "五句再收。", "六句收尾。"];

  it("强度 < 0.65 原样返回", () => {
    expect(injectSelfQA(base, rngMid, 0.6)).toEqual(base);
  });

  it("少于 5 句原样返回", () => {
    const few = base.slice(0, 4);
    expect(injectSelfQA(few, rngMid, 0.9)).toEqual(few);
  });

  it("academic 体裁兜底拦禁（模板池为空）", () => {
    expect(injectSelfQA(base, rngMid, 0.9, "academic")).toEqual(base);
  });

  it("casual 命中：全文只注入 1 次（预算=1），输出长度 +1 且有新句", () => {
    const out = injectSelfQA(base, rngMid, 0.8);
    expect(out).toHaveLength(base.length + 1);
    // 注入的是「问+答」合并句，问答绑定不被拆散（模板可能不带「？」，如反问杠精体）
    const injected = out.filter((s) => !base.includes(s));
    expect(injected).toHaveLength(1);
    expect(injected[0].length).toBeGreaterThan(6);
  });

  it("确定性：同 rng 同输入输出完全一致", () => {
    expect(injectSelfQA(base, rngMid, 0.8)).toEqual(injectSelfQA(base, rngMid, 0.8));
  });
});

describe("dismantleExpositionTrilogy（论述三部曲拆毁）", () => {
  it("强度 < 0.7 原样返回", () => {
    const sents = ["首先，成本低。", "其次，良率高。", "最后，交付快。"];
    expect(dismantleExpositionTrilogy(sents, rngMid, 0.6)).toEqual(sents);
  });

  it("触发句不足 3 条原样返回（避免半拆毁）", () => {
    const sents = ["首先，成本低。", "其次，良率高。", "这句没有触发词。"];
    expect(dismantleExpositionTrilogy(sents, rngMid, 0.9)).toEqual(sents);
  });

  it("三部曲命中：三条分别改造且顺序保持（不打乱论述链）", () => {
    const sents = [
      "首先，成本很低。",
      "其次，良率不错。",
      "最后，大家都很满意。",
      "这句话没有触发词。",
    ];
    const out = dismantleExpositionTrilogy(sents, rngMid, 0.9);
    // 长度守恒、非触发句不动
    expect(out).toHaveLength(4);
    expect(out[3]).toBe(sents[3]);
    // 第 1 条：第一人称经验插叙头替换「首先」，不再以触发词开头
    expect(out[0]).not.toMatch(/^首先/);
    expect(out[0]).not.toBe(sents[0]);
    // 第 2 条：反事实/半否定头替换「其次」
    expect(out[1]).not.toMatch(/^其次/);
    expect(out[1]).not.toBe(sents[1]);
    // 第 3 条（rngMid=0.5 < 0.8）：句号被替换为「人读累了的过渡短语」，不再以「最后」开头
    expect(out[2]).not.toMatch(/^最后/);
    expect(out[2]).not.toBe(sents[2]);
    // 顺序保持原文（v0.9 专家修复 P1：不再打乱）
    expect(out[0]).toContain("成本很低");
    expect(out[1]).toContain("良率不错");
    expect(out[2]).toContain("大家都很满意");
  });

  it("rng 高值（≥0.8）：第 3 条仅去触发词、不加尾短语", () => {
    const sents = ["首先，成本低。", "其次，良率高。", "最后，交付快。", "无触发词。"];
    const out = dismantleExpositionTrilogy(sents, rngHigh, 0.9);
    expect(out[2]).toBe("，交付快。".slice(1)); // replace(TRIGGER,"") 只留正文
  });
});

describe("classifyExpositionScore（论说文概率分）", () => {
  it("空文本 / 过短文本返回 0", () => {
    expect(classifyExpositionScore("")).toBe(0);
    expect(classifyExpositionScore("短文本。")).toBe(0);
  });

  it("论说强词密集的长文本得高分（≥0.55）", () => {
    const body =
      "综上所述，成本可控。研究表明，良率稳定。数据显示，交付提前。综上所述，风险很小。" +
      "研究表明，产能足够。数据显示，客户满意。综上所述，方案可行。研究表明，质量达标。" +
      "数据显示，口碑良好。综上所述，值得推进。研究表明，收益明显。数据显示，损耗下降。";
    expect(body.replace(/\s/g, "").length).toBeGreaterThanOrEqual(120);
    expect(classifyExpositionScore(body)).toBeGreaterThanOrEqual(0.55);
  });

  it("对话体标记≥2 处被强惩罚（-0.45）", () => {
    const narrative =
      "这一天天气很好，阳光洒在地上，风从窗外吹进来，街上有孩子在跑，狗在叫，一切都慢悠悠的。" +
      "他走出门，看到邻居在浇花，点点头，继续往前走，心里想着晚上吃什么，脚步轻快了不少。" +
      "【场景：老街黄昏】张三：你来了。李四：嗯，刚到。两人并肩走进巷子，谁也没再说话，巷子很深。";
    // 对话标记 2 处 + 无论说词 → score 接近 0
    expect(classifyExpositionScore(narrative)).toBeLessThan(0.2);
  });

  it("结果恒被夹在 [0,1] 区间", () => {
    const heavy =
      "综上所述综上所述综上所述综上所述综上所述综上所述综上所述综上所述综上所述综上所述" +
      "研究表明研究表明研究表明研究表明数据显示数据显示数据显示数据显示基于以上分析基于以上分析" +
      "白皮书显示报告显示综上所述研究显著综上所述基于以上分析以上数据充分说明结论已经非常清楚" +
      "以上各点综合起来看结论不言自明以上分析表明以上情况说明基于以上分析可以得出结论";
    const s = classifyExpositionScore(heavy);
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

describe("preDetectHumanFingerprint（H0 纯人写预检）", () => {
  it("过短文本：全零 report 且不判人写", () => {
    const r = preDetectHumanFingerprint("太短了。");
    expect(r.isHumanHand).toBe(false);
    expect(r.hits).toBe(0);
    expect(r.metrics.burstiness).toBe(0);
  });

  it("H0 分支 A：高人称密度 + 段首参差 + 短句占比 → 判纯人写", () => {
    const p1 =
      "我散步。我们昨天去了老街。你猜怎么着？巷口那家面馆换了招牌。我们几个人一起去的，我说味道不错，你说确实，我们都笑了。";
    const p2 =
      "我记得那年夏天，我们一起去了河边，你笑着说我像个孩子，跑来跑去没有停过。我后来还想过很多次，那天的风很舒服，我们在桥上看了很久的夕阳，你说下次还来。";
    const p3 =
      "我说好，我们都记住了这句话，后来真的又去了几次，每次都想起那天。我散步。我们昨天去了老街。你猜怎么着？巷口那家面馆换了招牌。";
    const base = [p1, p2, p3].join("\n\n");
    const text = `${base}\n\n${base}`; // 6 段、≈640 字：perK 与 leadCV 双达标
    const r = preDetectHumanFingerprint(text);
    expect(r.metrics.personPronPerK).toBeGreaterThanOrEqual(50);
    expect(r.metrics.paraLeadCV).toBeGreaterThanOrEqual(0.25);
    expect(r.metrics.shortRatio).toBeGreaterThanOrEqual(0.08);
    expect(r.isHumanHand).toBe(true);
    expect(r.hits).toBeGreaterThanOrEqual(3);
  });

  it("标准 AI 论说文：不判纯人写（允许继续反检测改造）", () => {
    const ai =
      "综上所述，数字化转型已经成为企业发展的必由之路。研究表明，数字化水平与经营效率之间存在显著的正相关关系。" +
      "数据显示，率先完成数字化改造的企业在成本控制与市场响应速度上均具备明显优势。基于以上分析，企业应当制定清晰的战略。" +
      "综上所述，推进数字化需要组织层面的配合。研究表明，管理层的支持程度直接影响转型成效。数据显示，组织架构的调整同样不可忽视。" +
      "基于以上分析，人才培养与制度建设需要同步进行，从而保证转型成果能够长期巩固，形成持续的竞争优势与良性循环。";
    const r = preDetectHumanFingerprint(ai);
    expect(r.isHumanHand).toBe(false);
  });
});
