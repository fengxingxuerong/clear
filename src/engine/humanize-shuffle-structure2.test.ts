/**
 * humanize-shuffle 结构层第二轮行为锁（v0.9.16 测试迭代第三轮）：
 *  - structuralShuffleParagraph（P0~P3 编排主链路）
 *  - hardNumberedEnumerationShuffle（P3-2 硬编号列举拆毁）
 *  - enforceParagraphLeadSentVariance（P3-3 段首句长强制方差）
 *  - boostBurstinessIfLow（P4-B 低 CV 节奏补药）
 *
 * ⚠️ 已知实现偏差（测试记录，不钉死为规范，修复需过标定棘轮评估）：
 *  hardNumberedEnumerationShuffle 头注释宣称支持「1. / (2) / 第三： / ① xxx」，
 *  但 NUM 正则实际只干净匹配「二、」式中文编号——
 *    · "1. xxx"  → NUM 只吃 "1"，replace 残留 ". xxx"
 *    · "(2) xxx" → 只吃 "(2"，残留 ") xxx"
 *    · "第三：xxx" / "① xxx" → 完全不匹配（"第"不在前缀白名单、圈号后要求标点）
 *  修复会改变引擎输出字节 → 触发 aiScore x 轴漂移（README 棘轮警告），须统一评估。
 */
import { describe, expect, it } from "vitest";
import {
  boostBurstinessIfLow,
  enforceParagraphLeadSentVariance,
  hardNumberedEnumerationShuffle,
  structuralShuffleParagraph,
} from "./humanize-shuffle.ts";

const rngMid = () => 0.5;
const rngLow = () => 0.4;
const rngHigh = () => 0.95;

/** 独立语气锚判定（与实现同口径）：纯语气短句 */
const isStandaloneAnchor = (s: string) =>
  /^(?:对哦|是啊|好吧|[嗯嗨诶咳呵啧呣哦啊行])[。！？!?…]*$/.test(s.trim());

describe("structuralShuffleParagraph（P0~P3 编排主链路）", () => {
  it("强度 < 0.5 原样返回", () => {
    const p = "第一句内容。第二句内容。第三句内容。";
    expect(structuralShuffleParagraph(p, rngMid, 0.4)).toBe(p);
  });

  it("不足 3 句原样返回", () => {
    const p = "第一句内容。第二句内容。";
    expect(structuralShuffleParagraph(p, rngMid, 0.9)).toBe(p);
  });

  it("论说段 + 朱雀增强：三部曲触发词被清除、内容词保留、非空", () => {
    // 每句含强词（研究表明/数据显示）保证 expoScore ≥ 0.55 → runP3
    const p =
      "首先，研究表明这套方案在成本上相当划算。" +
      "其次，数据显示产线的良率一直都比较稳定。" +
      "最后，从交付周期来看节奏也完全能保证。" +
      "以上就是这次汇报的全部内容了。";
    const out = structuralShuffleParagraph(p, rngMid, 0.9, { zhuqueMode: true });
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/^[首先]/m); // 无行以触发词起头
    expect(out).not.toContain("首先，");
    expect(out).not.toContain("其次，");
    expect(out).not.toContain("最后，");
    expect(out).toContain("划算");
    expect(out).toContain("稳定");
  });

  it("总分总段 + 高强度：返回拆成两段（含空行）", () => {
    const p =
      "成本这一块其实比较好算。良率的表现也算稳定。交付的节奏同样跟得上。风险的部分有兜底。客户的反馈也一直不错。综上所述，这个方案整体是可行的。";
    const out = structuralShuffleParagraph(p, rngMid, 0.8);
    expect(out).toContain("\n\n");
  });

  it("确定性：同 rng 同输入输出一致", () => {
    const p =
      "成本这一块其实比较好算。良率的表现也算稳定。交付的节奏同样跟得上。风险的部分有兜底。客户的反馈也一直不错。综上所述，这个方案整体是可行的。";
    expect(structuralShuffleParagraph(p, rngMid, 0.8)).toBe(
      structuralShuffleParagraph(p, rngMid, 0.8),
    );
  });
});

describe("hardNumberedEnumerationShuffle（P3-2 硬编号拆毁）", () => {
  it("强度 < 0.7 原样返回", () => {
    const sents = ["开头一句。", "二、良率不错。", "三、成本很低。"];
    expect(hardNumberedEnumerationShuffle(sents, rngMid, 0.6)).toEqual(sents);
  });

  it("编号命中不足 2 条原样返回", () => {
    const sents = ["开头一句。", "二、良率不错。", "无编号的一句。"];
    expect(hardNumberedEnumerationShuffle(sents, rngMid, 0.9)).toEqual(sents);
  });

  it("三条中文编号（rngMid）：首条括号化挪邻句、次条改反问、三条挪段尾", () => {
    const sents = ["开头一句话。", "二、良率不错。", "三、成本很低。", "四、交付很快。"];
    const out = hardNumberedEnumerationShuffle(sents, rngMid, 0.9);
    // 空串被过滤，独立编号句消失
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("开头一句话。");
    expect(out[0]).toContain("顺便提一句——良率不错"); // 第 1 条括号化挪到前导句尾
    expect(out[1]).toContain("成本很低");
    expect(out[1]).toContain("是不是这个道理？"); // 第 2 条改反问
    expect(out[2].startsWith("还有个小尾巴：")).toBe(true); // 第 3 条挪段尾
    expect(out[2]).toContain("交付很快");
  });

  it("rng 高值：A/B 概率分支不触发，仅 C 无条件挪尾", () => {
    const sents = ["开头一句话。", "二、良率不错。", "三、成本很低。", "四、交付很快。"];
    const out = hardNumberedEnumerationShuffle(sents, rngHigh, 0.9);
    // C 只挪走第 3 条（原位清空 + 段尾新增），其余三条原样 → 4 句
    expect(out).toHaveLength(4);
    expect(out[3].startsWith("再多嘴一句哈，")).toBe(true);
    expect(out[3]).toContain("交付很快");
    expect(out[0]).toContain("开头一句话。");
  });

  it("已知偏差记录：NUM 不匹配「第三：」与「① 」（与头注释宣称的格式集不符）", () => {
    const sents = ["第三：成本很低。", "① 良率不错。"];
    // 若未来修复此偏差，本用例会红——请同步评估输出字节变化对标定棘轮的影响
    expect(hardNumberedEnumerationShuffle(sents, rngMid, 0.9)).toEqual(sents);
  });
});

describe("enforceParagraphLeadSentVariance（P3-3 段首方差）", () => {
  const paraA = "这一段的开头句。这一段还有后续内容用来撑长度和句数。";
  const paraB = "这一段的开头句。第二段的正文也继续写一些内容保证结构完整。";
  const twoParas = `${paraA}\n\n${paraB}`;

  it("强度 < 0.7 原样返回", () => {
    expect(enforceParagraphLeadSentVariance(twoParas, rngMid, 0.6)).toBe(twoParas);
  });

  it("不足 2 段原样返回", () => {
    expect(enforceParagraphLeadSentVariance(paraA, rngMid, 0.9)).toBe(paraA);
  });

  it("段首雷同（差≤2 字）+ rng 低值：第 2 段首插口语过渡头", () => {
    const out = enforceParagraphLeadSentVariance(twoParas, rngLow, 0.9);
    // pick(floor(0.4*7)=2) → "开门见山，"
    expect(out.split("\n\n")[1]).toContain("开门见山，");
    expect(out.split("\n\n")).toHaveLength(2); // 段数守恒
  });

  it("段首雷同 + rng 高值（chopLead 分支）：首句被切分出新逗号", () => {
    const paraLong = "这是一个用来测试切分逻辑的长句子哦。后续内容继续补充完整。";
    const text = `${paraLong}\n\n${paraLong}`;
    const out = enforceParagraphLeadSentVariance(text, () => 0.6, 0.9);
    const leadAfter = out.split("\n\n")[1].split("。")[0];
    expect(leadAfter).toContain("，"); // 原首句无逗号，切分后新增
    expect(leadAfter).not.toBe("这是一个用来测试切分逻辑的长句子哦");
  });

  it("段首句长差 > 2 字：不干预", () => {
    const a = "短句开头。后续内容继续补充完整一点。";
    const b = "这一段的开头句明显要长出很多字数。后续内容继续补充完整一点。";
    const text = `${a}\n\n${b}`;
    expect(enforceParagraphLeadSentVariance(text, rngLow, 0.9)).toBe(text);
  });
});

describe("boostBurstinessIfLow（P4-B 节奏补药）", () => {
  it("academic 文风直接原样（禁口语锚）", () => {
    const t = "这是一个非常长的句子用来测试学术文风直接返回的行为没有任何变化发生。";
    expect(boostBurstinessIfLow(t, rngMid, 0.99, 4, "academic")).toBe(t);
  });

  it("低 CV 均匀文本：注入极短锚且不超过封顶（ANCHOR_CAP=2）", () => {
    // 均匀长句 → CV 低；rngMid=0.5 → pick 第 3 长句、锚池第 6 个「诶。」
    const t =
      "第一句话说了比较多的内容在里面。第二句话也说了差不多少的内容在里面。第三句话还是说了差不多少的内容在里面。第四句话继续说了差不多少的内容在里面。";
    const out = boostBurstinessIfLow(t, rngMid, 0.99, 12);
    const anchors = out
      .split(/(?<=[。！？])/)
      .filter((s) => isStandaloneAnchor(s.trim()) && s.trim().length > 0);
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    expect(anchors.length).toBeLessThanOrEqual(2);
  });

  it("块内已有语气锚：不再新增锚（降级纯切句）", () => {
    const t = "嗯。这是一个非常长的句子用来测试已有锚时不再灌新锚的行为保持原样就好。";
    const before = t.split(/(?<=[。！？])/).filter((s) => isStandaloneAnchor(s.trim())).length;
    const out = boostBurstinessIfLow(t, rngMid, 0.99, 12);
    const after = out.split(/(?<=[。！？])/).filter((s) => isStandaloneAnchor(s.trim())).length;
    expect(after).toBe(before);
  });

  it("相邻同串极短句被兜底折叠（maxCuts=0 时仍生效）", () => {
    const out = boostBurstinessIfLow("好吧。好吧。后面的内容继续说完这段话就行。", rngMid, 0.99, 0);
    expect(out.split("好吧。").length - 1).toBe(1);
    expect(out).toContain("后面的内容继续说完这段话就行");
  });

  it("场景块段落跳过：多段文本中【场景…】段不注入语气锚（单块无场景保护）", () => {
    // 注意：场景保护只在多段分支（text 含 \n\n）生效；单块场景文本走 InBlock 无此判定
    const scene =
      "【场景：面馆黄昏】\n张三说了一句很长很长的台词来撑起这一段的长度和内容。李四也回了一句很长很长的台词来保持均匀的节奏感。";
    const body =
      "正文第一段写了很多内容在这里面。正文还有第二句也是差不多的长度和节奏感。第三句继续保持差不多的长度节奏。第四句依然保持差不多的长度节奏。";
    const out = boostBurstinessIfLow(`${scene}\n\n${body}`, rngMid, 0.99, 12);
    const scenePart = out.split("\n\n")[0];
    const hasAnchorInScene = scenePart
      .split(/(?<=[。！？])/)
      .some((s) => isStandaloneAnchor(s.trim()));
    expect(hasAnchorInScene).toBe(false);
    expect(out).toContain("【场景：面馆黄昏】");
  });
});
