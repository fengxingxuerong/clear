/**
 * check-version-sync.test.ts —— 版本号一致性门禁的自测
 *
 * 为什么每条都要"故意造一次不一致"：这道门禁的存在理由就是"漏改三次没人发现"，
 * 所以它自己必须证明**每一种漏法都能被抓到**，否则它只是又一道绿着的摆设。
 * 另有一条专门断言"下载行**不**参与比对"——那是发版流程的正常中间态，加了会挡住发布。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkVersionSync } from "./check-version-sync";

let dir: string;

const write = (rel: string, content: string) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
};

/** 造一份"全部一致"的仓库快照，随后由各用例逐处破坏 */
function makeRepo(version = "0.9.19"): string {
  write("package.json", JSON.stringify({ name: "x", version }, null, 2));
  write("electron-app/package.json", JSON.stringify({ name: "x", version }, null, 2));
  write("README.md", `# 趣AI味 · QuAiWei v${version}\n\n**下载**：[Windows 免安装包（v${version}）](https://example.com)——解压即用。\n\n完整版本历史见 CHANGELOG.md。当前版本 **v${version}**（以 \`package.json\` 为准）。\n`);
  write("CHANGELOG.md", `# 更新日志\n\n## v${version} 更新（本版）\n\n内容。\n\n## v0.9.18 更新（上一版）\n`);
  return dir;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ver-sync-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("checkVersionSync", () => {
  it("四处全部一致 → ok，且每行都标 ✅", () => {
    const r = checkVersionSync(makeRepo());
    expect(r.ok).toBe(true);
    expect(r.expected).toBe("0.9.19");
    expect(r.rows.map((x) => x.loc)).toEqual([
      "根 package.json",
      "electron-app/package.json",
      "README.md 标题行",
      "README.md「当前版本」行",
      "CHANGELOG.md 本版章节",
    ]);
    expect(r.rows.every((x) => x.ok)).toBe(true);
  });

  it("README「当前版本」行落后 → 红（v0.9.19 发版时它停在 v0.9.18，标题行查了、这行没查）", () => {
    makeRepo();
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf-8").replace("当前版本 **v0.9.19**", "当前版本 **v0.9.18**");
    write("README.md", readme);
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    expect(r.rows.filter((x) => !x.ok).map((x) => x.loc)).toEqual(["README.md「当前版本」行"]);
  });

  it("README 下载行**不参与**比对：发版前它必然落后，纳入强校验会挡住正常发布流程", () => {
    makeRepo();
    // 「先 bump 版本 → 提交 → build/repack → 发布 → 才改下载行」是本项目的固定顺序，
    // 所以"下载行还标着上一版"是**正常中间态**，不能判红。
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf-8").replace("包（v0.9.19）", "包（v0.9.18）");
    write("README.md", readme);
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(true);
    expect(r.rows.some((x) => x.loc.includes("下载行"))).toBe(false);
  });

  it("README 标题行落后 → 红，且指出是标题行（v0.9.19 的真实漏法）", () => {
    makeRepo();
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf-8").replace("QuAiWei v0.9.19", "QuAiWei v0.9.18");
    write("README.md", readme);
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    const bad = r.rows.filter((x) => !x.ok);
    expect(bad.map((x) => x.loc)).toEqual(["README.md 标题行"]);
    expect(bad[0].actual).toBe("0.9.18");
  });

  it("CHANGELOG 缺本版章节 → 红（改了版本号却没写更新日志）", () => {
    makeRepo();
    write("CHANGELOG.md", "# 更新日志\n\n## v0.9.18 更新（上一版）\n");
    const r = checkVersionSync(dir);
    const bad = r.rows.find((x) => x.loc === "CHANGELOG.md 本版章节");
    expect(r.ok).toBe(false);
    expect(bad?.ok).toBe(false);
    expect(bad?.actual).toBe("0.9.18");
    expect(bad?.note).toContain("现有章节");
  });

  it("electron-app/package.json 落后 → 红（产物版本会跟着错）", () => {
    makeRepo();
    write("electron-app/package.json", JSON.stringify({ version: "0.9.15" }));
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    expect(r.rows.find((x) => x.loc === "electron-app/package.json")?.actual).toBe("0.9.15");
  });

  it("产物存在且版本落后 → 红；产物不存在 → 不参与比对，不因此变红", () => {
    makeRepo();
    expect(checkVersionSync(dir).rows.some((x) => x.loc.includes("产物"))).toBe(false);

    write("electron-dist/QuAiWei-win32-x64/resources/app/package.json", JSON.stringify({ version: "0.9.18" }));
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    expect(r.rows.find((x) => x.loc.includes("产物"))?.actual).toBe("0.9.18");
  });

  it("读不到根 package.json → 抛错（由 CLI 转成退出码 2，不许当成'一致'）", () => {
    expect(() => checkVersionSync(dir)).toThrow(/package.json/);
  });
});
