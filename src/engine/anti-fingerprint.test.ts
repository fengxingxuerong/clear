/**
 * v0.9 反「新指纹」层单元测试
 * 覆盖：模板复读封顶 / 语体门控 / 双连接词拆解（含 $1 bug 回归）/ 残句守卫 / 场景块保护
 */
import { describe, it, expect } from "vitest";
import {
  capLongTemplateRepetition,
  guardFormalRegister,
  collapseDoubleConnectives,
  fixOrphanConnectiveLeads,
  isSceneMetaSentence,
} from "./anti-fingerprint";
import { humanize } from "./humanize";

describe("capLongTemplateRepetition（模板复读封顶）", () => {
  it("同模板复读只保留首次", () => {
    const out = capLongTemplateRepetition(
      "A。例子呢？我随便举一个你就懂了。B。例子呢？我随便举一个你就懂了。C。",
    );
    // 第二次出现被删除，全文仅剩 1 处
    expect((out.match(/我随便举一个你就懂了/g) ?? []).length).toBe(1);
    expect(out).toBe("A。例子呢？我随便举一个你就懂了。B。C。");
  });

  it("容忍模板被语气词拆散后仍去重", () => {
    // injectSelfQA 注入后可能被 boost 环节拆成"例子呢是啊？我随便举一个你就懂了"
    const out = capLongTemplateRepetition(
      "A。例子呢是啊？我随便举一个你就懂了。B。例子呢？我随便举一个你就懂了。C。",
    );
    expect((out.match(/我随便举一个你就懂了/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("不同模板扎堆（总量超预算）时删尾部", () => {
    const text =
      "A。例子呢？我随便举一个你就懂了。真的假的？这事儿还真不是我瞎编。为啥这么说？因为事实就摆在眼前。你可能会问——这不是理所当然的吗？有人要抬杠了。B。";
    const out = capLongTemplateRepetition(text);
    const hits = [
      "例子呢",
      "我随便举一个你就懂了",
      "真的假的",
      "这事儿还真不是我瞎编",
      "为啥这么说",
      "因为事实就摆在眼前",
      "你可能会问",
      "有人要抬杠了",
      "其实不然",
    ].filter((p) => out.includes(p));
    expect(hits.length).toBeLessThanOrEqual(4);
  });

  it("删除后不留坏标点（——。、，，）", () => {
    const out = capLongTemplateRepetition(
      "时间节点——。于是……你可能会问——这不是理所当然的吗？其实不然。然后，，继续。",
    );
    expect(out).not.toContain("——。");
    expect(out).not.toContain("，，");
  });
});

describe("guardFormalRegister（语体门控）", () => {
  it("正式语体还原过度口语替换", () => {
    const out = guardFormalRegister(
      "麻利发展是大势所趋，总的来瞅问题不大，唠到底还是值得投入。",
      true,
    );
    expect(out).toContain("快速发展");
    expect(out).toContain("总的来说");
    expect(out).toContain("归根到底");
    expect(out).not.toContain("麻利");
    expect(out).not.toContain("唠到底");
  });

  it("非正式语体不还原", () => {
    const out = guardFormalRegister("麻利发展是大势所趋。", false);
    expect(out).toContain("麻利");
  });
});

describe("collapseDoubleConnectives（双连接词叠放拆解）", () => {
  it("双连接词只留一个", () => {
    const out = collapseDoubleConnectives("我感觉，总的来瞅，问题不大。");
    expect(out).toContain("我感觉，");
    expect(out).not.toContain("总的来瞅");
  });

  it("不输出字面 $1（v0.9 回归锚点：全部 (?:) 非捕获组曾致输出 '$1，'）", () => {
    const out = collapseDoubleConnectives("说白了，总的来瞅，这事儿还行。");
    expect(out).not.toContain("$");
  });
});

describe("fixOrphanConnectiveLeads（残句开头守卫）", () => {
  it("删除句首独词连接词", () => {
    const out = fixOrphanConnectiveLeads("并提前暴露可能存在的风险点。");
    expect(out).toContain("提前暴露可能存在的风险点");
    expect(out).not.toMatch(/^并/);
  });

  it("不吞并独立语气短句（CV 来源保护）", () => {
    const out = fixOrphanConnectiveLeads("技术很重要。就这样。你懂的。");
    expect(out).toContain("就这样。");
    expect(out).toContain("你懂的。");
  });
});

describe("isSceneMetaSentence（场景块行识别）", () => {
  it("识别剧本块头行", () => {
    expect(isSceneMetaSentence("【场景：一家创业公司的会议室】")).toBe(true);
    expect(isSceneMetaSentence("【人物：张总、李工】")).toBe(true);
    expect(isSceneMetaSentence("张总（项目经理）：大家早上好。")).toBe(false);
  });
});

describe("v0.9 引擎集成（对话剧本场景块保护 + 指纹健康）", () => {
  it("对话 0.9 档：场景块头不被语气词污染，且指纹通过", () => {
    const dialogue = `【场景：一家创业公司的会议室，周一上午的项目周会】

张总（项目经理）：大家早上好，今天我们来开本周的项目周会。值得注意的是，下周就是产品 V2.0 正式上线的时间节点，因此今天的议题主要围绕上线前的最后一轮准备工作展开。综上所述，希望各位同事能够逐一汇报各自负责模块的当前进度，并提前暴露可能存在的风险点。

李工（前端负责人）：张总您好，我这边负责的前端模块目前进展比较顺利。具体来说，所有核心功能页面的开发工作已经完成了百分之九十五以上，剩下的就是一些 UI 细节的微调以及和后端接口的最后联调。与此同时，我们也对移动端的适配做了一轮全面的回归测试，整体兼容性表现良好。不过需要提醒大家的是，支付模块最近做了一次比较大的重构，我建议今天下午安排一次压力测试来确保稳定性。`;
    const out = humanize(dialogue, {
      intensity: 0.9,
      zhuqueMode: true,
      seed: 20260826,
      genre: "dialogue",
    });
    // 场景块头原样保留（不得被注入语气词）
    const sceneLine = out.split("\n")[0] ?? "";
    expect(sceneLine).toBe("【场景：一家创业公司的会议室，周一上午的项目周会】");
    // 不残留 $1 与坏标点
    expect(out).not.toContain("$1");
    expect(out).not.toContain("——。");
    expect(out).not.toContain("，，");
  });

  it("论说 0.9 档：正式语体下不出现「麻利」等口语替换，模板不扎堆", () => {
    const expo = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元人民币，占 GDP 的比重达到了 41.8%，较上一年度同比提升了 2.3 个百分点。值得注意的是，这一增长速度已经连续八年保持在 15% 以上，充分体现了数字经济作为国民经济核心增长引擎的强大动力与韧性。`;
    const out = humanize(expo, { intensity: 0.9, zhuqueMode: true, seed: 20260826, genre: "main" });
    expect(out).not.toContain("麻利");
    expect(out).not.toContain("$1");
    // 模板总量受控（扎堆抑制）
    const templateHits = [
      "例子呢",
      "我随便举一个你就懂了",
      "真的假的",
      "你可能会问",
      "其实不然",
      "有人要抬杠了",
    ].filter((p) => out.includes(p));
    expect(templateHits.length).toBeLessThanOrEqual(4);
  });
});
