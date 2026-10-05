import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

/**
 * 冒号台词特征的字符类修复（2026-10-05 探针实证）
 *
 * 起因：字符类尾部原写作 `（）()【】[]]`，其中**裸的 `[` 让字符类提前闭合**，
 * 整条正则恒不匹配。实测「阿明：这周汇报」「张总（项目经理）：指标」
 * 「主持人_小A：大家好」全部 false —— dlgColonRatio 恒为 0，
 * Rule 1 里 `dlgColonRatio >= 0.06` 这条单特征路径、以及 dlgComboScore 里的
 * 0.3 权重**都是从未生效过的死分支**。对话体此前只靠场景块/引号/短句占比兜住。
 *
 * 这类"恒为常量"的缺陷覆盖率工具抓不到（行被执行了，只是结果永远错），
 * 只能靠**断言具体数值**钉住。
 */
describe("冒号台词特征（字符类修复的防复发）", () => {
  const COLON_SCRIPT = `【场景：咖啡馆】
阿明：这周的进度汇报准备好了吗？我下午要交给主管过目。
小美：已经整理完了，附件里是全部的明细表格。
阿明：很好，那我们两点开个短会讨论下周的排期。`;

  it("剧本式角色前缀（中文冒号）→ dlgColonRatio 必须为正（修前恒为 0）", () => {
    const f = classifyGenre(COLON_SCRIPT).features;
    // 4 句里 3 句是「角色：」，首句是【场景：】块 → 3/4 = 0.75（实测值）
    expect(f.dlgColonRatio).toBeCloseTo(0.75, 5);
  });

  it("括号式角色前缀「张总（项目经理）：」也能命中", () => {
    const t = `张总（项目经理）：这个季度的指标完成得怎么样了？
李工（前端负责人）：主流程已经联调完毕，还差两个边界用例。
王姐（测试主管）：提测之后记得同步一份变更清单给我。`;
    expect(classifyGenre(t).features.dlgColonRatio).toBeGreaterThan(0);
  });

  it("含下划线的网名式「主持人_小A：」也能命中", () => {
    const t = `主持人_小A：今天的议题是发布节奏的确认。
主持人_小B：那我们先过一遍当前的阻塞项。
主持人_小A：好，第一项是测试环境的稳定性问题。`;
    expect(classifyGenre(t).features.dlgColonRatio).toBeGreaterThan(0);
  });

  it("纯叙述文本不含冒号台词 → dlgColonRatio 仍为 0（不误伤）", () => {
    const t =
      "那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑。";
    expect(classifyGenre(t).features.dlgColonRatio).toBe(0);
  });

  it("分句后独立成句的「时间：…」算命中——分句先于冒号判定", () => {
    // 这条固化的是**执行顺序**，不是"冒号必须句首"：
    // 「他说时间：下午三点开会。」先被切成 3 句，「时间：下午三点开会。」成为句首，
    // 于是命中 1/3 = 0.3333。冒号特征是在**分句之后**才算的（classify-genre.ts:135），
    // 所以"原句里的句中位置"到这一步早已不存在。
    const t = "他说时间：下午三点开会。然后就走了，再也没有回来过。这个下午显得特别漫长。";
    expect(classifyGenre(t).features.dlgColonRatio).toBeCloseTo(1 / 3, 5);
  });

  it("字符类修复不能被改回去：正则里 `[` 必须转义", () => {
    // 反向断言：这条专门防「顺手优化正则」时把转义去掉。少了 `\[` 整条正则又会恒不匹配，
    // 而上面几条正向断言仍会通过一部分——所以必须单列一条钉源码形态。
    const src = readFileSync(new URL("./classify-genre.ts", import.meta.url), "utf8");
    const line = src.split("\n").find((l) => l.includes("const colonRe"));
    expect(line).toBeDefined();
    // 类内出现裸的 `[`（后面不跟 `\`）即视为复发
    expect(line).toContain("【】\\[");
  });

  it("eslint 豁免注释与转义绑在同一处，不会被拆散", () => {
    // `\[` 会触发 no-useless-escape，豁免注释必须紧贴它。少了注释 eslint 会红（好）；
    // 少了转义 lint 仍绿但行为坏——所以真正的主防线是上面那条正向断言，
    // 这条只保证「豁免与转义不分离」，不会留下一个孤零零的裸豁免。
    const src = readFileSync(new URL("./classify-genre.ts", import.meta.url), "utf8");
    const idx = src.indexOf("const colonRe");
    const prev = src.slice(0, idx).split("\n").slice(-2).join("\n");
    expect(prev).toContain("eslint-disable-next-line no-useless-escape");
    expect(prev).toContain("恒不匹配");
  });
});

describe("classifyGenre 短文本兜底（覆盖行 64/121）", () => {
  it("空串 → 全零特征 + ruleHit=4 兜底", () => {
    const r = classifyGenre("");
    expect(r.features.pureChars).toBe(0);
    expect(r.features.sentCount).toBe(0);
    expect(r.ruleHit).toBe(4);
    expect(r.confidence).toBe(0.3);
  });

  it("不足 30 字 → 同样走 ruleHit=4 兜底", () => {
    expect(classifyGenre("啊".repeat(29)).ruleHit).toBe(4);
  });

  it("总长 ≥30 但纯字 <20（靠标点凑长）→ ruleHit=4、confidence=0.35（走另一档兜底）", () => {
    // 与「不足 30 字」区分开：这条走的是行 121 的纯字判定，置信度不同
    const t = "！。，！？、；：……——————" + "，，，。！".repeat(8);
    expect(t.length).toBeGreaterThanOrEqual(30);
    const r = classifyGenre(t);
    expect(r.features.pureChars).toBe(0);
    expect(r.ruleHit).toBe(4);
    expect(r.confidence).toBe(0.35);
  });
});
