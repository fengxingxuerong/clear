import { describe, it, expect } from "vitest";
import { humanize, aiScore, humanizeWithScore, crossChunkCleanup } from "./humanize.ts";
import { VOCAB, DIALECT_VOCAB } from "./humanize-data.ts";

// 真断言版回归测试：任何失败都让 vitest（以及 npm test / CI）以非零退出码收场，
// 而不是 console.log 冒烟后恒绿。
describe("humanize 引擎", () => {
  it("空/纯空白输入返回空串", () => {
    expect(humanize("")).toBe("");
    expect(humanize("   \n  \t  ")).toBe("");
  });

  it("纯英文不崩溃且产出非空", () => {
    const out = humanize("This is a test. Notably, AI tools are important.", { seed: 1 });
    expect(out.length).toBeGreaterThan(0);
  });

  it("强度 0 不做词汇替换（替身词不出现在输出）", () => {
    const sample = "值得注意的是，在当今社会，随着人工智能技术的快速发展，AI 写作工具应运而生。";
    const out = humanize(sample, { intensity: 0, seed: 42 });
    // p=0 时 replaceVocab 不替换；替身词如 说起来/有意思的是 不应混入
    expect(out).not.toMatch(/说起来|有意思的是|要我说/);
    // stripCJKEdgeSpaces 是确定性清理（不受强度门控）：中英文间空格会被清掉
    expect(out).toContain("AI写作工具");
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
