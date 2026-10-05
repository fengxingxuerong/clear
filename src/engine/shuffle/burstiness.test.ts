/**
 * burstiness.test.ts —— 节奏增强族（全仓最大覆盖缺口，此前行 79.7%、42 行未覆盖）。
 *
 * 2026-10-05 全面优化验证轮：先钉 6 条主链路与守卫，每条都带**前置条件断言**
 * （先证明"若无该守卫，文本本会被改"），否则断言就是永真式、覆盖率涨了但没防住回归。
 *
 * 主链路（burstiness.ts）：
 *   boostBurstiness → boostBurstinessSingle（切分提节奏，无合规逗号则原样）
 *                   → boostBurstinessFragments（句间注入口语碎片，5 道守卫）
 */
import { describe, it, expect } from "vitest";
import { boostBurstiness, boostBurstinessSingle } from "./burstiness.ts";
import { splitSentences, countPadHeads, PAD_INJECT_CAP } from "../humanize-data.ts";
import { PAD_HEADS } from "../humanize-primitives.ts";

/** 确定性 rng：本组用例只依赖守卫是否生效，不依赖随机数取值 */
const rng = (): number => 0.5;

/** 4 句等长、无逗号、句长<25 的单段：Single 找不到切点保持原样，Fragments 必注入 */
const EQUAL4 =
  "今天天气不错就出去走了走。路上碰到老朋友聊了一会儿天。回家以后简单做了点晚饭吃。晚上躺在床上刷了会儿手机。";

describe("boostBurstinessFragments 主链路（注入口语碎片）", () => {
  it("4 句等长单段 → 注入 3 枚碎片，句数 4→7（v8 类探针靠它拉高句长方差）", () => {
    const out = boostBurstiness(EQUAL4, rng, 0.9);
    // 前置条件：切分阶段不改（无合规逗号），变化只可能来自碎片注入
    expect(boostBurstinessSingle(EQUAL4, rng, 0.9)).toBe(EQUAL4);

    expect(out).not.toBe(EQUAL4);
    expect(out).toContain("就这样。");
    expect(splitSentences(out).length).toBe(7);
    // 原 4 句一字不少（去标点后仅多出三枚碎片的字）
    for (const s of splitSentences(EQUAL4)) expect(out).toContain(s);
  });

  it("style=plain 早退：碎片层不注入，输出与输入逐字一致", () => {
    expect(boostBurstiness(EQUAL4, rng, 0.9, "plain")).toBe(EQUAL4);
  });

  it("style=academic 早退：同上", () => {
    expect(boostBurstiness(EQUAL4, rng, 0.9, "academic")).toBe(EQUAL4);
  });

  it("句数 <4 守卫：3 句不注入", () => {
    const three =
      "今天天气不错就出去走了走。路上碰到老朋友聊了一会儿天。回家以后简单做了点晚饭吃。";
    expect(splitSentences(three).length).toBe(3); // 前置条件
    expect(boostBurstiness(three, rng, 0.9)).toBe(three);
  });

  it("CV≥0.40 守卫：句长已经足够跳脱就不再注入（带阳性对照防永真）", () => {
    const jagged = "好。路上碰到老朋友聊了一会儿天顺便讲了讲近况。回家以后简单做了点晚饭吃。";
    const out = boostBurstiness(jagged, rng, 0.9);
    expect(out).toBe(jagged);

    // 阳性对照：同样三句但改成等长（拉平 CV）就会被注入 → 证明上面的断言不是永真
    const flat =
      "今天天气不错就出去走了走。路上碰到老朋友聊了一会儿天。回家以后简单做了点晚饭吃。今天晚上就刷了会儿手机。";
    expect(boostBurstiness(flat, rng, 0.9)).not.toBe(flat);
  });

  it("垫词饱和守卫（跨轮记忆）：countPadHeads ≥ CAP 时不再注入", () => {
    // 用真实垫词句头（PAD_HEADS，countPadHeads 的统计口径）造满 CAP 个，命中跨轮饱和守卫
    const src = PAD_HEADS.slice(0, PAD_INJECT_CAP)
      .map((w, i) => `${w}这事儿其实很简单第${i}句话。`)
      .join("");
    expect(countPadHeads(src)).toBeGreaterThanOrEqual(PAD_INJECT_CAP); // 前置条件
    expect(boostBurstiness(src, rng, 0.9)).toBe(src);
  });
});

describe("boostBurstiness 场景块与分段保真", () => {
  it("含【场景：…】块头的段落整段跳过，普通段照常注入，段数守恒", () => {
    const paras = [
      EQUAL4,
      "【场景：面馆黄昏】\n张三低头吃了口面。\n李四没抬头。",
      EQUAL4.replace(/今天/g, "那天"),
    ];
    const src = paras.join("\n\n");
    const out = boostBurstiness(src, rng, 0.9);

    expect(out.split("\n\n")).toHaveLength(3); // 段数守恒
    expect(out.split("\n\n")[1]).toBe(paras[1]); // 场景段逐字保留
    expect(out.split("\n\n")[0]).not.toBe(paras[0]); // 普通段被注入
    expect(out).toContain("就这样。");
  });
});
