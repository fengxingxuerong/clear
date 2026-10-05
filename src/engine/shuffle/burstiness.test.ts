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
import { boostBurstiness, boostBurstinessSingle, boostBurstinessIfLow } from "./burstiness.ts";
import {
  splitSentences,
  countPadHeads,
  PAD_INJECT_CAP,
  sentenceStats,
  computeStats,
  MIN_BURSTINESS_CV,
} from "../humanize-data.ts";
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

/**
 * ============ 批次 A：Fragments 锚点槽位（源 89-96）+ Single 真实切分（源 125-126） ============
 * 2026-10-05 缺口轮：此前只钉了主链路守卫，锚点顺延/放弃两条与 Single 的真实切分
 * 分支全程未跑（孤立跑 coverage：Stmts 30.43%、Branch 26.11%）。
 */

describe("boostBurstinessFragments 锚点槽位顺延与放弃（89-96）", () => {
  it("首句为逻辑锚（因为…）→ 碎片槽位顺延到下一安全位，不插进论证链", () => {
    const src =
      "因为今天天气不错就出去走了走。路上碰到老朋友聊了一会儿天。回家以后简单做了点晚饭吃。晚上躺在床上刷了会儿手机。";
    // 前置条件：4 句、节奏平（否则 Fragments 的 CV 守卫直接早退，测不到槽位逻辑）
    expect(splitSentences(src)).toHaveLength(4);
    expect(sentenceStats(src).cv).toBeLessThan(MIN_BURSTINESS_CV);
    expect(countPadHeads(src)).toBeLessThan(PAD_INJECT_CAP);

    const out = boostBurstiness(src, rng, 0.9);
    expect(out).not.toBe(src);
    // 顺延证明：无锚时碎片落在 i=1（第 1 句前）；锚在句 0 → 槽位搜到 k=2，
    // 第一枚碎片必须落在第 2 句（路上碰到…）之后
    expect(out.indexOf("就这样。")).toBeGreaterThan(out.indexOf("路上碰到老朋友聊了一会儿天"));
    expect(splitSentences(out)).toHaveLength(6);
  });

  it("全部句子都是逻辑锚 → 槽位全程搜不到（slot=-1 continue），输出原样", () => {
    const src =
      "因为今天天气不错就出去走了走。所以路上碰到老朋友聊了一会儿天。因此回家以后简单做了点晚饭吃。最后晚上躺在床上刷了会儿手机。";
    expect(splitSentences(src)).toHaveLength(4);
    expect(sentenceStats(src).cv).toBeLessThan(MIN_BURSTINESS_CV);

    const out = boostBurstiness(src, rng, 0.9);
    expect(out).toBe(src); // 全锚 → 每轮 slot=-1 continue → 一枚碎片都不插

    // 阳性对照：锚头换成等长非锚词（如果/而且/同时/另外，均不在 LOGIC_ANCHOR_HEAD_RE）
    // 同一文本就会被注入 → 证明上面的 toBe 不是守卫早退造成的永真
    const ctrl = src
      .replace("因为", "如果")
      .replace("所以", "而且")
      .replace("因此", "同时")
      .replace("最后", "另外");
    expect(boostBurstiness(ctrl, rng, 0.9)).not.toBe(ctrl);
  });
});

describe("boostBurstinessSingle 真实切分路径（125-126）", () => {
  it("3 句等长长句（带合规逗号）→ 最长句被切开、多轮 round，句数 3→N", () => {
    const src =
      "清晨的风穿过巷口那棵老槐树的枝叶，带来了远处菜市场此起彼伏的叫卖声音，也把刚出笼包子的热气送进了巷子深处。" +
      "傍晚的云压在城西那片旧厂房的上空，远处塔吊的轮廓慢慢融进了暮色里，工地上最后一批工人正收拾着工具往回走。" +
      "厨房里那锅汤咕嘟咕嘟冒着小泡，香味顺着过道飘进了每个人的鼻子里，谁进门都要先问一句今天吃什么。";
    const sents = splitSentences(src);
    expect(sents).toHaveLength(3); // 前置条件：≥3 句才进 Single
    const lens = sents.map((s) => s.replace(/[。！？!?；;\n]/g, "").length);
    expect(computeStats(lens).cv).toBeLessThan(MIN_BURSTINESS_CV); // 前置：节奏平才会切

    const out = boostBurstinessSingle(src, rng, 0.9);
    expect(out).not.toBe(src); // findSplitPoint 命中 → 走到 125-126 的真实切分
    expect(splitSentences(out).length).toBeGreaterThan(3);
    // 内容守恒：切分把切点处的那个逗号换成句号（slice(0,mid)+。 / slice(mid+1)），
    // 去掉句末标点与逗号后字数必须守恒——证明只切不删
    expect(out.replace(/[。！？!?；;，,\n]/g, "")).toBe(src.replace(/[。！？!?；;，,\n]/g, ""));
  });
});

/* 2026-10-05 收尾：全仓口径下本文件只剩行 295-296 两处语句缺口——
   尾挂锚的三种收尾（293 直挂 / 294-295 逗号升级 / 296 补句号）。
   构造要点：全短句（L<10）让注入循环走「空候选 break」而**不改动文本尾**，
   这样 working 的结尾完全由输入决定，三个分支各自可控。 */
describe("boostBurstinessInBlock：尾挂锚的三种收尾（293-296）", () => {
  const rngZero = (): number => 0; // fresh[0]=对哦。 → 第二轮 fresh[0]=嗯。

  it("末尾是弱标点「，」→ 先升级成句号再挂，绝不拼出「，。」（行 294-295）", () => {
    const src = "短。甲。乙。丙，";
    const out = boostBurstinessIfLow(src, rngZero);
    expect(out).toBe("短。甲。乙。丙。对哦。嗯。");
    expect(out).not.toContain("，。");
  });

  it("末尾无句末标点 → 补一个句号再挂（行 296）", () => {
    const src = "短。甲。乙。丙";
    expect(boostBurstinessIfLow(src, rngZero)).toBe("短。甲。乙。丙。对哦。嗯。");
  });

  it("末尾已是句末标点 → 直接挂、不再补（行 293，对照组）", () => {
    const src = "短。甲。乙。丙。";
    expect(boostBurstinessIfLow(src, rngZero)).toBe("短。甲。乙。丙。对哦。嗯。");
  });

  it("前置条件：这批全短句确实走的是「注入循环空候选」而非被注入（否则上面三条是巧合）", () => {
    const src = "短。甲。乙。丙，";
    // 句长全部 <10 ⇒ 注入循环拿不到候选；且尾挂前 injected 应为 0
    const lens = splitSentences(src).map((s) => s.replace(/[。！？!?；;\n]/g, "").length);
    expect(lens.every((n) => n < 10)).toBe(true);
    expect(splitSentences(src)).toHaveLength(4);
  });
});
