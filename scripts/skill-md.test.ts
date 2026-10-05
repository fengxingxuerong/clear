/**
 * skill-md.test.ts —— SKILL.md 薄壳与 CLI 参数的防漂移锁。
 *
 * 起因（2026-10-05 全面优化验证轮）：对标 blader/humanizer（54k★）靠「一行装进 agent」
 * 吃下的分发入口，补上 README 里一直标着「待办（未做）」的那份薄壳 SKILL.md。
 *
 * 文档类产物最大的风险不是写得不好，是**与代码漂移**——参数改了文档没跟、
 * 文档写了代码里根本没有的参数。本仓库已有 check:version「六处版本落点」的先例，
 * 这里用同一思路：把 SKILL.md 当可执行契约来测，而不是当散文。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = readFileSync(path.join(ROOT, "SKILL.md"), "utf8");
const CLI = readFileSync(path.join(ROOT, "scripts", "humanize-cli.ts"), "utf8");
const PKG_VERSION = (
  JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

/** 三个 `---` 之间的 frontmatter 原文 */
const frontmatter = /^---\n([\s\S]*?)\n---/.exec(SKILL)?.[1] ?? "";

/** CLI 真实认的参数：来自 parseArgs 的 case 分支 */
const cliFlags = new Set(
  [...CLI.matchAll(/case "(--[a-z][a-z-]*)"/g)].map((m) => m[1] as string),
);
/** SKILL.md 里出现过的全部 --参数（含命令示例与表格里的） */
const skillFlags = new Set([...SKILL.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));

describe("SKILL.md frontmatter", () => {
  it("存在且字段齐全，name 是合法的 skill 标识", () => {
    expect(frontmatter, "SKILL.md 必须以 YAML frontmatter 开头").not.toBe("");
    expect(frontmatter).toMatch(/^name: qu-ai-wei$/m);
    expect(frontmatter).toMatch(/^license: MIT$/m);
    // description 必须写清「什么时候用」，太短等于没写（skill 靠它决定是否被触发）
    const desc = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
    expect(desc.length).toBeGreaterThanOrEqual(30);
    expect(desc).toContain("去 AI 味");
    expect(desc).toMatch(/降 AI 率|AIGC/);
  });

  it("metadata.version 与 package.json 一致（防版本漂移，同 check:version 思路）", () => {
    const v = /^ {2}version: (\S+)$/m.exec(frontmatter)?.[1];
    expect(v, "frontmatter 里必须有 metadata.version").toBeTruthy();
    expect(v).toBe(PKG_VERSION);
  });
});

describe("SKILL.md ↔ humanize-cli.ts 参数契约", () => {
  it("前置条件：CLI 至少暴露 20 个参数（防两边都空导致永真断言）", () => {
    expect(cliFlags.size).toBeGreaterThanOrEqual(20);
  });

  it("文档里的每个参数在 CLI 里真实存在（不许文档造参数）", () => {
    const invented = [...skillFlags].filter((f) => !cliFlags.has(f));
    expect(invented, `SKILL.md 出现了 CLI 不认识的参数：${invented.join(" ")}`).toEqual([]);
  });

  it("CLI 的每个参数在 SKILL.md 里都有说明（不许文档落后于代码）", () => {
    const undocumented = [...cliFlags].filter((f) => !skillFlags.has(f));
    expect(undocumented, `CLI 新增了参数但 SKILL.md 没跟上：${undocumented.join(" ")}`).toEqual([]);
  });

  it("命令示例指向的脚本真实存在，且用法与 CLI 一致", () => {
    expect(existsSync(path.join(ROOT, "scripts", "humanize-cli.ts"))).toBe(true);
    expect(SKILL).toContain("npx tsx scripts/humanize-cli.ts");
    // CLI 的 Key 优先级说明不能被文档改错
    expect(SKILL).toContain("QUAIWEI_API_KEY");
  });
});

describe("SKILL.md 诚实边界（锁住不许被删）", () => {
  it("三条核心免责声明在位", () => {
    expect(SKILL).toContain("不承诺通过任何检测器");
    expect(SKILL).toContain("代理分");
    expect(SKILL).toContain("人写稿别去味");
    expect(SKILL).toContain("换词不换骨");
  });

  it("不许出现竞品常见的过度承诺话术", () => {
    // 「保证通过 / 必过检测 / 稳过检测」这类说法一旦进了文档，就等于替项目背了做不到的书
    expect(SKILL).not.toMatch(/保证.{0,6}通过|必过检测|稳过检测/);
  });

  it("不许教用户绕过检测器（本项目定位是自检与预处理，不是规避）", () => {
    expect(SKILL).not.toMatch(/绕过检测|规避检测器/);
  });
});
