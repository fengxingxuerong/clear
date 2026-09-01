import { describe, it, expect } from "vitest";
import { detectAI, detectLevel } from "./detector";

/** 典型 AI 议论文（套话 + 骨架词 + 均匀句长） */
const AI_TEXT = `随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。值得注意的是，数字化阅读不仅改变了人们获取知识的方式，还显著提升了阅读的便捷性。然而，数字化阅读也面临着一系列挑战，诸如注意力分散、深度思考能力下降等问题。因此，我们需要在享受技术便利的同时，保持对阅读质量的关注。
首先，数字化阅读让知识的获取变得更加高效。读者可以随时随地通过移动设备访问海量资源，检索与标注也变得前所未有的便捷。其次，数字化阅读有助于降低阅读门槛，让更多人能够接触到优质的内容。此外，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。
与此同时，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。综上所述，建立完善的数字化阅读体系，推动全民阅读高质量发展，具有重要的现实意义。`;

/** 口语真人稿（第一人称 + 具体细节 + 短句） */
const HUMAN_TEXT = `我家楼下那家早餐店开了快十年了。老板娘记得我不吃香菜，每次都是提前给我挑出来。有次我出差一个月没去，回来她问我："上哪儿发财去了？"我说出差，她笑："还以为你搬走了。"那天豆浆给我多加了半勺糖，说是欢迎回来。这种小事，比什么会员卡都管用。`;

describe("detectAI（本地 14 特征检测）", () => {
  it("AI 议论文落 high 档", () => {
    const r = detectAI(AI_TEXT);
    expect(r.level).toBe("high");
    expect(r.probability).toBeGreaterThanOrEqual(48);
    expect(r.levelText).toBe("AI生成");
    expect(r.features.length).toBeGreaterThanOrEqual(14);
    expect(r.confidence).toBeGreaterThanOrEqual(45);
  });

  it("口语真人稿落 human 档", () => {
    const r = detectAI(HUMAN_TEXT);
    expect(r.level).toBe("human");
    expect(r.probability).toBeLessThan(32);
  });

  it("低于 350 字给警告，句子太少提示节奏不可靠", () => {
    const r = detectAI("很短。就这样。");
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(detectLevel("很短。就这样。")).toBe("human");
  });

  it("topSegments 风险句按分数降序", () => {
    const r = detectAI(AI_TEXT);
    const risks = r.topSegments.map((s) => s.risk);
    const sorted = [...risks].sort((a, b) => b - a);
    expect(risks).toEqual(sorted);
  });
});
