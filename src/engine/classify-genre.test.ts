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

/**
 * v0.9.51 标签冒号形态排除（诉讼判项标签 / 条目字段标签）
 *
 * 背景：Rule 1 的「台词冒号」在 v0.9.46 排掉了三种非台词形态（新闻转述动词/
 * URL scheme/说明标签），第三批语料又暴露两种同源形态：
 *   C17 判决书    「上诉请求：」「事实和理由：」   → colon=0.286 判 dialogue
 *   C18 招标参数表「项目名称：」「招标编号：」     → colon=0.286 判 dialogue
 * 标签冒号把正式文书打成对话体后，formalRegister（genre==="main"）整层失效：
 * 句尾语气词「呢/呀/嘛」注入判决书（6/13 seed）、条款位移进参数表。
 *
 * 修法口径与 v0.9.46 三条排除一致：只排除「冒号左边白纸黑字是这些形态」的
 * 确定性证据，不碰阈值。本块锁五件事：
 *   ① C17 → main 且 colon 归零（修前 0.286 → dialogue）；
 *   ② C18 → main 且 colon 归零（同源）；
 *   ③ 单标签级：四个诉讼/字段标签逐个排除，不留「靠全文其他句摊薄」的侥幸；
 *   ④ 裸「项目：」刻意不收——对话里真有人说「项目：预算批了」；
 *   ⑤ 「本院认为」由 REPORT_VERB_RE 的「认为」分支覆盖，不重复收（源码级 +
 *      行为级双锁）；真台词不误伤（Rule 1 没被废除）。
 */
describe("v0.9.51 标签冒号排除：诉讼判项与条目字段", () => {
  // 语料与 scripts/realcase/cases.json 同源（src 测试不跨层 import scripts，故抄录）
  const C17_VERDICT =
    "上诉人北京某科技有限公司因与被上诉人李某劳动争议一案，不服北京市海淀区人民法院（2025）海0105民初12345号民事判决，向本院提起上诉。本院于二〇二六年三月十八日立案后，依法组成合议庭进行了审理。本案现已审理终结。某科技公司上诉请求：撤销一审判决，依法改判驳回李某的全部诉讼请求。事实和理由：双方签订的劳动合同约定李某担任算法工程师，试用期为三个月。李某辩称，其在职期间存在加班事实，公司未足额支付加班工资。本院认为，根据《中华人民共和国劳动合同法》第十条、第八十二条之规定，用人单位自用工之日起超过一个月不满一年未与劳动者订立书面劳动合同的，应当向劳动者每月支付二倍的工资。";
  const C18_TENDER =
    "项目名称：智慧园区综合管理平台建设项目。招标编号：HFZB-2026-089。以下技术参数为实质性要求，投标文件须逐项响应，不允许负偏离。一、服务器：2U 机架式，配置不少于 2 颗 32 核处理器，内存容量不低于 512GB，硬盘容量不低于 4TB NVMe SSD，支持 RAID 0/1/5/6。二、网络设备：核心交换机交换容量不低于 12.8Tbps，支持 IPv4/IPv6 双栈。三、软件平台：支持不少于 5000 个物联网终端并发接入，系统可用性不低于 99.99%。投标人须提供所投产品制造商出具的本项目授权及售后服务承诺函原件。";

  it("①C17 判决书 → main 且 dlgColonRatio=0（修前 0.286 判 dialogue）", () => {
    const r = classifyGenre(C17_VERDICT);
    expect(r.genre).toBe("main");
    expect(r.features.dlgColonRatio).toBe(0);
  });

  it("②C18 招标参数表 → main 且 dlgColonRatio=0（同源：修前 0.286）", () => {
    const r = classifyGenre(C18_TENDER);
    expect(r.genre).toBe("main");
    expect(r.features.dlgColonRatio).toBe(0);
  });

  it("③单标签级排除：诉讼判项标签与条目字段标签逐个不计冒号", () => {
    // 每个样本只有一个标签冒号句 + 一句无冒号正文：若对应排除失效，colon 必 = 0.5
    const cases: string[] = [
      "上诉请求：撤销一审判决，依法改判驳回被上诉人的全部诉讼请求，二审诉讼费用由被上诉人承担。本案现已审理终结。",
      "事实和理由：双方签订的劳动合同约定试用期为三个月，公司未足额支付加班工资。上述事实有证据支持。",
      "项目名称：智慧园区综合管理平台建设项目，本项目已经完成立项批复，技术参数详见附件。",
      "招标编号：HFZB-2026-089，本项目已经完成立项批复，技术参数详见后续附件说明。",
    ];
    for (const t of cases) {
      expect(classifyGenre(t).features.dlgColonRatio, `标签句被当成台词：${t.slice(0, 12)}…`).toBe(
        0,
      );
    }
  });

  it("④裸「项目：」刻意不收——字段名必须带「名称/编号」这类确定性后缀", () => {
    // 对话里真有人说「项目：预算批了」。收裸词会把这类真台词误排除。
    const t = "项目：预算批了，下周可以启动，相关的技术参数表已经发到各位手里，请尽快反馈意见。";
    expect(classifyGenre(t).features.dlgColonRatio).toBe(1);
  });

  it("⑤「本院认为」不重复收：由 REPORT_VERB_RE 的「认为」分支覆盖（源码+行为双锁）", () => {
    // 行为面：「本院认为：」必须被排掉（不是漏判）
    const t =
      "本院认为：原审判决认定事实清楚，适用法律正确，应予维持。本案二审诉讼费用由上诉人负担。";
    expect(classifyGenre(t).features.dlgColonRatio).toBe(0);
    // 源码面：LITIGATION_LABEL_RE 里确实没有「本院认为」（重复收会让两条正则
    // 耦合，将来动 REPORT_VERB_RE 时以为还有诉讼标签兜底）
    const src = readFileSync(new URL("./classify-genre.ts", import.meta.url), "utf8");
    const m = /const LITIGATION_LABEL_RE =\s*\/(.+?)\/;/.exec(src);
    expect(m, "前置：classify-genre.ts 里必须还能找到 LITIGATION_LABEL_RE").not.toBeNull();
    expect(m![1]).not.toContain("本院认为");
  });

  it("⑥真台词不误伤：角色前缀冒号照旧判 dialogue（Rule 1 没被排除项废除）", () => {
    const t = `王姐（测试主管）：提测之后记得同步一份变更清单给我。
张总（项目经理）：好的，我记下了，明天上午统一发给相关同事。
李工（前端负责人）：我今晚加个班，把最后的边界用例补齐再提交。`;
    expect(classifyGenre(t).genre).toBe("dialogue");
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
