/**
 * humanize-shuffle 公共 API 行为锁（v0.9.16 测试迭代第二轮）：
 *  - crossChunkCleanup（跨块清理收口：垫词去重/段首连接词/标点封顶/CJK 空格）
 *  - mechanicalShuffle（机械扰动主入口：体裁联动/指纹预检降级/确定性/内容守恒）
 *
 * 全部确定性断言（固定 seed / 固定输入），不依赖随机行为。
 */
import { describe, expect, it } from "vitest";
import { crossChunkCleanup, mechanicalShuffle } from "./humanize-shuffle.ts";
import { PAD_WORDS } from "./humanize-text.ts";

describe("crossChunkCleanup（跨块清理收口）", () => {
  it("同一垫词重复出现只保留第一次", () => {
    const w = PAD_WORDS[0]; // 取表内第一个真实垫词，避免词表演进误伤断言
    const out = crossChunkCleanup(`${w}，这不错。${w}，那也行。`);
    expect(out.split(w).length - 1).toBe(1);
  });

  it("破折号多于 1 处收敛到 1 处（多余替换为逗号）", () => {
    const out = crossChunkCleanup("甲——乙——丙——丁。");
    expect(out.split("——").length - 1).toBe(1);
  });

  it("省略号多于 1 处收敛到 1 处（多余替换为句号）", () => {
    const out = crossChunkCleanup("甲……乙……丙……");
    expect(out.split("……").length - 1).toBe(1);
  });

  it("句号后的「然而，」等连接词被硬剥离", () => {
    const out = crossChunkCleanup("成本很低。然而，良率高。因此，交付快。");
    expect(out).not.toContain("然而");
    expect(out).not.toContain("因此");
    expect(out).toContain("良率高");
    expect(out).toContain("交付快");
  });

  it("aggressive 模式剥离中文与数字间的空格（盘古之白指纹）", () => {
    const out = crossChunkCleanup("共 100 次，约 3 天", true);
    expect(out).toBe("共100次，约3天");
  });

  it("非 aggressive 且文中已有打字空格：尊重用户空格不剥离", () => {
    const src = "共 100 次，约 3 天";
    expect(crossChunkCleanup(src, false)).toBe(src);
  });

  it("多重指纹组合输入全链收敛且无占位符残留", () => {
    const w = PAD_WORDS[0];
    const src = `${w}，第一步。${w}，第二步。然后——继续——再——结束……先这样……好吧。成本很低。然而，良率高。共 100 次。`;
    const out = crossChunkCleanup(src, true);
    expect(out).not.toContain("\u0000");
    expect(out.split("——").length - 1).toBeLessThanOrEqual(1);
    expect(out.split("……").length - 1).toBeLessThanOrEqual(1);
    expect(out).not.toContain("然而");
    expect(out).not.toContain(" 100 ");
  });
});

describe("mechanicalShuffle（机械扰动主入口）", () => {
  const aiText =
    "综上所述，数字化转型已成为企业发展的必由之路。研究表明，数字化水平与经营效率之间存在显著的正相关关系。" +
    "数据显示，率先完成数字化改造的企业在成本控制与市场响应速度上均具备明显优势。基于以上分析，企业应当制定清晰的战略。" +
    "综上所述，推进数字化需要组织层面的配合。研究表明，管理层的支持程度直接影响转型成效。数据显示，组织架构的调整同样不可忽视。" +
    "基于以上分析，人才培养与制度建设需要同步进行，从而保证转型成果能够长期巩固，形成持续的竞争优势与良性循环。";

  it("空文本与纯空白返回空串", () => {
    expect(mechanicalShuffle("")).toBe("");
    expect(mechanicalShuffle("   \n\t  ")).toBe("");
  });

  it("确定性：同 opts 两次调用输出完全一致", () => {
    const a = mechanicalShuffle(aiText, { intensity: 0.9, seed: 20260925 });
    const b = mechanicalShuffle(aiText, { intensity: 0.9, seed: 20260925 });
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("高强度去味：内容守恒（去空白长度 ≥ 原文 80%）且标点封顶生效", () => {
    const srcChars = aiText.replace(/\s/g, "").length;
    const out = mechanicalShuffle(aiText, {
      intensity: 0.9,
      zhuqueMode: true,
      genre: "main",
      seed: 20260925,
    });
    expect(out.replace(/\s/g, "").length).toBeGreaterThanOrEqual(srcChars * 0.8);
    expect(out.split("——").length - 1).toBeLessThanOrEqual(1);
    expect(out.split("……").length - 1).toBeLessThanOrEqual(1);
    expect(out).not.toMatch(/—{3,}/);
    // 收尾清理：行首标点被剥（不得以逗号/句号开头）
    expect(out).not.toMatch(/(^|\n)\s*[。，、；：]/);
  });

  it("humanHand 体裁联动：真人稿走钳制通道不炸、输出非空", () => {
    const human =
      "我散步。我们昨天去了老街。你猜怎么着？巷口那家面馆换了招牌。我们几个人一起去的，我说味道不错，你说确实，我们都笑了。" +
      "我记得那年夏天，我们一起去了河边，你笑着说我像个孩子，跑来跑去没有停过。我后来还想过很多次，那天的风很舒服，我们在桥上看了很久的夕阳，你说下次还来。" +
      "我说好，我们都记住了这句话，后来真的又去了几次，每次都想起那天。";
    const out = mechanicalShuffle(human, { intensity: 0.95, genre: "humanHand", seed: 7 });
    expect(out.length).toBeGreaterThan(0);
    // 内容守恒（钳制通道同样不得丢内容）
    expect(out.replace(/\s/g, "").length).toBeGreaterThanOrEqual(
      human.replace(/\s/g, "").length * 0.8,
    );
  });

  it("dialogue 体裁：场景块保真不炸、输出非空且确定性", () => {
    const script =
      "【场景：老街黄昏】\n\n张三：你来了。\n\n李四：嗯，刚到。巷子很深，两人并肩走进去，谁也没再说话。" +
      "张三：面馆还开着吗？李四：开着，新招牌。天色暗下来，灯一盏一盏亮了，狗叫了两声，风里有油烟味。" +
      "张三：走吧。李四：走吧。两人的影子被灯拉得很长。";
    const opts = { intensity: 0.9, genre: "dialogue" as const, seed: 3 };
    const a = mechanicalShuffle(script, opts);
    const b = mechanicalShuffle(script, opts);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
    // 场景块头格式保真（relaxColon 不得把【场景：…】改成【场景，…】）
    expect(a).toContain("【场景：老街黄昏】");
  });

  it("intensity 0：轻管线也不炸，输出非空", () => {
    const out = mechanicalShuffle(aiText, { intensity: 0, seed: 1 });
    expect(out.length).toBeGreaterThan(0);
  });
});
