import { describe, it, expect } from "vitest";
import { humanize, applyZhuqueFeatures, aiScore } from "./humanize.ts";
import { classifyGenre } from "./classify-genre.ts";

/**
 * 多段 × 多体裁 结构守恒测试矩阵
 *
 * 缘起：2026-08-26 postmortem（docs/2026-08-26-postmortem-genre-linkage-engine-defects.md）
 * 暴露两个静默失效型缺陷——
 *   1) 场景块保护被前置注入击穿（对话体台词区被塞自问自答）；
 *   2) 多段文本被 splitSentences().trim() 悄悄焊成一段（段落结构丢失）。
 * 根因共性：回归套件样本全部是单段文本，多段 / 多体裁维度零覆盖。
 *
 * 本文件固化以下不变量，堵住同类回归：
 *   A. 段落守恒：多段输入 → 输出段落数 ≥ 输入段落数（强度 ≥0.4 全档）。
 *   B. 场景块保护：对话剧本多段，高强度 + 朱雀增强，多种子下【场景：…】块头原样保留、
 *      台词区不注入自问自答语料。
 *   C. aiScore 不升：多段 × 多体裁去味后本地代理分不高于原文。
 *   D. 人写体裁多段守恒 + 可复现。
 *   E. 固定种子多段可复现。
 *
 * 设计纪律：断言用「下界」而非「严格相等」——结构改写函数（resegmentParagraphsAggressive /
 * structuralShuffleParagraph）允许拆分/合并段，但合并元素内部保留 \n\n，故按 \n\n+ 切分
 * 的段落数只会 ≥ 原始，不会减少。这是 postmortem 缺陷二修复后成立的精确不变量。
 */

/* ----------------------------- 多段样本库（每体裁 ≥3 段） ----------------------------- */

const EXPO_MULTI = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元，占 GDP 的比重达到了 41.8%。

综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等领域的研发投入；其次，企业需要重视数据资产的治理与运营；最后，企业需要培养复合型数字化人才。

最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有真正把数字化战略上升到企业核心战略层面，并脚踏实地去落地执行的企业，才能始终立于不败之地。`;

const NARR_MULTI = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。走到半路，遇见隔壁的小女孩蹲在水坑边叠纸船，裙角湿了一大片。

回到家，我妈正站在厨房窗前看雨。她头也没回，只说了句锅里热着汤。我把湿外套挂在门后，听见雨点砸在雨棚上的声音，忽然觉得这个下午格外安静。`;

const DIALOG_MULTI = `【场景：公司会议室，下午三点】
张总（项目经理）：这个季度的指标完成得怎么样了？
李工（前端负责人）：主流程已经联调完毕，还差两个边界用例。

张总（项目经理）：那明天能不能提测？客户那边催得挺紧。
李工（前端负责人）：可以，今晚我加个班收个尾，明早第一件事就同步给你。

【场景：测试工位，第二天上午】
王姐（测试主管）：提测之后记得同步一份变更清单给我，别又像上次漏了字段。
张总（项目经理）：收到，我让李工整理好发群里。`;

const HUMAN_MULTI = `周末去了趟菜市场。西红柿涨到六块五一斤，摊主说连着下了半个月雨，大棚里光照不够。我挑了几个软硬适中的，又顺路买了半斤饺子皮。

回来的路上太阳出来了，晒得后背发烫。路过巷口，看见邻居家的猫趴在墙头打盹，尾巴有一搭没一搭地甩。我站了一会儿，才慢悠悠往家走。

到家把菜洗了，水龙头的水凉得扎手。窗户开着，能听见楼下小孩在吵，也不知道在争什么。我想，这样一下午，其实也挺好。`;

/* ----------------------------- 工具 ----------------------------- */

/** 输入段落数：与 humanize 内部 text.split(/\n+/) 一致口径 */
const inParas = (t: string) => t.split(/\n+/).filter((p) => p.trim()).length;
/** 输出段落数：humanize 输出统一用 \n\n 作段落分隔 */
const outParas = (t: string) => t.split(/\n\n+/).filter((p) => p.trim()).length;

const QA_MARKERS = [
  "为啥这么说",
  "真的假的",
  "你可能会问",
  "这不是理所当然的吗",
  "不信？那你自己试试",
  "例子呢",
  "有人要抬杠",
];

/* ----------------------------- A. 段落守恒 ----------------------------- */

describe("A. 多段段落守恒（postmortem 缺陷二固化）", () => {
  const cases: [string, string, "main" | "narrative" | "dialogue" | "humanHand"][] = [
    ["论说·多段", EXPO_MULTI, "main"],
    ["叙事·多段", NARR_MULTI, "narrative"],
    ["对话·多段", DIALOG_MULTI, "dialogue"],
    ["人写·多段", HUMAN_MULTI, "humanHand"],
  ];

  for (const [label, text, genre] of cases) {
    for (const intensity of [0.4, 0.7, 0.9] as const) {
      for (const zhuque of [false, true] as const) {
        // humanHand 体裁强制关朱雀 + 钳制强度，zhuque 参数无意义，跳过重复组合
        if (genre === "humanHand" && zhuque) continue;
        const zFlag = zhuque ? "朱雀开" : "朱雀关";
        it(`${label} intensity=${intensity} ${zFlag}：输出段数 ≥ 输入段数`, () => {
          const before = inParas(text);
          const out = humanize(text, { intensity, zhuqueMode: zhuque, genre, seed: 42 });
          const after = outParas(out);
          expect(after).toBeGreaterThanOrEqual(before);
        });
      }
    }
  }
});

/* ----------------------------- B. 场景块保护 ----------------------------- */

describe("B. 对话剧本场景块保护（postmortem 缺陷一固化）", () => {
  // P8 全格式保真承诺：场景块头是元数据，任何注入/机械改写都跳过整行 → 逐字守恒。
  // （relaxColon 改冒号、injectParentheticals 插破折号、injectDialect/错别字污染 均已加护盾）
  it("高强度+朱雀：【场景：…】块头逐字守恒（多种子）", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const out = humanize(DIALOG_MULTI, {
        intensity: 0.9,
        zhuqueMode: true,
        seed,
      });
      expect(out).toContain("【场景：公司会议室，下午三点】");
      expect(out).toContain("【场景：测试工位，第二天上午】");
    }
  });

  it("台词区不注入自问自答语料（多种子 × 负向）", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const out = humanize(DIALOG_MULTI, {
        intensity: 0.9,
        zhuqueMode: true,
        seed,
      });
      for (const m of QA_MARKERS) expect(out).not.toContain(m);
    }
  });

  it("applyZhuqueFeatures 直调：skipSceneInject 全文跳过，无场景块普通文本注入仍存活（双向对照）", () => {
    // 负向：剧本 + skipSceneInject → 不出现 QA，且块头逐字守恒（P8）
    for (let seed = 1; seed <= 20; seed++) {
      const skipped = applyZhuqueFeatures(DIALOG_MULTI, 0.9, seed, "casual", {
        skipSceneInject: true,
      });
      expect(skipped).toContain("【场景：公司会议室，下午三点】");
      expect(skipped).toContain("【场景：测试工位，第二天上午】");
      for (const m of QA_MARKERS) expect(skipped).not.toContain(m);
    }
    // 正向：无场景块的普通多句文本 → 注入机制活着
    const PLAIN =
      "数字化转型是企业发展的重要路径。市场竞争日趋激烈。数据资产的价值不断凸显。人才培养是核心课题。战略布局需要长期投入。研发投入决定技术深度。";
    let seen = false;
    for (let seed = 1; seed <= 60 && !seen; seed++) {
      const out = applyZhuqueFeatures(PLAIN, 0.9, seed, "casual");
      if (QA_MARKERS.some((m) => out.includes(m))) seen = true;
    }
    expect(seen).toBe(true);
  });
});

/* ----------------------------- C. aiScore 不升 ----------------------------- */

describe("C. 多段 × 多体裁去味后 aiScore 不升", () => {
  const cases: [string, string, "main" | "narrative" | "dialogue" | "humanHand"][] = [
    ["论说·多段", EXPO_MULTI, "main"],
    ["叙事·多段", NARR_MULTI, "narrative"],
    ["对话·多段", DIALOG_MULTI, "dialogue"],
    ["人写·多段", HUMAN_MULTI, "humanHand"],
  ];
  for (const [label, text, genre] of cases) {
    it(`${label} intensity=0.9：去味后 score ≤ 原文`, () => {
      const before = aiScore(text);
      const out = humanize(text, { intensity: 0.9, zhuqueMode: true, genre, seed: 7 });
      const after = aiScore(out);
      expect(after.score).toBeLessThanOrEqual(before.score);
    });
  }
});

/* ----------------------------- D. 人写体裁多段守恒 + 可复现 ----------------------------- */

describe("D. 人写体裁多段守恒与可复现", () => {
  it("humanHand 多段：强度 0.9 仍段落守恒（强度被钳制，但结构不破坏）", () => {
    const before = inParas(HUMAN_MULTI);
    for (const seed of [1, 5, 42, 99]) {
      const out = humanize(HUMAN_MULTI, {
        intensity: 0.9,
        zhuqueMode: true,
        genre: "humanHand",
        seed,
      });
      expect(outParas(out)).toBeGreaterThanOrEqual(before);
    }
  });

  it("humanHand：同种子可复现", () => {
    const a = humanize(HUMAN_MULTI, {
      intensity: 0.9,
      zhuqueMode: true,
      genre: "humanHand",
      seed: 42,
    });
    const b = humanize(HUMAN_MULTI, {
      intensity: 0.9,
      zhuqueMode: true,
      genre: "humanHand",
      seed: 42,
    });
    expect(a).toBe(b);
  });
});

/* ----------------------------- E. 体裁判定对多段样本稳定 ----------------------------- */

describe("E. 多段样本自动体裁识别稳定", () => {
  it("论说多段 → main", () => {
    expect(classifyGenre(EXPO_MULTI).genre).toBe("main");
  });
  it("叙事多段 → narrative", () => {
    expect(classifyGenre(NARR_MULTI).genre).toBe("narrative");
  });
  it("对话多段 → dialogue", () => {
    expect(classifyGenre(DIALOG_MULTI).genre).toBe("dialogue");
  });
});

describe("括号守卫（v0.8.6：切句不在括号内切）", () => {
  const SEMI =
    "中国大陆晶圆代工厂（如中芯国际、华虹半导体）近年来在成熟制程领域持续扩张，产能规模已位居全球前列。值得注意的是，根据行业研究机构的数据，2025年全球晶圆代工市场规模将达到1500亿美元，其中成熟制程占比约为35%。与此同时，政策扶持力度不断加大，国产化率稳步提升，因此资本市场对半导体板块的关注度持续升温，产业链协同效应也日益显现出来。";

  it("高强度朱雀档 30 种子：括号不被句号拆断、数量配对", () => {
    for (let seed = 0; seed < 30; seed++) {
      const out = humanize(SEMI, { intensity: 0.9, zhuqueMode: true, seed });
      // 每个句子内括号数量自配对（拆断会在某句内出现孤括号）
      for (const seg of out.split(/(?<=[。！？])/)) {
        const o = (seg.match(/（/g) || []).length;
        const c = (seg.match(/）/g) || []).length;
        if (o !== c) {
          throw new Error(`seed=${seed} 括号被切句拆断：${seg.slice(0, 40)}`);
        }
      }
      expect((out.match(/（/g) || []).length).toBe((out.match(/）/g) || []).length);
    }
  });

  it("中文术语与专名在括号内原样保留", () => {
    for (let seed = 0; seed < 10; seed++) {
      const out = humanize(SEMI, { intensity: 0.9, zhuqueMode: true, seed });
      expect(out).toContain("中芯国际");
      expect(out).toContain("华虹半导体");
    }
  });
});
