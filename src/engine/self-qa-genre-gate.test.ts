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
 * 本文件锁四件事：
 *   ① 两个签名的分离度：公文中 C1、学术中 C6、观点文 C2 及余下全不中；
 *   ② 严格公文签名确是 OFFICIAL_RE 的子集（防它慢慢长出自己的词）；
 *   ③ 端到端：C1/C6 多 seed 零注入，C2 仍能注入（装置没被整体废掉）；
 *   ④ detect-drop 回滚不受影响：注入点本身仍带 v0.9.28 的收益判据。
 */
import { describe, it, expect } from "vitest";
import { humanize } from "./humanize";
import { suppressSelfQA, OFFICIAL_DOC_RE, ACADEMIC_DOC_RE } from "./classify-genre";

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
