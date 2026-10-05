/**
 * 正则自检的测试（scripts/check-regex-defects.ts）
 *
 * 这组用例的价值不在覆盖率——门禁自身一行 100% 覆盖也证明不了它抓得住东西。
 * 真正要钉的是**判据边界**：哪些写法必须放过（否则误报泛滥，门禁会被忽略），
 * 哪些必须拦下（否则形同虚设）。
 *
 * ⚠️ 输入一律用 `new RegExp(...).source` 取「引擎眼中的真实结构」，
 * 不手写转义字符串——手写时很容易少一层反斜杠，把测试本身写错
 * （本次就先写错过一次：把坏写法标成了合法）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasUnescapedBracketInCharClass,
  scanRegexDefects,
  runRegexSelfCheck,
  formatReport,
} from "./check-regex-defects.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 用引擎取真实 source，避免手写转义引入偏差 */
const src = (re: RegExp) => re.source;

describe("hasUnescapedBracketInCharClass —— 判据边界", () => {
  describe("必须报坏（真缺陷形态）", () => {
    it("本项目的原始坏写法：类后落单一个 ]", () => {
      // [\u4e00-\u9fa5…（）()【】[]] —— 类在第一个 [ 处闭合，剩下的 ] 落单
      expect(hasUnescapedBracketInCharClass(src(/[（）()【】[]]/))).toBe(true);
    });

    it("短形态：分清「类以 [ 结尾」与「闭合后落单 ]」", () => {
      // 类内容是 ab[ ，闭合后没有落单 ] → 合法（[[] 这类同理）
      expect(hasUnescapedBracketInCharClass(src(/[ab[]/))).toBe(false);
      // 类内容是 ab[ ，闭合后紧跟落单 ] → 提前闭合
      expect(hasUnescapedBracketInCharClass(src(/[ab[]]/))).toBe(true);
    });

    it("落单 ] 后面还有别的内容也算坏（不要求 ] 在模式末尾）", () => {
      // 判据看的是「闭合后紧邻的那个字符」，不是「是否在末尾」。
      // 反过来也成立：紧邻的是普通字符（如 x）说明没有落单 ]，不该报。
      expect(hasUnescapedBracketInCharClass(src(/[ab[]x]/))).toBe(false);
      expect(hasUnescapedBracketInCharClass(src(/[ab[]]x*/))).toBe(true);
    });
  });

  describe("必须放过（否则误报泛滥）", () => {
    it("标准元字符转义写法 [.*+?^${}()|[\\]\\\\] —— 类内 [ 是合法的字面量", () => {
      // 关键：JS 里字符类内部的 [ 不需要转义就能匹配 [。
      // 项目里有 3 处用这个写法（humanize-metrics×2 / shuffle/primitives），
      // 第一版判据就是在这里误报了 6 处。
      const s = src(/[.*+?^${}()|[\]\\]/);
      expect(hasUnescapedBracketInCharClass(s)).toBe(false);
      // 再确认它确实是合法且能用的
      const re = new RegExp(`^[${s.slice(1, -1)}]$`);
      expect(re.test("[")).toBe(true);
      expect(re.test("]")).toBe(true);
      expect(re.test("\\")).toBe(true);
      expect(re.test("a")).toBe(false);
    });

    it("类内首字符就是 [ （[[ ] 是合法的类，内容为 [）", () => {
      // 这条纠正过一个错误预期：[[] 不是「提前闭合」，
      // 它就是「匹配左方括号的字符类」，且没有落单的 ]。
      const s = src(/[[]/);
      expect(hasUnescapedBracketInCharClass(s)).toBe(false);
      expect(new RegExp(`^${s}$`).test("[")).toBe(true);
    });

    it("类内以 [ 结尾也没有落单 ] —— 合法", () => {
      // [ab[] 的类内容是 ab[ ，闭合后紧跟的是模式结尾而不是 ]
      expect(hasUnescapedBracketInCharClass(src(/[ab[]/))).toBe(false);
    });

    it("普通字符类 / 取反字符类", () => {
      expect(hasUnescapedBracketInCharClass(src(/[abc]/))).toBe(false);
      expect(hasUnescapedBracketInCharClass(src(/[^abc]/))).toBe(false);
    });

    it("类外被转义的 [（不是字符类）", () => {
      expect(hasUnescapedBracketInCharClass(src(/\[abc]/))).toBe(false);
    });

    it("完全没有字符类", () => {
      expect(hasUnescapedBracketInCharClass(src(/abc/))).toBe(false);
    });

    it("已修复的写法不再报", () => {
      // 同 no-useless-escape 的误报：这里的 `\[` 是被测字符串的一部分，不是多余的转义。
      // eslint-disable-next-line no-useless-escape
      expect(hasUnescapedBracketInCharClass(src(/[（）()【】\[\]]/))).toBe(false);
    });
  });
});

describe("scanRegexDefects —— 端到端", () => {
  it("本仓库当前零缺陷（dfbad6b 修复后应恒成立）", () => {
    const defects = scanRegexDefects(ROOT);
    // 报出来的话说明判据写宽了或引入了新缺陷；把详情带出来便于定位
    expect(defects.map((d) => `${d.file}:${d.line} ${d.literal}`)).toEqual([]);
  });

  it("能在临时目录里查出注入的缺陷（证明它真的抓得住，不是恒绿）", () => {
    // 这是最关键的一条：门禁恒绿和门禁有效，只有这条能区分。
    const tmp = fs.mkdtempSync(path.join(ROOT, ".covtmp-regex-"));
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "src", "bad.ts"),
      "export const re = /[\\u4e00-\\u9fa5（）()【】[]]{1,24}?[：:]/;\n",
      "utf8",
    );
    try {
      const defects = scanRegexDefects(tmp);
      expect(defects).toHaveLength(1);
      expect(defects[0].file).toBe("src/bad.ts");
      expect(defects[0].reason).toContain("提前闭合");
      expect(runRegexSelfCheck(tmp).ok).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("合法写法放在同一个目录里不应被报出来", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".covtmp-regex-"));
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "src", "good.ts"),
      "export const esc = /[.*+?^${}()|[\\]\\\\]/g;\nexport const plain = /[abc]/;\nexport const neg = /[^x]/;\n",
      "utf8",
    );
    try {
      expect(scanRegexDefects(tmp)).toEqual([]);
      expect(runRegexSelfCheck(tmp).ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("注释里出现的坏写法不误报（注释不是代码）", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".covtmp-regex-"));
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "src", "c.ts"),
      "// 历史写法：/[（）()【】[]]/\n/* 块注释里的 /(【】[]) */\nexport const ok = /[abc]/;\n",
      "utf8",
    );
    try {
      expect(scanRegexDefects(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("archive/ 与 node_modules/ 不在扫描范围", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".covtmp-regex-"));
    fs.mkdirSync(path.join(tmp, "scripts", "archive"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "node_modules", "x"), { recursive: true });
    const bad = "export const re = /[（）()【】[]]/;\n";
    fs.writeFileSync(path.join(tmp, "scripts", "archive", "old.ts"), bad, "utf8");
    fs.writeFileSync(path.join(tmp, "node_modules", "x", "i.js"), bad, "utf8");
    try {
      expect(scanRegexDefects(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("扫描目录不存在时不崩（返回空）", () => {
    // 门禁在 CI 上跑，cwd 一定对；但本地手滑传个错路径时，
    // 应该报"没有缺陷"而不是抛异常把 CI 变成无关失败。
    const tmp = fs.mkdtempSync(path.join(ROOT, ".covtmp-regex-"));
    try {
      expect(scanRegexDefects(tmp)).toEqual([]); // tmp 里没有 src/ 与 scripts/
      expect(runRegexSelfCheck(tmp).ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("formatReport —— CLI 输出（门禁自身不留覆盖缺口）", () => {
  it("零缺陷 → exitCode 0 + 通过文案", () => {
    const { lines, exitCode } = formatReport([]);
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("正则自检通过");
  });

  it("有缺陷 → exitCode 1，且每条都带文件:行号、正则原文、修法", () => {
    const { lines, exitCode } = formatReport([
      { file: "src/x.ts", line: 42, literal: "/[ab[]]/", reason: "字符类提前闭合" },
    ]);
    expect(exitCode).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("src/x.ts:42");
    expect(out).toContain("/[ab[]]/");
    expect(out).toContain("修法");
    expect(out).toContain("字符类提前闭合");
  });

  it("多条缺陷逐条输出，不合并成一行", () => {
    const { lines } = formatReport([
      { file: "a.ts", line: 1, literal: "/[a[]]/", reason: "r1" },
      { file: "b.ts", line: 2, literal: "/[b[]]/", reason: "r2" },
    ]);
    const out = lines.join("\n");
    expect(out).toContain("a.ts:1");
    expect(out).toContain("b.ts:2");
  });

  it("通过与失败两条路径的文案互斥（防有人把成功也报成失败）", () => {
    const okOut = formatReport([]).lines.join("\n");
    const badOut = formatReport([
      { file: "x", line: 1, literal: "/[a[]]/", reason: "r" },
    ]).lines.join("\n");
    expect(okOut).not.toContain("自检失败");
    expect(badOut).not.toContain("自检通过");
  });
});
