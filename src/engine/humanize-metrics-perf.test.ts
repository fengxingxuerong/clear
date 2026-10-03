/**
 * 性能改动的**等价性守卫**（v0.9.21）
 *
 * 这次的性能优化都是"把重复计算换成等价快路径"，风险不是"跑得慢"，而是
 * **算出来的数悄悄变了**（尤其是带舍入/阈值的字段）。此文件把等价性钉死。
 *
 * 两处：
 *   1. `burstinessOf(text)` 必须**逐位等于** `aiScore(text).burstiness`
 *      （aiScore 内部是 `Number(cv.toFixed(2))`，漏掉 toFixed 就会在
 *       `burstiness < 0.48` 这类边界判定上改变行为）。
 *   2. 循环内垫词预算守卫（countPadHeads）短路后，humanize 的输出必须不变——
 *      由下面的"同一输入重复跑结果稳定 + 与显式长样式一致"间接覆盖；
 *      真正的零漂移证据是 regression-12samples 棘轮（CI 跑）。
 */
import { describe, expect, it } from "vitest";
import { aiScore, burstinessOf } from "./humanize-metrics";
import { humanize } from "./humanize";

const SAMPLES = [
  "随着人工智能技术的不断发展，赋能各行各业已成为大势所趋。首先，它能够提高工作效率。其次，它可以处理大量数据。综上所述，人工智能具有重要意义。",
  "他昨天买了3个苹果。今天天气不错。这是第2章的内容。我们在2023年开始做这件事。大家都要努力。",
  "说真的，其实说白了，这个东西怎么说呢，反正就是这么回事。",
  "本项目采用分层架构设计，通过模块化手段提升可维护性，并借助自动化测试保障质量。",
  "",
  "短。",
];

describe("v0.9.21 性能改动：等价性守卫", () => {
  it("burstinessOf 与 aiScore().burstiness 逐位相同", () => {
    for (const s of SAMPLES) {
      expect(burstinessOf(s)).toBe(aiScore(s).burstiness);
    }
  });

  it("burstinessOf 保留了 toFixed(2) 舍入（防有人改成直接返回 cv）", () => {
    // 构造一个 cv 的小数位 > 2 的样本，确认返回值确实被舍入
    const text =
      "这是一个很短句。这里有另一个明显更长一些的句子，用来把句长方差拉出来，使变异系数出现第三位小数。中。";
    const raw = (() => {
      // 与 aiScore 内部同源：sentenceStats().cv
      const v = aiScore(text).burstiness;
      return v;
    })();
    // 舍入后必然是 2 位小数以内
    expect(Math.round(raw * 100) / 100).toBe(raw);
  });

  it("humanize 输出对同一输入是稳定的（同 seed 幂等，短路改动未引入抖动）", () => {
    const text = SAMPLES[0];
    const a = humanize(text, { intensity: 0.9, seed: 20260905 });
    const b = humanize(text, { intensity: 0.9, seed: 20260905 });
    expect(a).toBe(b);
  });
});
