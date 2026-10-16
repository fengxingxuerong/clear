/**
 * v0.9 反「新指纹」层单元测试
 * 覆盖：模板复读封顶 / 语体门控 / 双连接词拆解（含 $1 bug 回归）/ 残句守卫 / 场景块保护
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  capLongTemplateRepetition,
  guardFormalRegister,
  collapseDoubleConnectives,
  fixOrphanConnectiveLeads,
  isSceneMetaSentence,
  isSceneMetaLine,
  fixBrokenCollocations,
  isSpecTableParagraph,
} from "./anti-fingerprint";
import { humanize } from "./humanize";
import { splitSentences } from "./humanize-text";
import { SELF_QA_POOLS } from "./shuffle/structure";

describe("capLongTemplateRepetition（模板复读封顶）", () => {
  it("同模板复读只保留首次", () => {
    const out = capLongTemplateRepetition(
      "A。例子呢？我随便举一个你就懂了。B。例子呢？我随便举一个你就懂了。C。",
    );
    // 第二次出现被删除，全文仅剩 1 处
    expect((out.match(/我随便举一个你就懂了/g) ?? []).length).toBe(1);
    expect(out).toBe("A。例子呢？我随便举一个你就懂了。B。C。");
  });

  it("v0.9.23 回归：同一输入连调结果必须完全一致（状态污染会让结果随调用次数漂移）", () => {
    // ⚠️ 诚实标注（2026-10-04 缺陷注入实测）：**这条对本缺陷不敏感**。
    //   把 reset 去掉 + split 改回去（双注入）后，本条**仍然绿**——lastIndex 泄漏是
    //   **确定性**的，同一输入每次调用走完全相同的状态轨迹，结果自然一致。
    //   它只在**不同输入交替**时才可能显现，而那依赖具体长度/位置，做过一次复现序列
    //   （短文本×3 再跑长文本），实测也不产生差异 ⇒ 已撤下，不拿它冒充主力断言。
    //
    //   留着它的理由：它是"结果不得随调用历史漂移"的通用守卫，能抓**其他**形态的状态泄漏。
    //   本缺陷的主力断言是下面那条**源码级**守卫。
    const input =
      "A。例子呢？我随便举一个你就懂了。B。例子呢？我随便举一个你就懂了。C。例子呢？我随便举一个你就懂了。";
    const first = capLongTemplateRepetition(input);
    for (let i = 2; i <= 6; i++) {
      expect(
        capLongTemplateRepetition(input),
        `第 ${i} 次调用结果与第 1 次不同 → 模块级正则的 lastIndex 泄漏了`,
      ).toBe(first);
    }
    // 顺带钉住"确实去重了"，避免"全都相等但都没删"也能通过
    expect((first.match(/例子呢？/g) ?? []).length).toBe(1);
  });

  it("v0.9.23 守卫（主力）：模块级 g 正则必须显式归零，且不得按源码字符串切分", () => {
    // 这是本缺陷**唯一真正敏感**的断言（双注入验证：只有它变红）。
    // ① 17 条模板当前全是纯字面量，split(re.source) 才碰巧与 replace(re,"") 等价；
    //    一旦有人加一条含 \d / (?:…) / 量词的模板，它就会切不到 → 静默不删。
    // ② replace(re,"") 自带归零，reset 是纵深；两者都在时任一被拆掉都不出事，
    //    但**同时**拆掉就回到原缺陷，而端到端抓不到 ⇒ 只能靠源码级钉住。
    const src = readFileSync(new URL("./anti-fingerprint.ts", import.meta.url), "utf-8");
    expect(src, "不得再按正则源码字符串切分").not.toContain(".split(re.source)");
    expect(src, "带 g 的模块级正则 exec 前必须 lastIndex = 0").toContain("re.lastIndex = 0");
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

  /**
   * isSceneMetaLine 是**死代码**，但先钉住行为再决定要不要删。
   *
   * 探针实测：它与 isSceneMetaSentence 的函数体**逐字相同**（都只做
   * `SCENE_LINE_RE.test(s)`），11 个用例结果逐条一致。
   * 而全项目**只有 isSceneMetaSentence 被调用**（humanize.ts:1108）。
   *
   * 为什么不直接删：本文件的纪律是「不为凑覆盖率改生产源码」，
   * 而删函数属于行为变更，需要单独决策。留这条测试的作用是——
   * 如果将来有人真的删掉 isSceneMetaLine，这里会红，提醒他确认
   * 「确认无人调用」这个前提（而不是以为漏改了）。
   */
  it("isSceneMetaLine 与 isSceneMetaSentence 行为一致（前者当前无人调用）", () => {
    const cases = [
      "【场景：一家创业公司的会议室】",
      "【人物：张总、李工】",
      "【时间：周一上午】",
      "【背景：2024年的深圳】",
      "【旁白】",
      "【简介】",
      "【场景】",
      "张总（项目经理）：大家早上好。",
      "这是一句正常台词。",
      "",
      // 超过 {0,80} 的块头不算——探针实测 false，与 Sentence 一致
      `【场景超长${"x".repeat(200)}】`,
    ];
    for (const c of cases) {
      expect(isSceneMetaLine(c), c).toBe(isSceneMetaSentence(c));
    }
  });

  it("块头关键词表边界：超出 80 字上限的块头不算场景行", () => {
    // 正则是 /【[^】]{0,80}(?:场景|…)…】，所以关键词前后各自最多 80 字
    expect(isSceneMetaSentence("【场景】")).toBe(true);
    expect(isSceneMetaSentence(`【场景超长${"x".repeat(200)}】`)).toBe(false);
  });
});

describe("复读表与模板池对齐（默认风格转 plain 后漏掉的整池）", () => {
  // 2026-10-01：本表此前**只覆盖 casual 池**（"你可能会问——…""例子呢？…"），
  // 而 v0.9.8 起默认风格已是 plain ⇒ 默认路径上注入的模板一条都不在管辖内。
  // 实测代价：plain 池 6 条、逐段各注入 1 次，两段撞同一条概率 1/6，
  // 5 个种子里复现 1 次整对连出两遍（「是不是只有这一种解释？未必，但这一种最直接。」）。
  //
  // 这组测试**遍历模板池本身**，不硬编码条目 —— 以后池子再扩、
  // 或再新增一个文风池，忘了同步复读表会立刻在这里红，不用等人眼再发现第四次。
  for (const [style, pool] of Object.entries(SELF_QA_POOLS)) {
    for (const [q, a] of pool) {
      it(`${style} 池「${q}」整对复读 → 第二次被删，全文只剩 1 次`, () => {
        const tpl = q + a;
        const text = `开头一句。${tpl}中间一句。${tpl}收尾一句。`;
        const out = capLongTemplateRepetition(text);
        expect(out.split(tpl).length - 1, `复读未被去重：${tpl}`).toBe(1);
        // 且不能把首次出现也删掉（防"过度删除"这个反向失效）
        expect(out).toContain(tpl);
      });
    }
  }
});

/**
 * isSpecTableParagraph（v0.9.51）——参数表/技术规格表形态判据
 *
 * 背景：C18 招标参数表实测（0.9 档 seed 20261015）三层破坏全溯源到
 * structuralShuffleParagraph 一层：条目被打散成 5 句、「实质性要求」条款
 * 被搬进参数中间（改写事实级）、参数后挂「为什么呢？」。修法是用一个
 * 双条件形态判据把参数表段整段跳过，并顺带堵住六条切句/重排/注入路径
 * （结构层、劈句、合并、boostBurstinessSingle、三处 boostBurstinessByCutting、
 * clampAvgSentenceLenUnder25，见 humanize.ts）。
 *
 * 判据刻意双条件（≥2 条目头 + ≥2 参数谓词），防把无缺陷的条款文本一起误伤。
 * ⚠️ 首版条目头正则只锚 `^|\n`，而单段文本里「……不允许负偏离。一、服务器：」
 * 的条目头跟在**句号**后 ⇒ 判据恒 false、残留全没治住。前置字符
 * `(?:^|[。\n；])` 是这次修复的核心，用例 ⑤ 专门锁它。
 */
describe("isSpecTableParagraph（参数表形态判据）", () => {
  // 与 scripts/realcase/cases.json 同源（src 测试不跨层 import scripts，故抄录）
  const C18_TENDER =
    "项目名称：智慧园区综合管理平台建设项目。招标编号：HFZB-2026-089。以下技术参数为实质性要求，投标文件须逐项响应，不允许负偏离。一、服务器：2U 机架式，配置不少于 2 颗 32 核处理器，内存容量不低于 512GB，硬盘容量不低于 4TB NVMe SSD，支持 RAID 0/1/5/6。二、网络设备：核心交换机交换容量不低于 12.8Tbps，支持 IPv4/IPv6 双栈。三、软件平台：支持不少于 5000 个物联网终端并发接入，系统可用性不低于 99.99%。投标人须提供所投产品制造商出具的本项目授权及售后服务承诺函原件。";
  const C11_NOTICE =
    "各区县工业和信息化主管部门，各有关单位：现将《合肥市智能制造成熟度评估实施细则》印发给你们，请结合实际认真贯彻落实。第一条　本细则适用于本市行政区域内规模以上制造业企业的智能制造成熟度评估工作。第二条　评估工作应当遵循自愿申报、分级认定、动态管理的原则，评估结果有效期为三年。第三条　市经济和信息化局负责统筹协调，委托第三方机构组建专家库，每批次随机抽取不少于七名专家。第四条　申报单位需提交近三个会计年度的财务审计报告、不少于五个智能化改造场景的说明材料。第五条　本细则自印发之日起三十日后施行，原合经信〔2024〕36 号文件同时废止。合肥市经济和信息化局　二〇二六年九月二十八日";

  it("①C18 招标参数表命中（双条件齐：3 条目头 + 5 参数谓词）", () => {
    expect(isSpecTableParagraph(C18_TENDER)).toBe(true);
  });

  it("②C11 行政通知不误伤（「第一条」是第X条形态，不算「一、」条目头）", () => {
    expect(isSpecTableParagraph(C11_NOTICE)).toBe(false);
  });

  it("③条目头够但参数谓词不够 → 不命中（公文条文体）", () => {
    const articles =
      "一、本细则适用于本市行政区域内规模以上制造业企业的评估工作。" +
      "二、评估工作应当遵循自愿申报、分级认定、动态管理的原则，结果有效期为三年。" +
      "三、市经济和信息化局负责统筹协调，委托第三方机构组建专家库。";
    expect(isSpecTableParagraph(articles)).toBe(false);
  });

  it("④谓词够但条目头不够 → 不命中（单规格段的散文式表述）", () => {
    const single =
      "服务器配置不少于 2 颗 32 核处理器，内存容量不低于 512GB，硬盘容量不低于 4TB NVMe SSD。";
    expect(isSpecTableParagraph(single)).toBe(false);
  });

  it("⑤条目头跟在句号后（单段无换行）必须计数——首版恒 false 的回归", () => {
    // 前置字符 `(?:^|[。\\n；])`：句号/分号/换行/行首都算。
    // 只锚 `^|\\n` 时这段 0 匹配（C18 正是单段文本）。
    const afterPeriod =
      "以下技术参数为实质性要求。一、服务器：配置不少于 2 颗 32 核处理器。二、网络设备：交换容量不低于 12.8Tbps。";
    expect(isSpecTableParagraph(afterPeriod)).toBe(true);
    // 对照组：条目头跟在「了」后（「修订了一、二号文件」）不是条目头
    const afterLe = "修订了一、二号文件，下发了三、四号通知，均自发布之日起施行。";
    expect(isSpecTableParagraph(afterLe)).toBe(false);
  });

  it("⑥C18 端到端：条目完整性 + 条目顺序 + 句数不变 + 零自问自答（0.9 档 7 seed 含门禁 seed）", () => {
    const FRAGS = [
      "项目名称：智慧园区综合管理平台建设项目", // 条目冒号（relaxColon 被门控）
      "招标编号：HFZB-2026-089",
      "配置不少于 2 颗 32 核处理器", // 条目句不被 boostBurstinessByCutting 劈开
      "内存容量不低于 512GB",
      "硬盘容量不低于 4TB NVMe SSD",
      "支持 RAID 0/1/5/6",
      "交换容量不低于 12.8Tbps",
      "支持 IPv4/IPv6 双栈",
      "支持不少于 5000 个物联网终端并发接入",
      "系统可用性不低于 99.99%",
    ];
    // 劈句/合并两道门控的观测面：条目句 60+ 字 > SPLIT_SENTENCE_THRESHOLD(34)，
    // 判据一摘就会被劈；短条目句会被 MERGE_SENTENCE_THRESHOLD(9) 吞并。
    // 句数不变同时锁这两条（变异检验摘 isSpecTableParagraph 后必须变红）。
    for (const seed of [1, 2, 3, 5, 8, 13, 20261015]) {
      const out = humanize(C18_TENDER, { intensity: 0.9, seed });
      for (const f of FRAGS) {
        expect(out, `seed=${seed}：参数片段丢失/被拆散 → ${f}`).toContain(f);
      }
      expect(out, `seed=${seed}：参数表里出自问自答`).not.toContain("为什么呢");
      expect(splitSentences(out).length, `seed=${seed}：句数被劈句/合并改动`).toBe(7);
      // 条目顺序不被条款位移打乱（服务器 → 网络设备 → 软件平台）
      expect(out.indexOf("服务器")).toBeLessThan(out.indexOf("网络设备"));
      expect(out.indexOf("网络设备")).toBeLessThan(out.indexOf("软件平台"));
    }
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

/* =========================================================
   2026-10-05 全面优化验证轮 · 分支覆盖补测（此前分支 74.41%）
   目标：144-150 与 175-183 的「前邻标点」两侧判定、
         338 空分段、339/340 残句合并与不合并两侧
   ========================================================= */

describe("capLongTemplateRepetition：前邻标点判定（144-150 / 175-183）", () => {
  it("第二处前邻是非标点（「后」）→ 只删短语本身，start 不回退", () => {
    // if 为假：start 保持 idx，前邻的「后」不被连带吃掉
    expect(capLongTemplateRepetition("你细品然后你细品。")).toBe("你细品然后。");
  });

  it("第二处前邻是五种标点之一 → 连同前邻标点一起删", () => {
    // 逐个喂，，同时覆盖 144-150 各比较为真的路径
    for (const punct of ["，", "、", "？", "。", "！"]) {
      const src = `前句。你细品${punct}你细品。尾句`;
      expect(capLongTemplateRepetition(src), src).toBe("前句。你细品。尾句");
    }
  });

  it("第三轮总量封顶（MAX=4）：9 个互异短语删最早 5、保留最晚 4", () => {
    // hits 按 idx 降序排 → 先删下标最大的，故 5 次删除都发生在更小下标之前，
    // 早先算好的 idx 不会因前面的删除而失效；这 9 个短语的前邻依次是
    // 非标点/，/、/？/！——同一轮里把 175 的 if 真与假两侧都走一遍。
    const src =
      "开头侃真的，你细品、讲道理？话又侃回来！搁谁都一样。据我观察，不瞒你说、客观讲？老实讲！";
    const out = capLongTemplateRepetition(src);

    for (const keep of ["据我观察", "不瞒你说", "客观讲", "老实讲"]) expect(out).toContain(keep);
    for (const gone of ["侃真的", "你细品", "讲道理", "话又侃回来", "搁谁都一样"]) {
      expect(out, `应已删除：${gone}`).not.toContain(gone);
    }
    expect(out).toBe("开头。据我观察，不瞒你说、客观讲？老实讲！");
    expect(out.match(/。/g)).toHaveLength(1); // 首删连带的「。」已被后续删除吸收，只留一个
  });
});

describe("fixOrphanConnectiveLeads：残句合并两侧（338-346）", () => {
  it("句末标点后的空分段被丢弃 → 输出无尾空白（行 338 then）", () => {
    // split 探针实测："这是一句挺长的正文。 ".split(/(?<=[。…])/) === ["这是一句挺长的正文。", " "]
    expect(fixOrphanConnectiveLeads("这是一句挺长的正文。 ")).toBe("这是一句挺长的正文。");
  });

  it("删词后残句 <8 字且上句以句号收尾 → 合并成逗号连接（339/340 全真）", () => {
    expect(fixOrphanConnectiveLeads("这是一句挺长的正文。且很短")).toBe("这是一句挺长的正文，很短");
  });

  it("上句以问号收尾 → 不合并（行 340 的 /[。…]$/ 为假）", () => {
    expect(fixOrphanConnectiveLeads("这样真的好吗？且很短")).toBe("这样真的好吗？很短");
  });

  it("残句 ≥8 字（MERGE_MIN_CHARS）→ 不合并（行 341 为假）", () => {
    const src = "这是一句挺长的正文。且这里的内容足足有八九个字";
    expect(fixOrphanConnectiveLeads(src)).toBe("这是一句挺长的正文。这里的内容足足有八九个字");
  });

  it("v0.9.36：纯标点段（切分残余的闭引号）不参与合并——标点必须原样保留", () => {
    // 实证：`"好，我这就去准备。"` 曾被 split 成 [`"好，我这就去准备。`, `"`]，
    // 长度 1 的引号段走进合并模板「剥句尾标点 + ，」⇒ 句号被吞成逗号（全种子复现）。
    // 修复后纯标点段直接跳过合并，join 时原样拼回。
    expect(fixOrphanConnectiveLeads('"好，我这就去准备。"')).toBe('"好，我这就去准备。"');
    // 含文字的超短残段仍照常合并（守卫只挡"不含词字符"的纯标点段）
    expect(fixOrphanConnectiveLeads("张三说得对。他也这么认为")).toBe("张三说得对，他也这么认为");
  });

  it("v0.9.47：跨段落的残句不合并——段间空行不得被 trim 吃掉", () => {
    // 实证（scripts/realcase C7-story-dialogue，强度 0.9 / seed 20261015）：
    //   段首片段形如 "\n\n决定了。"，trimmed 去掉前导换行后走进合并模板，
    //   拼回时用的是 trimmed ⇒ 段间空行蒸发 ⇒ 原文的 6 段被焊成 5 段。
    // 修复前返回 "...一片一片，决定了。"，段数 −1。
    const src = "她站在窗边看雨。\n\n决定了。她说完就挂了电话。";
    expect(fixOrphanConnectiveLeads(src)).toBe(src);
    expect(fixOrphanConnectiveLeads(src).split(/\n\n+/)).toHaveLength(2);
  });

  it("v0.9.47 端到端：对话体语料经整条管线后段落数不减", () => {
    // 与上面的单元测试互补：单测验函数，这里验"整条管线里它真的被拦住了"。
    // 二分证据：强度 0.50 保持 6 段、0.55 起变 5 段 —— 与 `intensity >= 0.55`
    // 的调用门槛精确对齐；改 narrative（跳过结构层）仍 5 段 ⇒ 排除结构层。
    // 语料取自入库的 cases.json（不依赖 out/ —— 那是跑测产物，CI 干净检出上没有）
    const cases = JSON.parse(
      readFileSync(new URL("../../scripts/realcase/cases.json", import.meta.url), "utf-8"),
    ) as { cases: { id: string; text: string }[] };
    const c7 = cases.cases.find((c) => c.id === "C7-story-dialogue");
    expect(c7, "cases.json 里必须有 C7 对话体语料").toBeTruthy();
    const before = c7!.text.trim();
    const paras = (s: string): number => s.split(/\n+/).filter((p) => p.trim()).length;
    const out = humanize(before, { intensity: 0.9, seed: 20261015 });
    expect(paras(out)).toBe(paras(before));
  });
});

/**
 * v0.9.46 真实案例驱动：与体裁无关的坏替身修复。
 *
 * 起因（artifacts/realcase C3 技术科普）：「通过在大规模语料上进行预训练」被 VOCAB 替成
 * 「借在…上」，而 FORMAL_RESTORE 被 `guardFormalRegister` 的体裁门控包着——这篇被判成
 * narrative（"自 2017 年以来"触发过去时），于是**没有一层会把病句救回来**。
 * 病句与体裁无关，故这张表必须无条件执行，下面三条分别锁：单句修复 / 距离上限 / 体裁无关。
 */
describe("fixBrokenCollocations（与体裁无关的坏替身修复）", () => {
  it("介词「通过」被替成「借」→ 还原时必须把「在」一起补回", () => {
    const out = fixBrokenCollocations("该模型借在大规模语料上进行预训练。");
    expect(out).toBe("该模型通过在大规模语料上进行预训练。");
    // ⚠️ 还原串写成 "通过$1$2" 会把「在」吃掉 ⇒ 断言必须钉在完整形态上
    expect(out).not.toContain("借在");
  });

  it("「拔高」+ 抽象宾语一律还原为「提升」，宾语前允许较长修饰语", () => {
    expect(fixBrokenCollocations("明显拔高了下游任务的表现。")).toBe("明显提升了下游任务的表现。");
    expect(fixBrokenCollocations("拔高质量")).toBe("提升质量");
    expect(fixBrokenCollocations("拔高了他的整体效率")).toBe("提升了他的整体效率");
  });

  it("合法用法不被误伤：「借助…基础上」与字面义的「拔高」原样保留", () => {
    expect(fixBrokenCollocations("借助的基础上再看")).toBe("借助的基础上再看");
    // 宾语不是抽象名词时不还原——「拔高一截」是字面义的抬高，不是 VOCAB 的坏替身
    expect(fixBrokenCollocations("把标杆拔高一截")).toBe("把标杆拔高一截");
  });

  it("端到端：被判非 main 体裁的技术科普，产出里不得出现「借在」", () => {
    // 这句会让 classifyGenre 走 narrative（"自…以来"是过去时指示词）
    const src =
      "Transformer 架构自 2017 年提出以来，该模型通过在大规模语料上进行 Masked Language Model 预训练，显著提升了下游任务的表现。";
    const out = humanize(src, { intensity: 0.9, seed: 20261015 });
    expect(out).not.toContain("借在");
    expect(out).not.toMatch(/拔高(了)?[\u4e00-\u9fa5]{0,8}(?:表现|质量|水平|能力|效率|效果)/);
  });
});

/**
 * 结构性不可达说明（2026-10-05 复核，不是漏测）：
 * `assertCaptureRefsValid`（源码约 275-300 行）未导出，仅在模块加载时以合法的
 * FORMAL_RESTORE 调用一次——其 `maxRef > groups` 抛错分支与命名组分支
 * （行 287、288×2、291、292）没有任何测试入口，任何用例都到不了。
 * 要覆盖必须改生产源码（导出或注入），本任务禁止改源码，故如实记在此处。
 */
