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
const REALCASE_ONLY = new Set(["使劲", "看得出来", "环绕"]);

const SRC = readFileSync(new URL("./anti-fingerprint.ts", import.meta.url), "utf-8");

function formalRestoreBody(): string {
  const start = SRC.indexOf("const FORMAL_RESTORE");
  const end = SRC.indexOf("];", start);
  expect(start, "前置：anti-fingerprint.ts 里必须还能找到 FORMAL_RESTORE").toBeGreaterThan(-1);
  return SRC.slice(start, end);
}

describe("正式语体替身冻结表（来源合法性）", () => {
  it("①每个词要么已被 FORMAL_RESTORE 还原，要么有真实案例实证登记", () => {
    const body = formalRestoreBody();
    for (const w of FORMAL_FORBIDDEN) {
      const inRestore = body.includes(w);
      const 它有实证 = REALCASE_ONLY.has(w);
      expect(
        inRestore || 它有实证,
        `「${w}」既不在 FORMAL_RESTORE 里，也没有真实案例登记 → 属于随手加词，删掉或补证据`,
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
  // C1 风格的季度工作总结：一口气命中「努力/围绕/体现」三个词条
  const SUMMARY =
    "第三季度，团队紧紧围绕年度战略目标，全面落实各项重点工作任务，取得了较为显著的工作成效。这主要体现在跨部门协同效率有待进一步提升。展望未来，我们将继续努力提升交付质量。";

  it("main 体裁：使劲 / 环绕 / 看得出来 三个替身都不出现，且替换本身没被整体冻死", () => {
    const out = humanize(SUMMARY, { intensity: 1, seed: 20261015, genre: "main" });
    expect(out).not.toContain("使劲");
    expect(out).not.toContain("环绕");
    expect(out).not.toContain("看得出来");
    // 否掉的是"那一个具体替身"，不是整个词条：同源的安全候选仍可选择
    // （围着/下功夫/联手 都是这些词条的合法候选），否则这条规则等于把去味收益整块砍掉
    expect(out).toMatch(/围着|下功夫|联手/);
  });

  it("多 seed 稳定：连续 8 个种子都不泄漏（表皮单次运气绿）", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const out = humanize(SUMMARY, { intensity: 1, seed, genre: "main" });
      expect(out, `seed=${seed}`).not.toMatch(/使劲|环绕|看得出来/);
    }
  });
});
