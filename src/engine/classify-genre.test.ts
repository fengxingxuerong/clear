import { describe, it, expect } from "vitest";
import { classifyGenre } from "./classify-genre.ts";
import { humanize, applyZhuqueFeatures } from "./humanize.ts";
import { mechanicalShuffle } from "./humanize-shuffle.ts";
import { aiScore } from "./humanize-metrics.ts";

/* P6/P7 行为固化测试：体裁识别 + 引擎级体裁联动（knobs / 强制P3 / humanHand钳制 / 场景块跳过） */

const EXPO_TEXT = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大研发投入；其次，企业需要重视数据资产治理；最后，企业需要培养复合型人才。值得注意的是，数字化转型至关重要。`;

const NARR_TEXT = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。我点点头，继续往前走，鞋子里灌满了水。`;

const DIALOG_SCRIPT = `【场景：公司会议室，下午三点】
张总（项目经理）：这个季度的指标完成得怎么样了？
李工（前端负责人）：主流程已经联调完毕，还差两个边界用例。
张总（项目经理）：那明天能不能提测？
李工（前端负责人）：可以，今晚我加个班收个尾。
王姐（测试主管）：提测之后记得同步一份变更清单给我。`;

const HUMAN_TEXT = `周末去了趟菜市场。西红柿涨到六块五一斤，摊主说连着下了半个月雨，大棚里光照不够。我挑了几个软硬适中的，又顺路买了半斤饺子皮。回来的路上太阳出来了，晒得后背发烫。`;

describe("P6 classifyGenre 自动体裁识别", () => {
  it("论说文 → main", () => {
    expect(classifyGenre(EXPO_TEXT).genre).toBe("main");
  });
  it("叙事文 → narrative", () => {
    expect(classifyGenre(NARR_TEXT).genre).toBe("narrative");
  });
  it("剧本式对话体（【场景块】+ 角色前缀冒号行）→ dialogue", () => {
    const r = classifyGenre(DIALOG_SCRIPT);
    expect(r.genre).toBe("dialogue");
    expect(r.features.dlgSceneBlockRatio).toBeGreaterThan(0);
  });
  it("短文本/空输入不崩溃且有兜底返回", () => {
    expect(["main", "narrative", "dialogue"]).toContain(classifyGenre("").genre);
    expect(classifyGenre("好。").genre).toBeDefined();
  });
});

describe("P7 引擎级体裁联动", () => {
  it("opts.genre=humanHand：强度被钳制且输出可复现", () => {
    const a = humanize(EXPO_TEXT, {
      intensity: 0.9,
      zhuqueMode: true,
      genre: "humanHand",
      seed: 42,
    });
    const b = humanize(EXPO_TEXT, {
      intensity: 0.9,
      zhuqueMode: true,
      genre: "humanHand",
      seed: 42,
    });
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("humanHand 降级行为可区分：高强度下与人写稿钳制档不同", () => {
    const clamped = humanize(EXPO_TEXT, {
      intensity: 0.9,
      zhuqueMode: true,
      genre: "humanHand",
      seed: 42,
    });
    const main = humanize(EXPO_TEXT, { intensity: 0.9, zhuqueMode: true, seed: 42 });
    // 真降级：main@0.9 会注入自问自答/垫词，humanHand 一律不注入
    expect(clamped).not.toBe(main);
    // 且注入痕迹只能出现在 main 那侧（反向断言，防"两边都不注入"把差异混掉）
    expect(main.length).toBeGreaterThan(clamped.length);
  });

  it("humanHand 强度硬钳制到 ≤0.48：0.9 与 0.48 两档输出必须逐字相同", () => {
    const at09 = humanize(EXPO_TEXT, {
      intensity: 0.9,
      zhuqueMode: true,
      genre: "humanHand",
      seed: 42,
    });
    const at048 = humanize(EXPO_TEXT, {
      intensity: 0.48,
      zhuqueMode: true,
      genre: "humanHand",
      seed: 42,
    });
    expect(at09).toBe(at048);
  });

  it("mechanicalShuffle 独立入口也吃 genre 联动", () => {
    const out = mechanicalShuffle(EXPO_TEXT, {
      intensity: 0.9,
      zhuqueMode: true,
      genre: "main",
      seed: 7,
    });
    expect(out.length).toBeGreaterThan(0);
    const hh = mechanicalShuffle(HUMAN_TEXT, {
      intensity: 0.9,
      zhuqueMode: true,
      genre: "humanHand",
      seed: 7,
    });
    expect(hh.length).toBeGreaterThan(0);
  });

  it("对话体剧本场景块：skipSceneInject=true 台词区永不注入自问自答", () => {
    const QA_MARKERS = [
      "为啥这么说",
      "真的假的",
      "你可能会问",
      "这不是理所当然的吗",
      "不信？那你自己试试",
      "例子呢",
      "有人要抬杠",
    ];
    for (let seed = 1; seed <= 30; seed++) {
      const skipped = applyZhuqueFeatures(DIALOG_SCRIPT, 0.9, seed, "casual", {
        skipSceneInject: true,
      });
      expect(skipped).toMatch(/【场景：[^】]*下午三点[^】]*】/);
      for (const m of QA_MARKERS) expect(skipped).not.toContain(m);
    }
    // 正向对照：无场景块的普通多句文本（≥5 句），注入机制应正常触发
    const PLAIN_EXPO =
      "数字化转型是企业发展的重要路径。市场竞争日趋激烈。数据资产的价值不断凸显。人才培养是核心课题。战略布局需要长期投入。研发投入决定技术深度。";
    let qaSeen = false;
    for (let seed = 1; seed <= 60 && !qaSeen; seed++) {
      const out = applyZhuqueFeatures(PLAIN_EXPO, 0.9, seed, "casual");
      if (QA_MARKERS.some((m) => out.includes(m))) qaSeen = true;
    }
    expect(qaSeen).toBe(true);
  });

  it("论说 main 高强度：套话命中与 AI 指纹分均不升（P3 生效间接证据）", () => {
    const rawScore = aiScore(EXPO_TEXT);
    const out = humanize(EXPO_TEXT, { intensity: 0.9, zhuqueMode: true, genre: "main", seed: 1 });
    const outScore = aiScore(out);
    expect(outScore.formulaicHits).toBeLessThanOrEqual(rawScore.formulaicHits);
    expect(outScore.score).toBeLessThanOrEqual(rawScore.score);
  });

  it("humanize 主入口联动：自动识别 dialogue 全文跳过自问自答，普通论说机制仍在", () => {
    // casual 表演型池的独有 marker —— 只用于「对话体裁不该出现」的负向断言
    const CASUAL_QA_MARKERS = [
      "为啥这么说",
      "真的假的",
      "你可能会问",
      "这不是理所当然的吗",
      "不信？那你自己试试",
      "例子呢",
      "有人要抬杠",
    ];
    for (let seed = 1; seed <= 20; seed++) {
      const out = humanize(DIALOG_SCRIPT, { intensity: 0.9, zhuqueMode: true, seed });
      for (const m of CASUAL_QA_MARKERS) expect(out).not.toContain(m);
    }
    // 正向断言：论说体裁下自问自答机制应生效。
    //
    // v0.9.8 P0 收敛（七）后默认风格是 plain，走 injectSelfQA 的**克制型池**
    // （「为什么呢？原因其实不复杂。」…），不含 casual 那组表演型 marker。
    // 故正向探针改用两种池的共有形态：疑问句 + 紧随其后的短答句。
    let positiveSeen = false;
    for (let seed = 1; seed <= 40 && !positiveSeen; seed++) {
      const out = humanize(EXPO_TEXT, { intensity: 0.9, zhuqueMode: true, seed });
      if (/[？?][^。！？!?]{0,20}[。！]/u.test(out)) positiveSeen = true;
    }
    expect(positiveSeen).toBe(true);
  });
});
