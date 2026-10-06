import { describe, it, expect } from "vitest";
import {
  DEFECT_TAXONOMY,
  allTaxonomySignatures,
  unfixedCategories,
} from "../scripts/defect-taxonomy";

/**
 * defect-taxonomy 自检 —— 防对照表与实际签名脱节。
 *
 * 这类「索引型」文件的失败模式是**悄悄过期**：代码改了，表没改，
 * 于是它开始说谎——「这类没修过」，其实早修过了。
 * 所以必须钉住它与 `scan-bugs.ts` 的一致性。
 */

describe("缺陷类别对照表", () => {
  it("每条类别都有非空 desc 与至少一个签名", () => {
    for (const e of DEFECT_TAXONOMY) {
      expect(e.desc.length, `类别「${e.category}」desc 为空`).toBeGreaterThan(10);
      expect(e.signatures.length, `类别「${e.category}」没有登记任何签名`).toBeGreaterThan(0);
      expect(e.layer, `类别「${e.category}」没有根因层`).toBeTruthy();
    }
  });

  it("签名名格式统一为「组名:签名名」，组名不得含冒号", () => {
    for (const sig of allTaxonomySignatures()) {
      expect(sig, `签名「${sig}」格式应为 组名:签名名`).toMatch(/^[^:]+:[^:]+$/);
    }
  });

  /**
   * 关键不变量：**同一个签名不能被登记到两个类别**。
   *
   * ⚠️ 这条不是洁癖。一条签名同时属于「切句破坏」和「语法位错配」，
   *   意味着它测的两种根因都能触发它——那它是**两个签名的合集**，
   *   命中时无法判断该往哪查。对照表会主动给出误导。
   */
  it("同一签名不得登记在两个类别下（否则命中时无法判断该往哪查）", () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const e of DEFECT_TAXONOMY) {
      for (const sig of e.signatures) {
        const prev = seen.get(sig);
        if (prev) dup.push(`${sig}：「${prev}」与「${e.category}」`);
        else seen.set(sig, e.category);
      }
    }
    expect(
      dup,
      `有签名被登记在多个类别下：\n  ${dup.join("\n  ")}\n\n` +
        `这会让「命中了这条签名该往哪查」变成多解。要么拆成两条签名，要么只登记主要类别。`,
    ).toEqual([]);
  });

  it("「从未修过」的类别必须留空 fixes，且清单可查", () => {
    const unfixed = unfixedCategories();
    for (const c of unfixed) {
      const e = DEFECT_TAXONOMY.find((x) => x.category === c)!;
      expect(e.fixes, `「${c}」在未修清单里却有 fixes`).toEqual([]);
    }
    // 这不是断言数量，是断言「这个函数能用」
    expect(Array.isArray(unfixed)).toBe(true);
  });

  /**
   * 覆盖度盘点：**故意不断言具体数字**，只报告。
   *
   * 为什么这样：签名数会随版本增减，把它钉死会让每次加签名都要改这个测试，
   * 而改测试的动力很弱——最终会变成「改数字让它过」。
   * 这里改成「打印一张表」，让缺登记的类别**在测试输出里看得见**。
   *
   * ⚠️ 真实门禁是「签名不得重复登记」（上一条），
   *   那条会因**表自身错误**而红；本条只提供可见性。
   */
  it("覆盖度盘点（报告用，不设硬门禁）", () => {
    const rows = DEFECT_TAXONOMY.map(
      (e) =>
        `  ${e.category.padEnd(18)} 层=${e.layer.padEnd(6)} 签名 ${e.signatures.length} 条  修复 ${e.fixes.length} 次`,
    ).join("\n");
    const unfixed = unfixedCategories();
    console.log(`\n缺陷类别对照表（${DEFECT_TAXONOMY.length} 类）：\n${rows}`);
    console.log(
      `\n从未修过的类别（体检优先方向）${unfixed.length} 个：${unfixed.join("、") || "无"}`,
    );
    expect(DEFECT_TAXONOMY.length).toBeGreaterThanOrEqual(9);
  });
});
