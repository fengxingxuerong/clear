/**
 * humanize-shuffle 结构层第二轮行为锁（v0.9.16 测试迭代第三轮）：
 *  - structuralShuffleParagraph（P0~P3 编排主链路）
 *  - hardNumberedEnumerationShuffle（P3-2 硬编号列举拆毁）
 *  - enforceParagraphLeadSentVariance（P3-3 段首句长强制方差）
 *  - boostBurstinessIfLow（P4-B 低 CV 节奏补药）
 *
 * v0.9.16 编号格式偏差已修复（原「1.」replace 残留标点、「第三：」「①」不匹配），
 * 相关用例已改为断言修复后行为；**修复动了引擎输出字节**，test:calib 的 x 轴漂移
 * 自检如变红属预期信号，需按 README 流程拿新官方点位重拟合四条体裁线。
 *
 * 追加扩写：直接钉 shuffle/structure.ts 的结构规则与收口闸门分支行
 * （行 60/70/98/99/109/279/280/301/303/331/332/338/345/774/781/782/843-845/899/904），
 * 全部确定性 rng + 表驱动风格，断言结构重排/守卫/门控的具体输出形态。
 */
import { describe, expect, it } from "vitest";
import {
  breakEnumerationStructure,
  breakSummaryTail,
  boostBurstinessIfLow,
  capParticleSentenceDensity,
  deParallelizeStructure,
  enforceParagraphLeadSentVariance,
  ensureEmDashCountHardCap,
  hardNumberedEnumerationShuffle,
  injectFirstPersonAnchorPoints,
  shuffleSentencesSafe,
  structuralShuffleParagraph,
} from "./humanize-shuffle.ts";

const rngMid = () => 0.5;
const rngLow = () => 0.4;
const rngHigh = () => 0.95;
/** 固定 rng=0.2：fixParallelRun 里 pickIdx=0 且 roll<0.3 → 走「破坏1：前加自问自答」 */
const rngQA = () => 0.2;
/** 固定 rng=0.32：pickIdx=0 且 0.3≤roll<0.65 → 走「破坏2：改反问句」 */
const rngFlip = () => 0.32;
/** 固定 rng=0.7：pickIdx=2 且 roll≥0.65 → 走「破坏3：前插碎碎念」 */
const rngMutter = () => 0.7;

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

  it("修复后：阿拉伯编号「1.」replace 吃干净前缀（不留 . 残留）", () => {
    const sents = ["开头一句话。", "1. 良率不错。", "2. 成本很低。"];
    const out = hardNumberedEnumerationShuffle(sents, rngMid, 0.9);
    expect(out.join("")).not.toMatch(/\.\s*良率|\.\s*成本/); // 编号前缀不再残留
    expect(out.join("")).toContain("良率不错");
  });

  it("修复后：「第三：」与「① 」均被识别为编号列举", () => {
    const sents = ["第三：成本很低。", "① 良率不错。", "① 交付很快。"];
    const out = hardNumberedEnumerationShuffle(sents, rngMid, 0.9);
    // 三条编号全部命中（≥2 即触发），不再原样返回
    expect(out).not.toEqual(sents);
    expect(out.join("")).toContain("成本很低");
    expect(out.join("")).toContain("良率不错");
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

  it("场景块保护修复后：单块场景文本同样跳过语气锚注入", () => {
    // v0.9.16 修复：场景判定不再只在多段分支生效，单块【场景…】文本也跳过
    const scene =
      "【场景：面馆黄昏】\n张三说了一句很长很长的台词来撑起这一段的长度和内容。李四也回了一句很长很长的台词来保持均匀的节奏感。";
    const out = boostBurstinessIfLow(scene, rngMid, 0.99, 12);
    const hasAnchor = out.split(/(?<=[。！？])/).some((s) => isStandaloneAnchor(s.trim()));
    expect(hasAnchor).toBe(false);
    expect(out).toContain("【场景：面馆黄昏】");
  });
});

/* =========================================================
   追加：直接钉 structure.ts 的 P0/P1 结构规则与收口闸门分支行
   （对应未覆盖行 60/70/98/99/109/279/280/301/303/331/332/338/345/
     774/781/782/843-845/899/904；全部确定性 rng）
   ========================================================= */

describe("shuffleSentencesSafe（P0-1 段内句序安全重排）", () => {
  it("强度 < 0.55 不重排，原样返回（门控行 70）", () => {
    const sents = ["第一句内容。", "第二句内容。", "第三句内容。", "第四句内容。"];
    expect(shuffleSentencesSafe(sents, rngMid, 0.5)).toEqual(sents);
  });
});

describe("breakEnumerationStructure（P0-2 列举结构打散）", () => {
  it("不足 2 句不构成列举，原样返回（行 98）", () => {
    expect(breakEnumerationStructure(["只有一句。"], rngMid, 0.9)).toEqual(["只有一句。"]);
  });

  it("强度 < 0.5 不打散，原样返回（行 99）", () => {
    const sents = ["首先，甲。", "其次，乙。"];
    expect(breakEnumerationStructure(sents, rngMid, 0.4)).toEqual(sents);
  });

  it("成员之间的 <3 字碎句被跳过、继续收编后续成员（行 109 continue）", () => {
    // 结构规则：「嗯。」不是列举成员，不能截断扫描——否则 members<2，整段放弃打散
    const out = breakEnumerationStructure(
      [
        "首先，成本这一块要单独说。",
        "嗯。",
        "其次，良率这一块也要说。",
        "最后，交付这一块顺带说。",
      ],
      rngMid,
      0.9,
    );
    // rngMid=0.5 < 0.4+0.3*0.9 → 每个成员承接头换成 casual 池第 5 个「哦对了，」；碎句原样保留
    expect(out).toEqual([
      "哦对了，成本这一块要单独说。",
      "嗯。",
      "哦对了，良率这一块也要说。",
      "哦对了，交付这一块顺带说。",
    ]);
    expect(out.join("")).not.toContain("首先，");
  });
});

describe("breakSummaryTail（P0-3 总分总尾总结句挪位）", () => {
  it("中间句以「——」开头 → 非自由句（行 60），无空位时尾总结句插到固定中位", () => {
    const sents = [
      "开头一句普通内容。",
      "——补充一句放在中间。",
      "再一句普通内容。",
      "综上所述，就这样吧。",
    ];
    const res = breakSummaryTail(sents, rngMid, 0.6);
    expect(res.splitAfter).toBeUndefined(); // 强度 0.6 < 0.75，不触发拆段
    // 「——补充…」被行 60 判为非自由句 → freeSpots 空 → 走 mid=⌊3×(0.3+0.5×0.3)⌋=1 的兜底插位
    expect(res.sentences).toEqual([
      "开头一句普通内容。",
      "综上所述，就这样吧。",
      "——补充一句放在中间。",
      "再一句普通内容。",
    ]);
  });
});

describe("deParallelizeStructure（P1-1 排比/对仗结构破坏）", () => {
  it("不足 3 句不构成排比，原样返回（行 279）", () => {
    expect(deParallelizeStructure(["甲。", "乙。"], rngMid, 0.6)).toEqual(["甲。", "乙。"]);
  });

  it("强度 < 0.55 不破坏，原样返回（行 280）", () => {
    const sents = ["甲。", "乙。", "丙。"];
    expect(deParallelizeStructure(sents, rngMid, 0.5)).toEqual(sents);
  });

  it("无 CJK/ASCII 头签名的句子直通输出、不被排比机吞掉（行 301）", () => {
    // 「①这一点…」的 headKey 为空（① 不在头签名字符类里）→ 必须原样 push 出去
    const sents = ["①这一点得先说清楚。", "研究发现的方案其实挺好。", "研究发现的流程其实很顺。"];
    expect(deParallelizeStructure(sents, rngMid, 0.6)).toEqual(sents);
  });

  // 末尾 3 连同头句组：循环结束后必须走兜底 flush（行 303），句子一条都不能丢
  const PARA_RUN = [
    "先交代一句别的内容。",
    "研究发现这套方案里，第一方面表现不错。",
    "研究发现这套方案里，第二方面表现不错。",
    "研究发现这套方案里，第三方面表现不错。",
  ];

  it("roll<0.3 且强度≥0.65：句组首句前加自问自答（行 331/332 + 303 兜底 flush）", () => {
    const out = deParallelizeStructure(PARA_RUN, rngQA, 0.9);
    // rngQA=0.2 → pickIdx=0、roll=0.2、pick 池第 2 个「真的吗？」；第 2 次挑选撞已改句被丢弃
    expect(out).toEqual([
      "先交代一句别的内容。",
      "真的吗？研究发现这套方案里，第一方面表现不错。",
      "研究发现这套方案里，第二方面表现不错。",
      "研究发现这套方案里，第三方面表现不错。",
    ]);
  });

  it("0.3≤roll<0.65 且句子能安全改写：句尾句号改反问（行 338）", () => {
    const CAN_FLIP_RUN = [
      "另外补一句别的话题。",
      "应该把这一步先做完再看效果。",
      "应该把这一步先记在本子上。",
      "应该把这一步先同步给团队。",
    ];
    const out = deParallelizeStructure(CAN_FLIP_RUN, rngFlip, 0.9);
    // rngFlip=0.32 → pickIdx=0、canFlip 命中「应该…。」、pick 第 1 个「吗？」
    expect(out).toEqual([
      "另外补一句别的话题。",
      "应该把这一步先做完再看效果吗？",
      "应该把这一步先记在本子上。",
      "应该把这一步先同步给团队。",
    ]);
    expect(out[1]).not.toMatch(/[。]$/);
  });

  it("roll≥0.65：句组第三句前插碎碎念短语（行 345）", () => {
    const out = deParallelizeStructure(PARA_RUN, rngMutter, 0.9);
    // rngMutter=0.7 → pickIdx=2、pick 池第 5 个「哦不对，」
    expect(out).toEqual([
      "先交代一句别的内容。",
      "研究发现这套方案里，第一方面表现不错。",
      "研究发现这套方案里，第二方面表现不错。",
      "哦不对，研究发现这套方案里，第三方面表现不错。",
    ]);
  });
});

describe("结构层收口闸门（破折号硬上限 / 语气词密度上限）", () => {
  it("全部破折号都是自问自答型：逐处占位跳过、need 耗不尽 → lastIndexOf=-1 收口（行 774/781/782）", () => {
    const t = "你可能会问——这事儿靠谱吗。又问——到底行不行。";
    const out = ensureEmDashCountHardCap(t, 0);
    // 前字「问」在 skipChars 里：宁可超 cap 也保住自问自答；\x00 占位符最终还原回原文
    expect(out).toBe(t);
    expect(out).not.toContain("\x00");
  });

  it("超额句尾挂词：只剥语气词本体、句子保留（行 843-845）", () => {
    // 注意：「吧」不在 PARTICLE_SUFFIX_RE 表里（只有 好吧/对哦/是啊 + 单字表），
    // 这里必须用「哦」才能真正走进行 841 的剥离分支
    const out = capParticleSentenceDensity("这款产品续航不错哦。之前用过的一款也挺好哦。", 1);
    // 首条在 maxPerPara=1 限额内保留「哦」；第二条超额 → 只剥「哦」、句子本体不动
    expect(out).toBe("这款产品续航不错哦。之前用过的一款也挺好。");
    expect(out).not.toContain("挺好哦");
  });
});

describe("injectFirstPersonAnchorPoints（P3-4 第一人称判断锚点）", () => {
  /** 复用的长句填充块：无数据标记、无空白，方便按字数断言 */
  const FILLER =
    "整个团队为了把这条链路跑通前前后后折腾了好几个星期的时间，中间推翻重来的方案就有三版，最后落地的这版反而是改动最小的一版";

  it("≥200 字但全文无数据标记、仅 3 句：兜底槽位也凑不出 → 原文原样返回（行 899）", () => {
    const t =
      "第三方的报告里提到的这套口径，" +
      FILLER +
      "。" +
      FILLER +
      "。" +
      "从同行交流的情况看，" +
      FILLER +
      "。";
    // 前置条件：不是走「<200 字早退」，而是槽位兜底也失败（3 句时 step=2、k<2 不成立）
    expect(t.replace(/\s/g, "").length).toBeGreaterThanOrEqual(200);
    expect(t.split(/(?<=[。！？])/).filter((s) => s.trim())).toHaveLength(3);
    expect(injectFirstPersonAnchorPoints(t, rngMid, 0.9)).toBe(t);
  });

  it("≥600 字 + 两个数据标记槽：useSlots 需排序，注入 2 处判断锚（行 904）", () => {
    const t =
      "第三方的数据显示，" +
      FILLER.repeat(4) +
      "。" +
      "上周的调研显示，" +
      FILLER.repeat(4) +
      "。" +
      FILLER.repeat(4) +
      "。";
    const chars = t.replace(/\s/g, "").length;
    // targetCount = ⌊chars/300⌋ ≥ 2 → useSlots 至少 2 个元素 → sort 比较器必须执行
    expect(chars).toBeGreaterThanOrEqual(600);
    const out = injectFirstPersonAnchorPoints(t, rngMid, 0.9);
    expect(out).not.toBe(t);
    // 两个数据标记各贡献一个槽位 → 恰好注入 2 处主观判断锚
    expect(
      out.match(/我个人觉得|要我说，|这点我持保留意见|我的看法是|我觉得口径|在我看来/g),
    ).toHaveLength(2);
    // 原文内容一字不丢
    expect(out).toContain("第三方的数据显示");
    expect(out).toContain("上周的调研显示");
    expect(out).toContain("最后落地的这版反而是改动最小的一版");
  });
});
