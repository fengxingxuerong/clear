import { describe, it, expect } from "vitest";
import { humanize } from "./humanize";
import { injectFirstPersonAnchorPoints } from "./humanize-shuffle";
import { makeRng } from "./humanize-data";

/** 典型 AI 议论文（套话 + 骨架词 + 均匀句长，与冒烟脚本同款） */
const AI_TEXT = `在当今社会，随着人工智能技术的快速发展，越来越多的行业开始实现数字化转型。
首先，人工智能在提高生产效率方面发挥着重要作用。通过对海量数据的深度分析，企业能够优化资源配置，降低运营成本，从而实现可持续发展。
其次，人工智能在教育领域也具有重要意义。个性化学习方案不仅能够满足学生的多样化需求，而且有助于缩小教育资源分配的差距。
然而，值得注意的是，人工智能的发展也带来了前所未有的挑战。数据隐私、算法偏见以及就业结构的调整，都是亟待解决的重要课题。
综上所述，我们应当以开放包容的态度拥抱人工智能，同时建立健全相应的监管机制，趋利避害，让技术更好地服务于人类社会。`;

/** 连续 4+ 个语气单字 = 锚点堆叠/复读串（实测病句「行对哦诶啊嗯呵呣啧」的特征签名） */
const PARTICLE_RUN = /[啊哦嗯呵咳啧呣嗨诶]{4,}/;
/** 相邻 1~3 字极短句复读（「是啊。是啊。」式指纹） */
const SHORT_SENT_ECHO = /([\u4e00-\u9fa5]{1,3}。)\1/;

describe("本地引擎输出质量（v0.8.4 反指纹回归）", () => {
  it("高强度 30 种子：不产生 4 连以上语气词堆叠", () => {
    for (let seed = 0; seed < 30; seed++) {
      const out = humanize(AI_TEXT, { intensity: 0.9, seed });
      const m = out.match(PARTICLE_RUN);
      expect(m, `seed=${seed} 堆叠：${m?.[0]}`).toBeNull();
    }
  });

  it("高强度 30 种子：极短句不复读（相邻重复即指纹）", () => {
    for (let seed = 0; seed < 30; seed++) {
      const out = humanize(AI_TEXT, { intensity: 0.9, seed });
      const m = out.match(SHORT_SENT_ECHO);
      expect(m, `seed=${seed} 复读：${m?.[1]}`).toBeNull();
    }
  });

  it("「通过对N」不再产出「借对/靠对/用对」病句", () => {
    const src = "通过对海量数据的深度分析，企业优化了资源配置。";
    for (let seed = 0; seed < 15; seed++) {
      const out = humanize(src, { intensity: 0.9, seed });
      const m = out.match(/(?:靠|借|用)对/);
      expect(m, `seed=${seed}：${out}`).toBeNull();
    }
  });

  it("「个性化+方案/学习」不再产出「对口味/按个人来」错配", () => {
    const src = "个性化学习方案能够满足学生的多样化需求。";
    for (let seed = 0; seed < 15; seed++) {
      const out = humanize(src, { intensity: 0.9, seed });
      expect(out, `seed=${seed}：${out}`).not.toContain("对口味");
      expect(out, `seed=${seed}：${out}`).not.toContain("按个人来");
    }
  });

  it("正常语境下「通过/个性化」仍会被替换（守卫不误伤）", () => {
    const src = "这个方法通过实践检验是可行的。个性化的服务更受欢迎。";
    let replaced = 0;
    for (let seed = 0; seed < 20; seed++) {
      const out = humanize(src, { intensity: 0.9, seed });
      if (!out.includes("通过") || !out.includes("个性化")) replaced++;
    }
    expect(replaced).toBeGreaterThan(0);
  });

  it("「取得了」不再产出「得了了」病句（替身+尾随了撞车回归）", () => {
    const src = "本季度各项工作取得了显著成效，同时取得了新的突破，团队也取得了成长。";
    for (let seed = 0; seed < 20; seed++) {
      const out = humanize(src, { intensity: 0.9, seed, zhuqueMode: seed % 2 === 0 });
      expect(out, `seed=${seed}：${out}`).not.toContain("了了");
      expect(out, `seed=${seed}：${out}`).not.toContain("得了");
    }
  });

  it("经验锚点不再编造「朋友」轶事（与 LLM 提示词铁律对齐）", () => {
    const long = "报告显示占比达到40%，同比提升明显。数据背后是行业的真实变化。".repeat(12);
    for (let seed = 0; seed < 10; seed++) {
      const out = injectFirstPersonAnchorPoints(long, makeRng(seed), 0.9);
      expect(out).not.toContain("我身边有个朋友");
    }
  });
});
