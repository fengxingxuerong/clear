import { describe, it, expect } from "vitest";
import { pickExemplarBlock } from "./llm-prompts";

/** v0.9.5 P3 范例条件注入：按体裁选范例组（议论默认 / 叙事判体 / 科普启发式 / academic 跳过） */
describe("pickExemplarBlock（范例条件注入）", () => {
  it("议论文默认注入议论组（含短视频篇章范例）", () => {
    const text =
      "数字化转型不仅是技术升级，更是思维变革。企业需要转变观念，也需要全体员工参与。数字化转型既是必然要求，也是必由之路。";
    const block = pickExemplarBlock(text, "casual");
    expect(block).toContain("对照范例");
    expect(block).toContain("篇章级对照");
    expect(block).not.toContain("叙事体对照");
  });

  it("叙事文本注入叙事组（情绪动作化范例）", () => {
    const text =
      "【场景：深夜的便利店】\n林晚推门进来，风铃叮了一声。她拿了罐热咖啡。\n「又是这种天气。」店员头也不抬。";
    const block = pickExemplarBlock(text, "casual");
    expect(block).toContain("叙事体对照");
    expect(block).toContain("李峰");
    expect(block).not.toContain("短视频");
  });

  it("定义性表述注入科普组（直觉类比范例）", () => {
    const text =
      "二维码的工作原理是将信息编码为黑白像素的排列组合。它的核心技术是矩阵式编码。广泛应用于移动支付场景。";
    const block = pickExemplarBlock(text, "casual");
    expect(block).toContain("科普/说明体对照");
    expect(block).toContain("二维码说白了");
  });

  it("academic 文风跳过全部范例（省 token 且避免口语干扰）", () => {
    const text = "本研究提出了一种基于注意力机制的模型架构，实验结果表明方法有效。";
    expect(pickExemplarBlock(text, "academic")).toBe("");
  });
});
