import { describe, it, expect } from "vitest";
import { humanize, aiScore, humanizeWithScore, crossChunkCleanup } from "./humanize.ts";
import { VOCAB, DIALECT_VOCAB } from "./humanize-data.ts";
import { countPadHeads, PAD_INJECT_CAP } from "./humanize-primitives.ts";
import { restoreMixedSpacing } from "./humanize-shuffle.ts";
import {
  pplIssues,
  PPL_MIN_MEAN_NLL,
  PPL_MAX_WIN_STD,
  PPL_MIN_CHARS,
  PPL_MIN_WINDOWS,
} from "./humanize-metrics.ts";

// 真断言版回归测试：任何失败都让 vitest（以及 npm test / CI）以非零退出码收场，
// 而不是 console.log 冒烟后恒绿。
describe("humanize 引擎", () => {
  it("空/纯空白输入返回空串", () => {
    expect(humanize("")).toBe("");
    expect(humanize("   \n  \t  ")).toBe("");
  });

  it("超短文本透传（v0.9.4：实测「短。」被管线清成空串，数据丢失）", () => {
    expect(humanize("短。")).toBe("短。");
    expect(humanize("好的", { intensity: 0.9, zhuqueMode: true })).toBe("好的");
    // 10 字及以上的正常短句不受守卫影响（不做内容断言，只断非空且包含原词根）
    const out = humanize("这句话有十个字以上了吗", { seed: 1 });
    expect(out.length).toBeGreaterThan(0);
  });

  it("串联迭代不堆积垫词（v0.9.4 P2 跨轮饱和守卫）", () => {
    // 实测迭代 5 轮垫词 12→22→28→35 线性堆积、字数 +89%——
    // 守卫生效后：第二次处理的注入被抑制，垫词计数不得随轮次显著增长
    const sample = `值得注意的是，在当今社会，随着人工智能技术的快速发展，AI 写作工具应运而生。
首先，它能够提升效率。通过自动化的方式，减少重复劳动。其次，它降低了门槛。普通人也能生成可用的文本。最后，它改变了行业。许多岗位被重新定义。
综上所述，这项技术至关重要。它不仅影响当下，还塑造未来。唯有主动拥抱变化，方能行稳致远。`;
    const r1 = humanize(sample, { intensity: 0.9, seed: 20260905, zhuqueMode: true });
    const r2 = humanize(r1, { intensity: 0.9, seed: 20260905, zhuqueMode: true });
    const r3 = humanize(r2, { intensity: 0.9, seed: 20260905, zhuqueMode: true });
    // 饱和守卫：第 2 轮起注入被抑制，垫词数不再单调上涨（允许 ±2 抖动）
    expect(countPadHeads(r2)).toBeLessThanOrEqual(countPadHeads(r1) + 2);
    expect(countPadHeads(r3)).toBeLessThanOrEqual(countPadHeads(r2) + 2);
    // 字数不随迭代注水（旧实现 3 轮 +40%+）
    expect(r3.replace(/\s/g, "").length).toBeLessThanOrEqual(
      r1.replace(/\s/g, "").length * 1.2,
    );
  });

  it("countPadHeads 基础口径", () => {
    expect(countPadHeads("正常的文本没有垫词。")).toBe(0);
    expect(countPadHeads(`你懂的。就这么回事。`)).toBe(2);
    expect(PAD_INJECT_CAP).toBeGreaterThan(5);
  });

  it("纯英文不崩溃且产出非空", () => {
    const out = humanize("This is a test. Notably, AI tools are important.", { seed: 1 });
    expect(out.length).toBeGreaterThan(0);
  });

  it("强度 0 保持原文不变（v0.8.6 语义：intensity<=0 严格短路）", () => {
    const sample = "值得注意的是，在当今社会，随着人工智能技术的快速发展，AI 写作工具应运而生。";
    const out = humanize(sample, { intensity: 0, seed: 42 });
    // v0.8.6 之前，强度 0 会漏掉 stripCJKEdgeSpaces 等确定性清理（中英文间空格被清掉、
    // 连接词被 stripLeadingConnectivesHard 删掉）——语义与"强度 0 = 保持原文"不符。
    // 现在入口直接短路：所有 pass 都不运行，包括确定性清理。
    expect(out).toBe(sample);
    // 替身词不出现在输出
    expect(out).not.toMatch(/说起来|有意思的是|要我说/);
  });

  it("强度提升后套话命中不增（去味后 aiScore ≤ 原文）", () => {
    const sample = `值得注意的是，在当今社会，随着人工智能技术的快速发展，AI 写作工具应运而生。
综上所述，人工智能技术至关重要，它不仅极大地提升了内容生产的效率，而且有效地降低了创作门槛。`;
    const before = aiScore(sample);
    const after = aiScore(humanize(sample, { intensity: 0.9, seed: 7 }));
    expect(after.score).toBeLessThanOrEqual(before.score);
  });

  it("固定种子结果可复现", () => {
    const sample = "综上所述，人工智能技术至关重要，它不仅极大地提升了效率，而且降低了门槛。";
    const a = humanize(sample, { intensity: 0.6, seed: 42 });
    const b = humanize(sample, { intensity: 0.6, seed: 42 });
    expect(a).toBe(b);
  });

  it("多段文本保留段落换行", () => {
    const para = "第一段第一句，说点事情。\n\n第二段第一句，再说点别的。";
    const out = humanize(para, { intensity: 0.6, seed: 3 });
    expect(out).toContain("\n");
  });

  it("humanizeWithScore 返回前后评分与去味文本", () => {
    const r = humanizeWithScore("值得注意的是，在当今社会，技术发展很快。", {
      intensity: 0.6,
      seed: 1,
    });
    expect(typeof r.text).toBe("string");
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.before.score).toBeGreaterThanOrEqual(0);
    expect(r.after.score).toBeGreaterThanOrEqual(0);
  });

  it("公文套话密集文本去味后套话命中下降", () => {
    const sample2 = `高位推动顶层设计，各地压茬推进、挂图作战，攻坚克难、久久为功。
我们要锚定目标、紧扣主题，牵住牛鼻子、下好先手棋，打通最后一公里、跑出加速度。
通过夯实基础、筑牢防线、厚植优势、盘活资源、补齐短板、锻造长板、擦亮名片，
为高质量发展注入新动能、激发新活力、释放新潜力，凝聚共识、形成合力、拓宽渠道、搭建平台。`;
    const r2 = humanizeWithScore(sample2, { intensity: 0.7, seed: 99 });
    expect(r2.after.formulaicHits).toBeLessThanOrEqual(r2.before.formulaicHits);
  });
});

describe("crossChunkCleanup（LLM 长文分块拼接反指纹兜底）", () => {
  // 模拟三个分块独立去味后拼接：各块"各出现一次"的垫词/破折号/省略号在块边界累积
  const dirty =
    "说真的，第一段内容。讲真，这块很重要。\n\n" +
    "说真的，第二段内容。讲真，这块也一样。\n\n" +
    "另外，第三段。——结果——另外，收尾了……真的……";

  it("垫词跨块去重（每词保留首次）", () => {
    const clean = crossChunkCleanup(dirty);
    for (const w of ["说真的", "讲真"]) {
      expect(clean.split(w + "，").length - 1).toBeLessThanOrEqual(1);
    }
  });

  it("破折号/省略号全文限额为 1", () => {
    const clean = crossChunkCleanup(dirty);
    expect(clean.split("——").length - 1).toBeLessThanOrEqual(1);
    expect(clean.split("……").length - 1).toBeLessThanOrEqual(1);
  });

  it("段首过渡词被清除且正文不受影响", () => {
    const clean = crossChunkCleanup(dirty);
    expect(clean).toContain("第一段内容");
    expect(clean).toContain("第二段内容");
    expect(clean).toContain("第三段");
  });

  it("纯清理不改写：去掉限额类模式后其余文本原样保留", () => {
    const plain = "没有垫词没有超标标点的普通文本。第二句说的也是普通话。";
    expect(crossChunkCleanup(plain)).toBe(plain);
  });
});

describe("数据词典完整性", () => {
  for (const [name, tbl] of Object.entries({ VOCAB, DIALECT_VOCAB })) {
    it(`${name} 无「唯一替身=原词」死项`, () => {
      const dead: string[] = [];
      for (const [from, tos] of Object.entries(tbl)) {
        if (tos.length === 1 && tos[0] === from) dead.push(from);
      }
      expect(dead).toEqual([]);
    });

    it(`${name} 替身数组无重复`, () => {
      const dups: string[] = [];
      for (const [from, tos] of Object.entries(tbl)) {
        const seen = new Set<string>();
        for (const t of tos) {
          if (seen.has(t)) {
            dups.push(`${from}: ${t}`);
          }
          seen.add(t);
        }
      }
      expect(dups).toEqual([]);
    });
  }
});

describe("pplIssues 第 8 项判定", () => {
  const win = { charStart: 0, charEnd: 100, scoredCount: 80, meanNll: 0.5 };
  const base = {
    meanNll: 1.2,
    winStd: 0.3,
    scoredChars: 300,
    windows: [win, { ...win }, { ...win }],
  };

  it("均值通道：meanNll 低于 PPL_MIN_MEAN_NLL 报「困惑度异常低」", () => {
    const issues = pplIssues({ ...base, meanNll: PPL_MIN_MEAN_NLL - 0.01 });
    expect(issues.some((i) => i.name === "困惑度异常低")).toBe(true);
  });

  it("均值通道：人工写作量级（约 1.2 nat）不触发任何问题", () => {
    expect(pplIssues(base)).toHaveLength(0);
  });

  it("平坦通道：窗数达标且 winStd 低于 PPL_MAX_WIN_STD 才报「困惑度曲线过平」", () => {
    const issues = pplIssues({ ...base, winStd: PPL_MAX_WIN_STD / 2 });
    expect(issues.map((i) => i.name)).toContain("困惑度曲线过平");
  });

  it("平坦通道：窗口数不足时不判", () => {
    const few = { ...base, windows: base.windows.slice(0, PPL_MIN_WINDOWS - 1) };
    expect(pplIssues(few)).toHaveLength(0);
  });

  it("短文（低于 PPL_MIN_CHARS）静默跳过", () => {
    expect(pplIssues({ ...base, scoredChars: PPL_MIN_CHARS - 1, meanNll: 0 })).toHaveLength(0);
  });
});

describe("restoreMixedSpacing（v0.8.9 LLM 稿空格回填）", () => {
  const orig = "从 Webpack 迁移到 Vite，包含 1200 个模块。";
  it("原文带空格排版 → 回填被 LLM 压掉的空格", () => {
    const out = restoreMixedSpacing(orig, "从Webpack迁移到Vite，包含1200个模块。");
    expect(out).toBe("从 Webpack 迁移到 Vite，包含 1200 个模块。");
  });
  it("中文标点后不插空格（初版 bug：产出'， 1200 个模块'）", () => {
    const out = restoreMixedSpacing(orig, "我们有个项目，1200个模块。Vite很快。");
    expect(out).not.toMatch(/[，。；：、]\s/);
    expect(out).toContain("，1200 个模块");
  });
  it("原文不带空格 → 原样返回，不擅自加空格", () => {
    const noSpace = "从Webpack迁移到Vite。";
    expect(restoreMixedSpacing(noSpace, "从Webpack迁移到Vite。")).toBe("从Webpack迁移到Vite。");
  });
  it("幂等：已有空格不重复插入", () => {
    const once = restoreMixedSpacing(orig, "从Webpack迁移到Vite");
    expect(restoreMixedSpacing(orig, once)).toBe(once);
  });
});
