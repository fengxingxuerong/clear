/**
 * collapseIssues —— 语法塌缩一票否决的判据测试
 * ---------------------------------------------------------
 * 这个检查器存在的唯一理由：aiScore 对"只剩光杆主语"的句子给 0 分，等于**奖励删除**。
 * 不补这道否决，bestOf 与 LLM 择优都会稳定挑出删得最狠的那一稿。
 * 因此两侧都要测：漏（真塌句没抓到）和误杀（正常改写被判坏）同样致命——
 * 误杀会让择优全部淘汰、静默退化成单趟生成。
 */
import { describe, it, expect } from "vitest";
import { collapseIssues, humanize } from "./humanize.ts";

describe("collapseIssues（真塌句必须抓到）", () => {
  it("谓语被删成光杆主语", () => {
    expect(collapseIssues("人工智能技术展望未来。", "人工智能技术。").length).toBeGreaterThan(0);
    expect(collapseIssues("这种技术被广泛使用于医疗诊断。", "这种技术。").length).toBeGreaterThan(0);
  });

  it("塌句被垫词补了语气词也要认（'人工智能技术吧。'）", () => {
    expect(collapseIssues("人工智能技术展望未来。", "人工智能技术吧。").length).toBeGreaterThan(0);
    expect(collapseIssues("人工智能技术展望未来。", "人工智能技术呢。").length).toBeGreaterThan(0);
  });

  it("含'在/被'等字的塌句不许漏——deletionStubIssues 正是含这些字就放行的", () => {
    expect(collapseIssues("这种技术被广泛应用于医疗诊断。", "这种技术被广泛。").length).toBeGreaterThan(0);
  });

  it("多句里只塌一句也要报", () => {
    const o = "第一句正常表达完整意思。人工智能技术。第三句也是完整的句子。";
    expect(collapseIssues("第一句正常表达完整意思。人工智能技术展望未来。第三句也是完整的句子。", o)).toHaveLength(1);
  });
});

describe("collapseIssues（正常改写不得误杀）", () => {
  it("换词改写（非逐字前缀）不判塌", () => {
    expect(
      collapseIssues("该产品受到广泛关注，并得到广泛认可。", "该产品大家都很关注，口碑也不错。"),
    ).toEqual([]);
  });

  it("原样保留的短句不判塌（差分为 0）", () => {
    expect(collapseIssues("这个功能确实好用。", "这个功能确实好用。")).toEqual([]);
    expect(collapseIssues("说实话，这事不好办。", "说实话，这事不好办。")).toEqual([]);
  });

  it("冒号引导的列举结构两侧口径一致，不得整批误报（历史 bug）", () => {
    expect(
      collapseIssues("这个方案有三个方面需要考量：第一是成本，第二是效率。", "这个方案有三个方面需要考量：第一是成本。"),
    ).toEqual([]);
  });

  it("嵌套前缀型文本不误杀：短句恰好是长句的严格前缀时（「字」重复串）", () => {
    // 硬门槛既有测试用的就是这种文本（11/15/19… 个"字"），原样返回时不得报任何问题
    const text = [12, 16, 20, 24].map((n) => "字".repeat(n - 1) + "。").join("");
    expect(collapseIssues(text, text)).toEqual([]);
    // 共享词头的正常改写同理：被截的那句若仍在输出里，就不算塌缩
    const o = "这个方案要考量成本。这个方案要考量成本和效率。";
    expect(collapseIssues(o, o)).toEqual([]);
  });

  it("极短小句（<4 字）不参与判定，避免误杀'脑子木。'这类正常口语", () => {
    expect(collapseIssues("脑子木。", "脑子木。")).toEqual([]);
    expect(collapseIssues("今天周三。", "今天周三。")).toEqual([]);
  });

  it("真实引擎全强度全种子输出零误报（择优不能被掐死）", () => {
    // 语料取自元压测的 corpusA 首三段，跑 60 次确定性改写
    const docs = [
      "高位推动顶层设计，各地压茬推进、挂图作战。我们要锚定目标、紧扣主题，牵住牛鼻子、下好先手棋。",
      "我们拉通底层架构，以增长组合拳打透关键路径，通过复盘收敛打法、拉齐认知，最终击穿痛点。",
      "值得注意的是，在当今社会，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，人工智能技术至关重要。",
    ];
    for (const d of docs) {
      for (const intensity of [0.2, 0.5, 0.9, 1.0]) {
        for (let seed = 0; seed < 5; seed++) {
          const out = humanize(d, { intensity, seed });
          expect(collapseIssues(d, out), `${intensity}/${seed}: ${out.slice(0, 40)}`).toEqual([]);
        }
      }
    }
  });
});
