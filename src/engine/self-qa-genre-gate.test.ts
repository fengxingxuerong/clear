/**
 * src/engine/self-qa-genre-gate.test.ts — 自问自答注入的文档体裁门控（v0.9.49）
 *
 * 背景：自问自答（「是不是只有这一种解释？未必，但这一种最直接。」）是口语修辞装置。
 * scripts/realcase 实测（默认设置 0.9 档）：
 *   C1 季度工作总结 → 被注入 1 处（findings 未修第 5 项，公文中出现辩论句式）
 *   C6 学术摘要     → 20/20 seed 全部被注入（本轮新发现）
 *   C2 公众号观点文 → 注入正是设计意图（人味装置），**必须保留**
 * 而三者的自动体裁同为 main（C1/C2/C4/C6/C9 全判 main），getGenreKnobs 的
 * 体裁旋钮分不开 ⇒ 用文档签名补判据（OFFICIAL_DOC_RE / ACADEMIC_DOC_RE，
 * 详见 classify-genre.ts 注释）。
 *
 * 本文件锁四件事（v0.9.49）+ 四件事（v0.9.51 新增签名，见文件尾部 describe）：
 *   ① 两个签名的分离度：公文中 C1、学术中 C6、观点文 C2 及余下全不中；
 *   ② 严格公文签名确是 OFFICIAL_RE 的子集（防它慢慢长出自己的词）；
 *   ③ 端到端：C1/C6 多 seed 零注入，C2 仍能注入（装置没被整体废掉）；
 *   ④ detect-drop 回滚不受影响：注入点本身仍带 v0.9.28 的收益判据。
 * v0.9.51：致辞 SPEECH_DOC_RE / 诉讼 LITIGATION_DOC_RE / 参数表 isSpecTableParagraph
 * 三条新通道的分离度与端到端零注入（C17/C18/C20，含门禁 seed 20261015）。
 */
import { describe, it, expect } from "vitest";
import { humanize } from "./humanize";
import {
  suppressSelfQA,
  OFFICIAL_DOC_RE,
  ACADEMIC_DOC_RE,
  SPEECH_DOC_RE,
  LITIGATION_DOC_RE,
} from "./classify-genre";
import { isSpecTableParagraph } from "./anti-fingerprint";

/** plain 池（默认风格）的 6 个问句头——注入与否只看"问"那半句（答可能被后续 pass 改写） */
const PLAIN_QA_HEADS = [
  "为什么呢",
  "这么说有依据吗",
  "是不是只有这一种解释",
  "这意味着什么",
  "这个判断可靠吗",
  "有没有反例",
];

/** casual 池的问句头（朱雀增强路径用） */
const CASUAL_QA_HEADS = [
  "为啥这么说",
  "真的假的",
  "你可能会问",
  "不信？",
  "例子呢",
  "有人要抬杠了",
  "这话是不是太绝对",
  "凭什么这么说",
  "听着有点绕",
  "这有什么要紧的",
];

// 语料与 scripts/realcase/cases.json 同源（src 测试不跨层 import scripts，故抄录）
const C1 =
  "在过去的第三季度里，团队紧紧围绕公司年度战略目标，全面落实各项重点工作任务，取得了较为显著的工作成效。首先是制度建设方面，我们先后修订了《项目交付管理办法》等三份规范性文件，进一步明确了各岗位的职责边界与协作流程。其次是能力建设方面，累计组织内部技术分享会十二场，覆盖员工一百八十余人次，有效提升了团队的整体专业素养。与此同时，我们也清醒地认识到工作中仍然存在一些不足之处，主要体现在跨部门协同效率有待进一步提升，部分项目的里程碑节点把控还不够精细。展望未来，我们将继续聚焦于提升交付质量与运营效率这两个核心方向，努力在下一季度取得更加优异的成绩。";
const C2 =
  "众所周知，在这个瞬息万变的时代里，焦虑似乎成了当代人的标配。然而，真正的成长从来不是一蹴而就的。值得注意的是，那些看起来毫不费力的人，往往在背后付出了超乎常人的努力。首先，我们需要建立一个清晰的自我认知体系；其次，要把目标拆解为可执行的最小单元；最后，也是最关键的一点，是要保持长期主义的耐心。综上所述，成长不是一场百米冲刺，而是一场旷日持久的马拉松。";
const C6 =
  "本文针对低资源场景下的命名实体识别任务，提出了一种基于对抗训练的半监督方法。该方法通过引入梯度反转层，将领域对抗损失与任务损失进行联合优化，从而增强了模型在不同领域之间的迁移能力。我们在三个公开数据集上进行了充分的实验，实验结果表明，所提方法相较于基线模型在 F1 值上平均提升了 3.2 个百分点。进一步的消融实验验证了各个组件的有效性。此外，本文还探讨了标注数据量与模型性能之间的关系，发现当标注样本少于 500 条时，对抗训练带来的增益尤为显著。";

describe("文档体裁签名：分离度", () => {
  it("①公文/总结命中（C1），观点文与其余不命中", () => {
    expect(suppressSelfQA(C1), "C1 工作总结必须命中").toBe(true);
    expect(OFFICIAL_DOC_RE.test(C1)).toBe(true);
    expect(ACADEMIC_DOC_RE.test(C1), "C1 不该撞学术签名").toBe(false);
  });

  it("②学术摘要命中（C6），但不撞公文签名（两个签名各管各的）", () => {
    expect(suppressSelfQA(C6), "C6 学术摘要必须命中").toBe(true);
    expect(ACADEMIC_DOC_RE.test(C6)).toBe(true);
    expect(OFFICIAL_DOC_RE.test(C6), "C6 不该撞公文签名").toBe(false);
  });

  it("③观点文（C2）两个签名都不命中——人味装置的保留对象", () => {
    expect(suppressSelfQA(C2), "C2 观点文必须不命中，否则自问自答被废掉").toBe(false);
  });

  it("④普通口语/中立句不误伤", () => {
    for (const s of [
      "今天天气不错，我去公园走了走，顺便买了杯咖啡。",
      "这个问题我想了很久，我觉得应该从另一个角度看。",
      "他每天早起跑步，坚持了三年，身体明显好了很多。",
      "为了搞清楚原因，我们讨论了一下午，最后决定先做实验。", // 含"为了"——严格子集刻意不收它
      "关于这个话题，网上已经有很多讨论了，我说点自己的看法。", // 含"关于"——同上
    ]) {
      expect(suppressSelfQA(s), `误伤普通句子：${s.slice(0, 20)}…`).toBe(false);
    }
  });
});

describe("签名来源合法性", () => {
  it("⑤严格公文签名的每个词都来自 Rule 4 的 OFFICIAL_RE（不许自生长）", () => {
    // OFFICIAL_RE 是 classify-genre.ts 内的模块级常量，这里用同样的词表校验子集关系：
    // 把 OFFICIAL_DOC_RE 的每个分支拆出来，逐一确认它在 OFFICIAL_RE 的原文里出现过。
    const officialSrc = readOfficialReSource();
    for (const w of officialDocWords()) {
      expect(officialSrc.includes(w), `「${w}」不在 OFFICIAL_RE 里——严格子集混进了外来词`).toBe(
        true,
      );
    }
  });

  it("⑥被刻意排除的五个高频词确实不在严格子集里", () => {
    for (const w of ["为了", "关于", "按照", "下一步", "根据"]) {
      expect(OFFICIAL_DOC_RE.test(`句子一${w}句子二`), `「${w}」被误收进严格子集`).toBe(false);
    }
  });
});

/** 从源码里读 OFFICIAL_RE 的字面量（测试不另抄一份词表，抄了就会各改各的） */
function readOfficialReSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  const src = fs.readFileSync(new URL("./classify-genre.ts", import.meta.url), "utf-8");
  const m = /const OFFICIAL_RE =\s*\/(.+?)\/g;/.exec(src);
  expect(m, "前置：classify-genre.ts 里必须还能找到 OFFICIAL_RE").not.toBeNull();
  return m![1];
}

/** OFFICIAL_DOC_RE 的全部分支词（同样从源码读，不手抄） */
function officialDocWords(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  const src = fs.readFileSync(new URL("./classify-genre.ts", import.meta.url), "utf-8");
  const m = /const OFFICIAL_DOC_RE =\s*\/(.+?)\/;/.exec(src);
  expect(m, "前置：classify-genre.ts 里必须还能找到 OFFICIAL_DOC_RE").not.toBeNull();
  return m![1]
    .replace(/^\^?\(\?:?/, "")
    .replace(/\)$/, "")
    .split("|")
    .map((s) => s.replace(/\\w|《|\]|\[/g, "").trim())
    .filter(Boolean);
}

/**
 * v0.9.51 第三批签名：致辞 / 诉讼文书 / 参数表通道
 *
 * 背景：第三批语料（scripts/realcase 扩容到 20 篇）又暴露三个签名管不到的体裁：
 *   C20 大会致辞 → 5/13 seed「为什么呢？」+ 2/13「是不是只有这一种解释？未必」
 *     （致辞是 main，但套语系统是「尊敬的/谨代表/预祝」，公文签名一个都不命中）
 *   C17 判决书   → 「撤销一审判决……这意味着什么？往下看会更清楚。」
 *     （判项后挂辩论句式；没有致辞套语也没有学术标记，三个签名都不覆盖）
 *   C18 招标参数表 → 条目参数后挂「为什么呢？」（与体裁无关的形态判据，
 *     走 isSpecTableParagraph，详见 anti-fingerprint.test.ts）
 *
 * 方向与 v0.9.49 一致：宁可少注入，不可错注入。本块锁四件事：
 *   ⑪~⑬ 三个新通道的分离度（各自的专属词命中，互不撞）；
 *   ⑭ 普通句不误伤（含「法院/项目」这类刻意不收的词）；
 *   ⑮ 端到端多 seed（含门禁 seed 20261015）零注入；
 *   ⑯ C17 句尾语气词不注入——体裁误判（dialogue）的连锁缺陷，双保险。
 */
describe("v0.9.51 新签名：致辞 / 诉讼文书 / 参数表", () => {
  // 语料与 scripts/realcase/cases.json 同源（src 测试不跨层 import scripts，故抄录）
  const C17_VERDICT =
    "上诉人北京某科技有限公司因与被上诉人李某劳动争议一案，不服北京市海淀区人民法院（2025）海0105民初12345号民事判决，向本院提起上诉。本院于二〇二六年三月十八日立案后，依法组成合议庭进行了审理。本案现已审理终结。某科技公司上诉请求：撤销一审判决，依法改判驳回李某的全部诉讼请求。事实和理由：双方签订的劳动合同约定李某担任算法工程师，试用期为三个月。李某辩称，其在职期间存在加班事实，公司未足额支付加班工资。本院认为，根据《中华人民共和国劳动合同法》第十条、第八十二条之规定，用人单位自用工之日起超过一个月不满一年未与劳动者订立书面劳动合同的，应当向劳动者每月支付二倍的工资。";
  const C18_TENDER =
    "项目名称：智慧园区综合管理平台建设项目。招标编号：HFZB-2026-089。以下技术参数为实质性要求，投标文件须逐项响应，不允许负偏离。一、服务器：2U 机架式，配置不少于 2 颗 32 核处理器，内存容量不低于 512GB，硬盘容量不低于 4TB NVMe SSD，支持 RAID 0/1/5/6。二、网络设备：核心交换机交换容量不低于 12.8Tbps，支持 IPv4/IPv6 双栈。三、软件平台：支持不少于 5000 个物联网终端并发接入，系统可用性不低于 99.99%。投标人须提供所投产品制造商出具的本项目授权及售后服务承诺函原件。";
  const C20_SPEECH =
    "尊敬的各位领导、各位来宾，同志们、朋友们：大家上午好！值此 2026 世界制造业大会召开之际，我们欢聚一堂，共同见证这一重要时刻。首先，我谨代表本次大会的主办方，向长期以来关心和支持大会发展的各级领导和社会各界人士，表示衷心的感谢和热烈的欢迎！回顾过去五年，大会的国际化、专业化水平不断提升，已经成为展示制造业最新成果的重要窗口。展望未来，我们将继续秉持开放合作、互利共赢的理念，与各位携手共进，共同开创智能制造的美好明天！最后，预祝本次大会取得圆满成功！谢谢大家！";
  /** OPENERS 表的全部口语替身（首先/其次/最后/第一/第二 的口语化形态） */
  const OPENER_SUBS = ["先说一个", "头一件", "一来", "最后说一句", "收个尾", "末了"];

  it("⑪C20 致辞命中 SPEECH 签名，且不撞公文/学术签名（套语系统不同）", () => {
    expect(SPEECH_DOC_RE.test(C20_SPEECH)).toBe(true);
    expect(OFFICIAL_DOC_RE.test(C20_SPEECH), "致辞不该撞公文签名——两个场合套语零重叠").toBe(false);
    expect(ACADEMIC_DOC_RE.test(C20_SPEECH)).toBe(false);
  });

  it("⑫C17 判决书命中 LITIGATION 签名，且不撞致辞/公文/学术签名", () => {
    expect(LITIGATION_DOC_RE.test(C17_VERDICT)).toBe(true);
    expect(SPEECH_DOC_RE.test(C17_VERDICT)).toBe(false);
    expect(OFFICIAL_DOC_RE.test(C17_VERDICT)).toBe(false);
    expect(ACADEMIC_DOC_RE.test(C17_VERDICT)).toBe(false);
  });

  it("⑬C18 参数表走 isSpecTableParagraph（四个文档签名都不命中它）", () => {
    expect(isSpecTableParagraph(C18_TENDER)).toBe(true);
    expect(OFFICIAL_DOC_RE.test(C18_TENDER)).toBe(false);
    expect(ACADEMIC_DOC_RE.test(C18_TENDER)).toBe(false);
    expect(SPEECH_DOC_RE.test(C18_TENDER)).toBe(false);
    expect(LITIGATION_DOC_RE.test(C18_TENDER)).toBe(false);
    // Wiring 断言：四个签名都可证为 false ⇒ suppressSelfQA 为 true 只能经由
    // isSpecTableParagraph 这一条接线。端到端用例隔离不到它（C18 的注入点
    // 在结构层，那里有自己的跳过），所以必须在这里直接锁 suppressSelfQA 的返回。
    expect(suppressSelfQA(C18_TENDER)).toBe(true);
  });

  it("⑭普通叙述句不误伤新签名（含「法院/项目」这类刻意不收的词）", () => {
    for (const s of [
      "法院门口排起了长队，大家都是来办理立案手续的，工作人员耐心地做着引导。", // 含「法院」——刻意不收
      "他代表公司出席了这次行业展会，顺便拜访了几位老客户，收获不小。", // 含「代表」——谨代表才收
      "项目预算批得很快，下周就可以启动，相关的技术参数表已经发到各位手里。", // 含「项目」——裸词不收
      "各位同事都在加班加点赶进度，争取月底之前把测试全部跑完。", // 含「各位」——各位领导/来宾才收
    ]) {
      expect(suppressSelfQA(s), `误伤普通句子：${s.slice(0, 20)}…`).toBe(false);
    }
  });

  it("⑮C17/C18/C20 端到端：13 seed（含门禁 seed 20261015）零自问自答", () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20261015];
    for (const [id, t] of [
      ["C17", C17_VERDICT],
      ["C18", C18_TENDER],
      ["C20", C20_SPEECH],
    ] as const) {
      for (const seed of seeds) {
        const out = humanize(t, { intensity: 0.9, seed });
        for (const q of PLAIN_QA_HEADS) {
          expect(out, `${id} seed=${seed}：漏出自问自答「${q}」`).not.toContain(q);
        }
      }
    }
  });

  it("⑯C17 判决书：句尾语气词（呢/吧/嘛/呀）零注入——体裁误判 dialogue 的连锁缺陷", () => {
    // 修前 C17 被判 dialogue → 语气词注入层对该体裁不设防（6/13 seed）。
    // 冒号排除治本（见 classify-genre.test.ts），这条锁端到端结果。
    for (let seed = 1; seed <= 13; seed++) {
      const out = humanize(C17_VERDICT, { intensity: 0.9, seed });
      expect(out, `seed=${seed}：判决书里出现句尾语气词`).not.toMatch(/[呢吧嘛呀][。！？]/);
    }
  });

  it("⑰C20 致辞：OPENERS 序数结构标记不被口语替身换掉（正式稿件门控）", () => {
    // 「首先/最后」在致辞里是结构标记。v0.9.51 首轮只把六个替身加进
    // FORMAL_FORBIDDEN_SUBSTITUTES 不管用——replaceOpener 是 replaceVocab
    // 之外的平行路径，黑名单盖不到；门控 replaceOpener 才是修法。
    // ⚠️ 门控判据是文档签名（suppressSelfQA）而非体裁——精度锁见 ⑱，
    //    多段透传锁见 ⑲。
    for (let seed = 1; seed <= 13; seed++) {
      const out = humanize(C20_SPEECH, { intensity: 0.9, seed });
      for (const o of OPENER_SUBS) {
        expect(out, `seed=${seed}：致辞里漏出口语替身「${o}」`).not.toContain(o);
      }
      expect(out, `seed=${seed}：结构标记「首先」被改掉`).toContain("首先");
    }
  });
  it("⑱无签名论说稿：句首标记仍可口语化（精度锁——防门控退化成按体裁一刀切）", () => {
    // ⑰ 锁的是"签了名的正式稿件必须冻"，本条锁反方向：**没有签名的普通论说
    // 不许被顺手冻住**。v0.9.51 首版按体裁一刀切（main 一律冻）时，本样本的
    // 「首先/其次/最后」被冻在稿里，detectAI 基线 26→40（injection-overlap.test.ts
    // 同 seed 实测）；论说稿的去味收益恰恰包括换掉这些 AI 标记词。
    // 样本与 injection-overlap.test.ts 同源（固定 seed 20260905，0.6 档不注入自问自答，
    // 排除注入变量后单看 opener 路径）。
    const EXPO =
      "首先，数字化转型不是简单的技术堆叠，而是组织能力的重构。其次，数据治理的难点不在工具，而在责任边界的划分。最后，评估体系必须跟着业务节奏迭代，否则指标会失真。总的来说，这三件事互为前提，缺一个都会让投入打折扣。\n\n从实践看，很多团队把预算压在平台上，却忽略了流程改造。这样一来，系统上线了，习惯没变，效率反而下降。因此，先定责任再上工具，是被反复验证过的顺序。";
    const out = humanize(EXPO, {
      intensity: 0.6,
      seed: 20260905,
      zhuqueMode: true,
      style: "plain",
    });
    // 不断言"三个全被换"（那绑死了 OPENERS 表的 rng 落点），断言"没有三个都冻住"——
    // 只要还有一个被换，门控就没有退化成体裁一刀切。实测该 seed 三个全换。
    const allFrozen = out.includes("首先") && out.includes("其次") && out.includes("最后");
    expect(allFrozen, "无签名论说稿的句首标记全被冻住——门控退化成按体裁一刀切了").toBe(false);
    // 反向确认本样本确实不在任何文档签名里（否则这条断言失去前提）
    expect(suppressSelfQA(EXPO), "前置：本样本必须无签名").toBe(false);
  });

  it("⑲多段致辞：签名只在首段出现，正文段的结构标记同样冻结（officialDoc 全文透传）", () => {
    // humanize() 逐段调用 humanizeSingle，若按**单段**判定签名，正文段
    // （「回顾过去一年……」没有任何致辞套语）会漏冻 ⇒ 口语替身打进致辞中段。
    // officialDoc 由 humanize() 对全文计算后透传，本条锁这根接线。
    const MULTI_PARA_SPEECH =
      "尊敬的各位领导、各位来宾，同志们、朋友们：大家上午好！值此本次行业峰会召开之际，我们欢聚一堂，共同见证这一重要时刻。首先，我谨代表主办方向各位表示衷心的感谢和热烈的欢迎！\n\n回顾过去一年，行业在波动中前行，技术创新从未停步。首先，国产算力的规模上了一个新台阶；其次，应用落地的问题在逐个解决；最后，生态协作的机制初步成形。展望未来，我们将继续秉持开放合作的理念，与各位携手共进，共同开创行业发展的新局面。";
    // 前置：正文段单独看必须无签名（否则本条失去前提）
    const bodyPara = MULTI_PARA_SPEECH.split("\n\n")[1] ?? "";
    expect(suppressSelfQA(bodyPara), "前置：正文段必须无签名").toBe(false);
    for (let seed = 1; seed <= 8; seed++) {
      const out = humanize(MULTI_PARA_SPEECH, { intensity: 0.9, seed });
      for (const o of OPENER_SUBS) {
        expect(out, `seed=${seed}：正文段漏出口语替身「${o}」`).not.toContain(o);
      }
    }
  });
});

describe("端到端：该拦的不注入，该留的保留", () => {
  it("⑦C1 工作总结：12 个 seed 全部零自问自答", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const out = humanize(C1, { intensity: 0.9, seed });
      for (const q of PLAIN_QA_HEADS) {
        expect(out, `seed=${seed}：公文里漏出自问自答「${q}」`).not.toContain(q);
      }
    }
  });

  it("⑧C6 学术摘要：12 个 seed 全部零自问自答", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const out = humanize(C6, { intensity: 0.9, seed });
      for (const q of PLAIN_QA_HEADS) {
        expect(out, `seed=${seed}：学术摘要里漏出自问自答「${q}」`).not.toContain(q);
      }
    }
  });

  it("⑨C2 观点文：20 个 seed 里仍能注入（装置没被门控整体废掉）", () => {
    let injected = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const out = humanize(C2, { intensity: 0.9, seed });
      if ([...PLAIN_QA_HEADS, ...CASUAL_QA_HEADS].some((q) => out.includes(q))) injected++;
    }
    expect(injected, "20 个 seed 全部零注入——门控把观点文的人味装置也废了").toBeGreaterThan(0);
  });

  it("⑩朱雀增强路径同样受门控（①调用点）", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const out = humanize(C1, { intensity: 0.9, seed, zhuqueMode: true });
      for (const q of [...PLAIN_QA_HEADS, ...CASUAL_QA_HEADS]) {
        expect(out, `seed=${seed} zhuqueMode：公文里漏出自问自答「${q}」`).not.toContain(q);
      }
    }
  });
});
