import { describe, it, expect } from "vitest";
import { pickExemplarBlock, personaDirective, styleDirective, intensityDirective } from "./llm-prompts";

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

describe("personaDirective（人味人格分档，v0.9.5 P4）", () => {
  it("default 不追加任何人格指令（现行范例即该套）", () => {
    expect(personaDirective("default")).toBe("");
    expect(personaDirective(undefined)).toBe("");
  });

  it("netgen：短句导向 + 严禁网络烂梗", () => {
    const d = personaDirective("netgen");
    expect(d).toContain("网络世代");
    expect(d).toContain("严禁网络烂梗");
    expect(d).toContain("绝绝子");
  });

  it("classic：垫词减半 + 沉稳过渡 + 结尾留余韵", () => {
    const d = personaDirective("classic");
    expect(d).toContain("老派文青");
    expect(d).toContain("垫词浓度减半");
    expect(d).toContain("余韵");
    expect(d).toContain('不许用"综上所述"式收束'); // 明确禁用（示例形式出现）
  });
});

// 以下两组补的是 styleDirective/intensityDirective 此前 0 覆盖的 4 行
// （academic 分支、casual 默认分支、轻度档、重度档）。
describe("styleDirective（文风预设指令）", () => {
  it("academic：保留术语与排版规范，但要求删掉总分总与 AI 套话", () => {
    const d = styleDirective("academic");
    expect(d).toContain("学术语体");
    expect(d).toContain("跟随原文排版"); // 中英文空格不许统一增删
    expect(d).toContain("综上所述"); // 要删掉的套话以示例形式出现
    expect(d).toContain("人写的论文");
  });

  it("casual（switch 默认分支）：不追加任何文风指令，口语化战术在主提示词里", () => {
    expect(styleDirective("casual")).toBe("");
  });

  it("plain 与 academic 互斥：平实书面档不含学术措辞", () => {
    const plain = styleDirective("plain");
    expect(plain).toContain("平实书面");
    expect(plain).not.toContain("学术语体");
  });
});

describe("intensityDirective（强度指令随滑块生效）", () => {
  it("intensity < 0.35 → 轻度模式：只处理最刺眼的痕迹、不重构", () => {
    expect(intensityDirective(0)).toContain("轻度模式");
    expect(intensityDirective(0.34)).toContain("轻度模式");
    expect(intensityDirective(0.34)).toContain("保持原句顺序");
  });

  it("intensity ≥ 0.75 → 重度模式：允许打散结构但事实与逻辑关系不变", () => {
    expect(intensityDirective(0.75)).toContain("重度模式");
    expect(intensityDirective(1)).toContain("重度模式");
    expect(intensityDirective(1)).toContain("事实与逻辑关系仍不能变");
  });

  it("中档（0.35 ~ 0.75）不追加强度指令", () => {
    expect(intensityDirective(0.5)).toBe("");
  });
});
