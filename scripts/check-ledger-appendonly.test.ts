/**
 * scripts/check-ledger-appendonly.test.ts —— 逐条造一次篡改，打穿这道 append-only 门禁
 *
 * 这套外部真值的全部价值是"历史行不会被动"。audit 那侧只能发现字段对不上的篡改，
 * 删整行 / 重排 / 改不参与复算的自由文本字段它都看不见——所以这里必须把三种形态
 * 各造一次，证明它们都会被抓到；同时证明**纯追加绝不误伤**（误伤一次，下次就有人 --no-verify）。
 *
 * 导入写 `./check-ledger-appendonly`（无 .ts 后缀）：tsconfig 开了 allowImportingTsExtensions，
 * 带后缀会被 tsc 以 TS5097 拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { diffLedger, main, parseArgs, LEDGER_REL_DEFAULT } from "./check-ledger-appendonly";

const L = (id: string, pct: number) => JSON.stringify({ id, pct, note: `记录 ${id}` });
const HEAD = [L("O1", 85), L("O2", 45), L("O3", 12)].join("\n") + "\n";

describe("diffLedger：只许追加", () => {
  it("纯追加 → 通过，且不误报行数", () => {
    const v = diffLedger(HEAD, HEAD + L("O4", 7) + "\n");
    expect(v.ok).toBe(true);
    expect(v.violations).toEqual([]);
    expect(v.headLines).toBe(3);
    expect(v.stagedLines).toBe(4);
  });

  it("一行都没追加（内容完全相同）→ 通过", () => {
    expect(diffLedger(HEAD, HEAD).ok).toBe(true);
  });

  it("HEAD 为空（这本账本第一次建立）→ 追加多少都算合法", () => {
    expect(diffLedger("", HEAD).ok).toBe(true);
  });

  it("行尾空白/CRLF/尾部空行都不该被当成篡改", () => {
    const crlf = HEAD.split("\n").join("\r\n");
    expect(diffLedger(HEAD, crlf).ok).toBe(true);
    expect(diffLedger(HEAD, HEAD.replace(/\n$/, "") + "\n\n  \n").ok).toBe(true);
  });

  it("改一个字节 → 拦（改写与删除在前缀断裂上不可分，故合并报一条）", () => {
    const tampered = HEAD.replace('"pct":45', '"pct":44');
    const v = diffLedger(HEAD, tampered);
    expect(v.ok).toBe(false);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0].kind).toBe("modified");
    expect(v.violations[0].line).toBe(2);
  });

  it("只改不参与复算的自由文本字段（note）→ 照样拦（这条 audit 看不见）", () => {
    const v = diffLedger(HEAD, HEAD.replace("记录 O2", "记录 O2-被顺手美化过"));
    expect(v.ok).toBe(false);
    expect(v.violations[0].line).toBe(2);
  });

  it("删掉中间一行 → 拦", () => {
    const v = diffLedger(HEAD, L("O1", 85) + "\n" + L("O3", 12) + "\n");
    expect(v.ok).toBe(false);
    expect(v.violations[0].line).toBe(2);
  });

  it("把最新一行挪到最前面（重排）→ 拦", () => {
    const v = diffLedger(HEAD, L("O3", 12) + "\n" + L("O1", 85) + "\n" + L("O2", 45) + "\n");
    expect(v.ok).toBe(false);
    expect(v.violations[0].kind).toBe("reordered");
  });

  it("截断尾部（只留前两行）→ 拦，且报 truncated", () => {
    const v = diffLedger(HEAD, L("O1", 85) + "\n" + L("O2", 45) + "\n");
    expect(v.ok).toBe(false);
    expect(v.violations[0].kind).toBe("truncated");
  });

  it("整本清空 → 拦，报 deleted-all", () => {
    const v = diffLedger(HEAD, "");
    expect(v.ok).toBe(false);
    expect(v.violations[0].kind).toBe("deleted-all");
  });

  it("先删一行再追加一行（最像'正常修订'的那一种）→ 仍然拦", () => {
    const v = diffLedger(HEAD, L("O1", 85) + "\n" + L("O3", 12) + "\n" + L("O4", 7) + "\n");
    expect(v.ok).toBe(false);
    expect(v.violations[0].line).toBe(2);
  });
});

describe("parseArgs / main：参数与退出码", () => {
  let tmp: string;
  let headFile: string;
  let stagedFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ao-"));
    headFile = path.join(tmp, "head.jsonl");
    stagedFile = path.join(tmp, "staged.jsonl");
    fs.writeFileSync(headFile, HEAD);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("--staged-file 不给 --head-file → 用法错（退出码 2）", () => {
    expect(parseArgs(["--staged-file", stagedFile]).usageError).toMatch(/--head-file/);
    fs.writeFileSync(stagedFile, HEAD);
    expect(main(["--staged-file", stagedFile])).toBe(2);
  });

  it("文件对照：纯追加退出 0，被改过退出 1", () => {
    fs.writeFileSync(stagedFile, HEAD + L("O4", 7) + "\n");
    expect(main(["--head-file", headFile, "--staged-file", stagedFile, "--quiet"])).toBe(0);
    fs.writeFileSync(stagedFile, HEAD.replace('"pct":12', '"pct":13'));
    expect(main(["--head-file", headFile, "--staged-file", stagedFile, "--quiet"])).toBe(1);
  });

  it("head-file 不存在时按「无历史」处理，且绝不回落到真仓库的 git", () => {
    // --repo 指到一个不存在的目录：若实现偷偷走 git，这里会拿到 null→报错或非 0
    fs.writeFileSync(stagedFile, HEAD);
    expect(
      main([
        "--head-file",
        path.join(tmp, "not-there.jsonl"),
        "--staged-file",
        stagedFile,
        "--repo",
        path.join(tmp, "no-such-repo"),
        "--quiet",
      ]),
    ).toBe(0);
  });
});

/**
 * 真 git 仓库跑一遍端到端：这条 hook 依赖的就是 git show HEAD:<path> 与 :<path> 这两路取值，
 * 只用文件对照测的话，"HEAD 读不到 / 索引里是待提交版本"这些接线错误会全躲过去。
 */
describe("git 取数路径（临时仓库端到端）", () => {
  const LEDGER_REL = LEDGER_REL_DEFAULT.split(path.sep).join("/");
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ao-repo-"));
    git("-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@e.st", "init", "-q");
    fs.mkdirSync(path.join(repo, "evidence", "zhuque"), { recursive: true });
    fs.writeFileSync(path.join(repo, LEDGER_REL), HEAD);
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@e.st", "commit", "-q", "-m", "ledger");
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("未改动 → 退出 0", () => {
    expect(main(["--repo", repo, "--quiet"])).toBe(0);
    expect(main(["--repo", repo, "--staged", "--quiet"])).toBe(0);
  });

  it("工作区追加一行 → 退出 0；--staged 模式下索引没变也算 0", () => {
    fs.appendFileSync(path.join(repo, LEDGER_REL), L("O4", 7) + "\n");
    expect(main(["--repo", repo, "--quiet"])).toBe(0);
    expect(main(["--repo", repo, "--staged", "--quiet"])).toBe(0);
  });

  it("工作区改写历史行 → 退出 1（不 --staged 时看的就是工作区那份）", () => {
    fs.writeFileSync(path.join(repo, LEDGER_REL), HEAD.replace('"pct":85', '"pct":86'));
    expect(main(["--repo", repo, "--quiet"])).toBe(1);
  });

  it("暂存区里删掉整行 → --staged 模式退出 1（这才是 hook 走的那条路）", () => {
    fs.writeFileSync(path.join(repo, LEDGER_REL), L("O1", 85) + "\n");
    git("add", "-A");
    expect(main(["--repo", repo, "--staged", "--quiet"])).toBe(1);
  });

  it("账本还没进仓库（首次建账本）→ 退出 0", () => {
    // git show HEAD:<path> 在这条路径上必然失败 → 空历史 → 追加合法
    expect(
      main(["--repo", repo, "--ledger", "evidence/zhuque/never-committed.jsonl", "--quiet"]),
    ).toBe(0);
  });
});
