/**
 * src/engine/vocab-formal-substitutes.test.ts — 正式语体替身冻结（v0.9.46）
 *
 * 背景：此前 VOCAB 在正式语体下也会把「努力→使劲」「围绕→环绕」「体现→看得出来」，
 * 全靠 anti-fingerprint 的 FORMAL_RESTORE **事后**把它们改回来，而那层还被体裁门控包着。
 * 真实案例（scripts/realcase C1 季度工作总结）实测：Guardian 层全都活着，产出照样是
 * 「使劲在下一季度取得」「紧紧环绕公司年度战略目标」「主要看得出来在跨部门…」。
 * → 改成替换阶段就地否掉（FORMAL_FORBIDDEN_SUBSTITUTES）。
 *
 * 本文件锁三件事：
 *   ① 表里的词确有出处：要么是 FORMAL_RESTORE 已经在还原的目标词，要么有真实案例实证
 *      （不能随手往里加词，否则它就变成下一个堆满 ad-hoc 规则的垃圾桶）；
 *   ② 表里的词确实存在于 VOCAB 候选里（写错字的表项毫无作用，必须能被抓到）；
 *   ③ 端到端：main 体裁的正式文本产出里不得再出现这些替身。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { humanize, FORMAL_FORBIDDEN_SUBSTITUTES } from "./humanize";
import { VOCAB } from "./humanize-vocab";

/** ⚠️ 必须与生产同源：直接 import，不要在测试里另抄一份（抄了就会各改各的、形同虚设） */
const FORMAL_FORBIDDEN = [...FORMAL_FORBIDDEN_SUBSTITUTES];

/** 与 FORMAL_RESTORE 不同源的三条：只有真实案例实证，必须显式登记，否则上面的同源守卫会红 */
const REALCASE_ONLY = new Set([
  "使劲",
  "看得出来",
  "环绕",
  // v0.9.49：C1 剩余两条（落实→做到位 / 协同→一起），同样是真实案例实证、
  // 同样不在 FORMAL_RESTORE 里——它们的源词条是混合池，按收词口径走替身级否决。
  "做到位",
  "一起",
  // v0.9.50：第二批。来源换成 scripts/realcase/leak-scan.ts 的多种子复核窗——
  // 之前那批是"一个 seed 跑一遍碰上了"，本批是 10 篇 × 12 seed 系统扫出来的，
  // 见 PATTERN 注释：换证据源是因为单点抽查扛不住 rng。
  "变强",
  "加把劲",
  "抓实",
  "抓紧",
  "联手",
  "这么一来",
]);

/**
 * v0.9.49 第三类证据：LEAK_WORDS 源词的口语池。
 * 赋能/心智是 verify-quality 的 LEAK_WORDS 营销黑话，强度 1.0 零泄漏门禁要求
 * 无论体裁必须换掉 ⇒ 不能整条冻结；v0.9.49 给池子补了正式安全候选
 * （助力/思路），这些口语替身的处置是"毙掉、让安全候选成为正式体唯一选项"。
 * 与 REALCASE_ONLY 分开登记：证据性质不同（门禁要求 vs 真实案例实测），
 * 混在一个集合里会让"为什么毙它"变得不可追。
 */
const LEAK_WORD_PROVEN = new Set(["助攻", "帮衬", "帮着", "心思", "脑子", "心神"]);

const SRC = readFileSync(new URL("./anti-fingerprint.ts", import.meta.url), "utf-8");

function formalRestoreBody(): string {
  const start = SRC.indexOf("const FORMAL_RESTORE");
  const end = SRC.indexOf("];", start);
  expect(start, "前置：anti-fingerprint.ts 里必须还能找到 FORMAL_RESTORE").toBeGreaterThan(-1);
  return SRC.slice(start, end);
}

describe("正式语体替身冻结表（来源合法性）", () => {
  it("①每个词要么已被 FORMAL_RESTORE 还原，要么有真实案例/门禁要求登记", () => {
    const body = formalRestoreBody();
    for (const w of FORMAL_FORBIDDEN) {
      const inRestore = body.includes(w);
      const 它有实证 = REALCASE_ONLY.has(w);
      const 门禁要求 = LEAK_WORD_PROVEN.has(w);
      expect(
        inRestore || 它有实证 || 门禁要求,
        `「${w}」既不在 FORMAL_RESTORE 里，也没有登记实证 → 属于随手加词，删掉或补证据`,
      ).toBe(true);
    }
  });

  it("②每个词都必须真的在某个 VOCAB 词条候选里（写错字的表项等于没写）", () => {
    const allCandidates = new Set<string>();
    for (const tos of Object.values(VOCAB)) {
      for (const t of tos) allCandidates.add(t);
    }
    for (const w of FORMAL_FORBIDDEN) {
      expect(allCandidates.has(w), `VOCAB 里根本不存在替身「${w}」`).toBe(true);
    }
  });
});

describe("端到端：正式语体不再产出这些口语替身", () => {
  // C1 风格的季度工作总结：一口气命中「围绕/全面/落实/体现/增强/加强/协同/值得注意的是」
  const SUMMARY =
    "第三季度，团队紧紧围绕年度战略目标，全面落实各项重点工作任务，取得了较为显著的工作成效。这主要体现在跨部门协同效率有待进一步提升。值得注意的是，我们全面增强和加强了两项基础能力，并通过流程再造从而进一步压缩了响应周期。展望未来，我们将继续努力提升交付质量。";

  it("main 体裁：五个替身都不出现，且未标记词条的替换没被冻死", () => {
    const out = humanize(SUMMARY, { intensity: 1, seed: 20261015, genre: "main" });
    expect(out).not.toContain("使劲");
    expect(out).not.toContain("环绕");
    expect(out).not.toContain("看得出来");
    expect(out).not.toContain("做到位");
    expect(out).not.toContain("一起");
    // ⚠️ v0.9.49 前提修订：v0.9.46 时这里断言「围着/下功夫/联手 仍可出现」
    //（替身级否决"只毙那一个，不动整个词条"）。实测这两个词在总结体里
    // 同样是语体崩，围绕/努力已按 INFORMAL_ONLY_KEYS 整条冻结 ⇒ 围着/下功夫
    // 在正式体同样不许出现。"替换没被冻死"的对照改用**未标记词条**表达：
    // 提升→提高 是混合池里的正式安全候选，必须还能换（否则等于把正式体的
    // 去味收益整块砍掉，那是另一种失败）。
    expect(out).not.toContain("围着");
    expect(out).not.toContain("下功夫");
    expect(out).toMatch(/提高|进步/);
  });

  /**
   * ⚠️ v0.9.50 这条是本轮真正的教训所在：
   * 上面的单点用例用的强度是 **1.0**，而产品默认档是 **0.9**。拦截清单里的「看得出来/
   * 透出/办妥」在 0.9 的产出里照样出现（多种子 4/12），单点 1.0 断言却一直是绿的。
   * ⇒ 某个替身会不会被挑中，取决于强度与种子的组合，只测一个点等于抽奖。
   * 这里按 0.9 与 1.0 各扫 10 个种子。
   * ⚠️⚠️ 第二个坑（自踩）：判串**不能从生产表反查**。初版写的是
   * `new RegExp(FORMAL_FORBIDDEN.join("|"))`，于是"从表里删掉某一项"这种变异
   * 会同时把对它的检查一起删掉——测试自己给自己的缺陷发通行证
   *（实测：把「这么一来」整行删掉，4 条用例全绿）。⇒ 判据必须与被测对象独立。
   */
  const MUST_NEVER_APPEAR = [
    "使劲",
    "下功夫",
    "环绕",
    "围着",
    "看得出来",
    "透出",
    "做到位",
    "办妥",
    "做实",
    "一起",
    "变强",
    "加把劲",
    "抓实",
    "抓紧",
    "联手",
    "这么一来",
    "说起来",
    "顺带一提",
    "有个细节",
    "方方面面",
    "铺开",
  ];

  it("多强度 × 多 seed：0.9（产品默认）与 1.0 都不泄漏", () => {
    const pattern = new RegExp(MUST_NEVER_APPEAR.join("|"));
    for (const intensity of [0.9, 1]) {
      for (let seed = 1; seed <= 10; seed++) {
        const out = humanize(SUMMARY, { intensity, seed, genre: "main" });
        const hit = out.match(pattern);
        expect(hit, `intensity=${intensity} seed=${seed} 泄漏「${hit?.[0]}」`).toBeNull();
      }
    }
  });

  it("第二批替身的候选池配套已生效：安全候选仍在（别把词条整个冻死）", () => {
    // 混合池的处置是"毙坏的那一个、留安全的那个"——这里守的正是另一个方向的失败：
    // 如果哪天有人把它们挪进 INFORMAL_ONLY_KEYS 整条冻结，正式稿就什么都不换了。
    const out = humanize(SUMMARY, { intensity: 0.9, seed: 3, genre: "main" });
    expect(out).toMatch(/强化|配合/);
  });
});
