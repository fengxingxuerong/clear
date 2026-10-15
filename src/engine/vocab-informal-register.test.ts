/**
 * src/engine/vocab-informal-register.test.ts — 词条级正式语体冻结（v0.9.49）
 *
 * 背景：VOCAB 有 283 条，其中一批词条的**有效替身池整池都是口语**
 * （围绕→[围着,环绕]、努力→[使劲,下功夫]…）。v0.9.46 的替身级否决
 * （FORMAL_FORBIDDEN_SUBSTITUTES）管混合池很合适，但管这种词条只能一条条补——
 * 补丁追不上发现。本版把「这条在正式体不能用」变成数据属性
 * （humanize-vocab.ts 的 INFORMAL_ONLY_KEYS），替换阶段整条不发起。
 *
 * 本文件锁四件事：
 *   ① 表里每个词都真实存在于 VOCAB（写错字 = 白写，与 v0.9.46 文件同口径）；
 *   ② 端到端：main 体裁的正式文本不得产出这些词条的任何一个替身（多 seed）；
 *   ③ 反向对照：同一批词条在**非正式体裁**（dialogue）照常替换——
 *      证明门控按体裁缩放，没有把去味能力整体冻死（没有这条对照，
 *      "正式体不换"会被误实现成"永远不换"而测试全绿）；
 *   ④ 与替身级否决不重叠：进不了本表的混合池词条，其口语替身仍由
 *      FORMAL_FORBIDDEN_SUBSTITUTES 管（协同→一起 即此例，见 v0.9.46 文件）。
 */
import { describe, it, expect } from "vitest";
import { humanize, FORMAL_FORBIDDEN_SUBSTITUTES } from "./humanize";
import { VOCAB, INFORMAL_ONLY_KEYS } from "./humanize-vocab";

/** 与生产同源：直接 import，不另抄 */
const INFORMAL_KEYS = [...INFORMAL_ONLY_KEYS];

describe("INFORMAL_ONLY_KEYS 表完整性", () => {
  it("①每个词都必须是 VOCAB 里真实存在的词条（写错字的表项等于没写）", () => {
    for (const k of INFORMAL_KEYS) {
      expect(VOCAB[k], `INFORMAL_ONLY_KEYS 里的「${k}」在 VOCAB 中不存在`).toBeDefined();
    }
  });

  it("②表非空且规模合理（治本清单不该只有两条摆设）", () => {
    expect(INFORMAL_KEYS.length).toBeGreaterThanOrEqual(50);
  });
});

describe("端到端：正式体裁整条冻结", () => {
  // C1 风格工作总结 + 一批已标记词条，一句话里密集命中
  const FORMAL_TEXT =
    "团队紧紧围绕年度战略目标，努力优化交付流程，建立完善的协同机制，" +
    "全面提升攻坚克难的能力，形成合力，筑牢防线，为高质量发展保驾护航。";

  it("main 体裁：多 seed 都不产出标记词条的替身", () => {
    // 这些替身分别来自 围绕/努力/优化/建立/协同/攻坚克难/形成合力/筑牢防线/保驾护航
    const leaked = /围着|环绕|使劲|下功夫|调好|搞出|一起|联手|啃硬骨头|拧成一股绳|扎紧篱笆|兜好底/;
    for (let seed = 1; seed <= 12; seed++) {
      const out = humanize(FORMAL_TEXT, { intensity: 1, seed, genre: "main" });
      expect(out, `seed=${seed} 泄漏了口语替身`).not.toMatch(leaked);
    }
  });

  it("main 体裁：原词本身保留（冻结 = 不换，不是删词）", () => {
    const out = humanize(FORMAL_TEXT, { intensity: 1, seed: 20261015, genre: "main" });
    expect(out).toContain("围绕");
    expect(out).toContain("努力");
    expect(out).toContain("优化");
    expect(out).toContain("建立");
  });

  it("academic 文风同样冻结（formalRegister 的另一个入口）", () => {
    const out = humanize(FORMAL_TEXT, { intensity: 1, seed: 20261015, style: "academic" });
    expect(out).not.toMatch(/围着|环绕|使劲|下功夫|调好|搞出/);
  });
});

describe("反向对照：非正式体裁照常替换（门控没把能力冻死）", () => {
  const SAME_TEXT =
    "团队紧紧围绕年度战略目标，努力优化交付流程，建立完善的协同机制，" +
    "全面提升攻坚克难的能力，形成合力，筑牢防线，为高质量发展保驾护航。";

  it("dialogue 体裁：同一批词条至少有一部分被换成口语替身", () => {
    const replaced =
      /围着|环绕|使劲|下功夫|调好|搞出|一起|联手|啃硬骨头|拧成一股绳|扎紧篱笆|兜好底/;
    let anyHit = false;
    for (let seed = 1; seed <= 12; seed++) {
      const out = humanize(SAME_TEXT, { intensity: 1, seed, genre: "dialogue" });
      if (replaced.test(out)) anyHit = true;
    }
    expect(anyHit, "12 个 seed 全部零替换——门控疑似按体裁缩放失败，把能力整体冻死了").toBe(true);
  });

  it("混合池词条不受词条级冻结影响：协同的安全候选仍可换", () => {
    // 协同 → [配合, 一起, 联手]：「一起」被替身级否决，「配合/联手」是合法候选。
    // 词条级冻结若误收协同，这条会红（它的有效池并非整池口语）。
    const out = humanize("这主要体现在跨部门协同效率有待进一步提升。", {
      intensity: 1,
      seed: 20261015,
      genre: "dialogue",
    });
    expect(out).toMatch(/配合|联手|协同/);
    // 同时确认替身级否决仍在干活：正式体下「一起」不许出现
    const formal = humanize("这主要体现在跨部门协同效率有待进一步提升。", {
      intensity: 1,
      seed: 20261015,
      genre: "main",
    });
    expect(formal).not.toContain("一起");
  });
});

describe("两条线不重叠", () => {
  it("未冻结词条预滤后必须留有幸存候选（替身级否决不许把池子毙空）", () => {
    // 这个不变量防的是**过度冻结**：某词条没进 INFORMAL_ONLY_KEYS（判定为混合池），
    // 但它的全部替身又都在 FORMAL_FORBIDDEN_SUBSTITUTES 里 ⇒ 正式体裁下
    // 预滤后的池子为空、pick 恒为 undefined、永不替换——那它事实上已被冻结，
    // 却不在冻结集里，数据自相矛盾。实测当前全表 0 条命中。
    for (const [from, tos] of Object.entries(VOCAB)) {
      if (INFORMAL_ONLY_KEYS.has(from)) continue;
      const eff = tos.filter((t) => t !== from);
      const pool = eff.length ? eff : tos;
      const survivors = pool.filter((t) => !FORMAL_FORBIDDEN_SUBSTITUTES.has(t));
      expect(
        survivors.length,
        `「${from}」未冻结，但所有替身都被替身级表毙掉 ⇒ 正式体永不替换。` +
          `要么把它改判进 INFORMAL_ONLY_KEYS，要么给池子补一个正式安全候选`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("LEAK_WORDS 源词：冻结 vs 必须换的冲突处置（v0.9.49 实测回归）", () => {
  // 这段冲突真实发生过：赋能/心智的有效池也曾全口语，一度进了 INFORMAL_ONLY_KEYS，
  // 结果 verify-quality 的「强度 1.0 黑话零泄漏」门禁当场红（25 seed × 2 词 = 50 次）——
  // 它们是 LEAK_WORDS 营销黑话，正式稿里留着比换成口语替身更糟。
  // 处置：池子补正式安全候选（助力/思路）→ 按收词口径降级为混合池，
  // 口语三人组转替身级否决。本块锁住这个处置的三个面向。
  const LEAK_TEXT =
    "值得注意的是，基于大数据，技术赋能传统产业已成为趋势。团队需对齐心智，沉淀经验。";

  it("赋能/心智不在冻结集里（它们是必须换的黑话，不是可冻结的普通词）", () => {
    expect(INFORMAL_ONLY_KEYS.has("赋能")).toBe(false);
    expect(INFORMAL_ONLY_KEYS.has("心智")).toBe(false);
  });

  it("正式体裁：黑话被换掉，且换的是正式安全候选（助力/思路），不是口语三人组", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const out = humanize(LEAK_TEXT, { intensity: 1, seed, genre: "main" });
      expect(out, `seed=${seed}：赋能没被换掉`).not.toContain("赋能");
      expect(out, `seed=${seed}：心智没被换掉`).not.toContain("心智");
      expect(out, `seed=${seed}：正式体泄漏了口语替身`).not.toMatch(
        /助攻|帮衬|帮着|心思|脑子|心神/,
      );
    }
  });

  it("正式体裁：助力/思路确实出现（安全候选真的在池子里，不是形同虚设）", () => {
    let sawZhuLi = false;
    let sawSilu = false;
    for (let seed = 1; seed <= 24; seed++) {
      const out = humanize(LEAK_TEXT, { intensity: 1, seed, genre: "main" });
      if (out.includes("助力")) sawZhuLi = true;
      if (out.includes("思路")) sawSilu = true;
    }
    expect(sawZhuLi, "24 个 seed 都没挑中「助力」——安全候选没进池或进错了位置").toBe(true);
    expect(sawSilu, "24 个 seed 都没挑中「思路」——安全候选没进池或进错了位置").toBe(true);
  });

  it("casual 体裁：口语替身仍可出场（门控没有把 casual 也一起毙了）", () => {
    const colloquial = /助攻|帮衬|帮着|心思|脑子|心神/;
    let anyHit = false;
    for (let seed = 1; seed <= 24; seed++) {
      const out = humanize(LEAK_TEXT, { intensity: 1, seed, genre: "dialogue" });
      if (colloquial.test(out)) anyHit = true;
    }
    expect(anyHit, "24 个 seed 全部只出安全候选——口语池被误毙").toBe(true);
  });
});
