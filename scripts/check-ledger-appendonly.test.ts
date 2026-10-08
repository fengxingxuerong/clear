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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAsync } from "./run-async";
import { fileURLToPath } from "node:url";
import { diffLedger, main, parseArgs, LEDGER_REL_DEFAULT } from "./check-ledger-appendonly";

const L = (id: string, pct: number) => JSON.stringify({ id, pct, note: `记录 ${id}` });
const HEAD = [L("O1", 85), L("O2", 45), L("O3", 12)].join("\n") + "\n";

describe("diffLedger：只许追加", () => {
  it("纯追加 → 通过，且不误报行数", async () => {
    const v = diffLedger(HEAD, HEAD + L("O4", 7) + "\n");
    expect(v.ok).toBe(true);
    expect(v.violations).toEqual([]);
    expect(v.headLines).toBe(3);
    expect(v.stagedLines).toBe(4);
  });

  it("一行都没追加（内容完全相同）→ 通过", async () => {
    expect(diffLedger(HEAD, HEAD).ok).toBe(true);
  });

  it("HEAD 为空（这本账本第一次建立）→ 追加多少都算合法", async () => {
    expect(diffLedger("", HEAD).ok).toBe(true);
  });

  it("行尾空白/CRLF/尾部空行都不该被当成篡改", async () => {
    const crlf = HEAD.split("\n").join("\r\n");
    expect(diffLedger(HEAD, crlf).ok).toBe(true);
    expect(diffLedger(HEAD, HEAD.replace(/\n$/, "") + "\n\n  \n").ok).toBe(true);
  });

  it("改一个字节 → 拦（改写与删除在前缀断裂上不可分，故合并报一条）", async () => {
    const tampered = HEAD.replace('"pct":45', '"pct":44');
    const v = diffLedger(HEAD, tampered);
    expect(v.ok).toBe(false);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0].kind).toBe("modified");
    expect(v.violations[0].line).toBe(2);
  });

  it("只改不参与复算的自由文本字段（note）→ 照样拦（这条 audit 看不见）", async () => {
    const v = diffLedger(HEAD, HEAD.replace("记录 O2", "记录 O2-被顺手美化过"));
    expect(v.ok).toBe(false);
    expect(v.violations[0].line).toBe(2);
  });

  it("删掉中间一行 → 拦", async () => {
    const v = diffLedger(HEAD, L("O1", 85) + "\n" + L("O3", 12) + "\n");
    expect(v.ok).toBe(false);
    expect(v.violations[0].line).toBe(2);
  });

  it("把最新一行挪到最前面（重排）→ 拦", async () => {
    const v = diffLedger(HEAD, L("O3", 12) + "\n" + L("O1", 85) + "\n" + L("O2", 45) + "\n");
    expect(v.ok).toBe(false);
    expect(v.violations[0].kind).toBe("reordered");
  });

  it("截断尾部（只留前两行）→ 拦，且报 truncated", async () => {
    const v = diffLedger(HEAD, L("O1", 85) + "\n" + L("O2", 45) + "\n");
    expect(v.ok).toBe(false);
    expect(v.violations[0].kind).toBe("truncated");
  });

  it("整本清空 → 拦，报 deleted-all", async () => {
    const v = diffLedger(HEAD, "");
    expect(v.ok).toBe(false);
    expect(v.violations[0].kind).toBe("deleted-all");
  });

  it("先删一行再追加一行（最像'正常修订'的那一种）→ 仍然拦", async () => {
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

  it("--staged-file 不给 --head-file → 用法错（退出码 2）", async () => {
    expect(parseArgs(["--staged-file", stagedFile]).usageError).toMatch(/--head-file/);
    fs.writeFileSync(stagedFile, HEAD);
    expect(await main(["--staged-file", stagedFile])).toBe(2);
  });

  it("文件对照：纯追加退出 0，被改过退出 1", async () => {
    fs.writeFileSync(stagedFile, HEAD + L("O4", 7) + "\n");
    expect(await main(["--head-file", headFile, "--staged-file", stagedFile, "--quiet"])).toBe(0);
    fs.writeFileSync(stagedFile, HEAD.replace('"pct":12', '"pct":13'));
    expect(await main(["--head-file", headFile, "--staged-file", stagedFile, "--quiet"])).toBe(1);
  });

  it("head-file 不存在时按「无历史」处理，且绝不回落到真仓库的 git", async () => {
    // --repo 指到一个不存在的目录：若实现偷偷走 git，这里会拿到 null→报错或非 0
    fs.writeFileSync(stagedFile, HEAD);
    expect(
      await main([
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

  // ⚠️ 异步派生而非 execFileSync（2026-10-09 改的）：同步派生被环境挡下会整段抛错，
  // 而这里是 beforeEach —— 抛错会让每组用例在跑之前就崩，崩因写成"临时仓库没建起来"，
  // 完全盖掉真正的被测目标（git 取数路径）。
  const git = (...args: string[]) =>
    runAsync("git", ["-C", repo, ...args], { timeoutMs: 30000 }).then((r) => r.log);

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ao-repo-"));
    await git("-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@e.st", "init", "-q");
    fs.mkdirSync(path.join(repo, "evidence", "zhuque"), { recursive: true });
    fs.writeFileSync(path.join(repo, LEDGER_REL), HEAD);
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@e.st", "commit", "-q", "-m", "ledger");
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("未改动 → 退出 0", async () => {
    expect(await main(["--repo", repo, "--quiet"])).toBe(0);
    expect(await main(["--repo", repo, "--staged", "--quiet"])).toBe(0);
  });

  it("工作区追加一行 → 退出 0；--staged 模式下索引没变也算 0", async () => {
    fs.appendFileSync(path.join(repo, LEDGER_REL), L("O4", 7) + "\n");
    expect(await main(["--repo", repo, "--quiet"])).toBe(0);
    expect(await main(["--repo", repo, "--staged", "--quiet"])).toBe(0);
  });

  it("工作区改写历史行 → 退出 1（不 --staged 时看的就是工作区那份）", async () => {
    fs.writeFileSync(path.join(repo, LEDGER_REL), HEAD.replace('"pct":85', '"pct":86'));
    expect(await main(["--repo", repo, "--quiet"])).toBe(1);
  });

  it("暂存区里删掉整行 → --staged 模式退出 1（这才是 hook 走的那条路）", async () => {
    fs.writeFileSync(path.join(repo, LEDGER_REL), L("O1", 85) + "\n");
    await git("add", "-A");
    expect(await main(["--repo", repo, "--staged", "--quiet"])).toBe(1);
  });

  it("账本还没进仓库（首次建账本）→ 退出 0", async () => {
    // git show HEAD:<path> 在这条路径上必然失败 → 空历史 → 追加合法
    expect(
      await main(["--repo", repo, "--ledger", "evidence/zhuque/never-committed.jsonl", "--quiet"]),
    ).toBe(0);
  });

  /* ---- --head-ref：CI 唯一能真正生效的那条路 ----
   * 默认模式比的是 HEAD vs 干净检出，在 CI 上永远相等；只有显式给基准 ref，
   * 才能抓到"绕过本地 hook 提交了改写历史行"的那一次推送。 */

  it("--head-ref 指向当前提交且未改动 → 退出 0", async () => {
    const sha = (await git("rev-parse", "HEAD")).trim();
    expect(await main(["--repo", repo, "--head-ref", sha, "--quiet"])).toBe(0);
  });

  it("--head-ref 指向旧提交 + 之后改写了历史行 → 退出 1（CI 靠这条抓 --no-verify）", async () => {
    const base = (await git("rev-parse", "HEAD")).trim();
    fs.writeFileSync(path.join(repo, LEDGER_REL), HEAD.replace('"pct":85', '"pct":86'));
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@e.st", "commit", "-q", "-m", "tamper");
    expect(await main(["--repo", repo, "--head-ref", base, "--quiet"])).toBe(1);
    // 同一次改动在默认模式下是**漏网**的：HEAD 已经和被改的工作区一致
    expect(await main(["--repo", repo, "--quiet"])).toBe(0);
  });

  it("ref 解析不出来 → 退出 2，不许退化成「无历史」而假绿", async () => {
    expect(await main(["--repo", repo, "--head-ref", "no-such-ref-xyz", "--quiet"])).toBe(2);
  });

  it("--head-ref 给了但没给值 → 用法错 2", async () => {
    expect(await main(["--repo", repo, "--head-ref"])).toBe(2);
  });

  it("--head-ref 指向账本还不存在的提交 → 按无历史处理，退出 0", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ao-empty-"));
    await git(
      "-c",
      "core.autocrlf=false",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@e.st",
      "-C",
      empty,
      "init",
      "-q",
    );
    fs.mkdirSync(path.join(empty, "x"), { recursive: true });
    fs.writeFileSync(path.join(empty, "x", "f"), "1");
    await git("-C", empty, "add", "-A");
    await git(
      "-C",
      empty,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@e.st",
      "commit",
      "-q",
      "-m",
      "no ledger",
    );
    const sha = (await git("-C", empty, "rev-parse", "HEAD")).trim();
    // 仓库里账本已存在（repo 那份），基准却是"还没有账本"的提交
    expect(await main(["--repo", empty, "--head-ref", sha, "--quiet"])).toBe(0);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

/* 2026-10-05 分支补测：此前 6 个语句 / 10 条分支未覆盖——usage 三支、离线侧兜底、
   **非 quiet 输出两行**（既有用例几乎全带 --quiet，正常提示语从未被执行）、入口行 261。
   其中「只给 --head-file」那条还挖出一个真缺陷，见下。 */
describe("参数兜底与非 quiet 输出", () => {
  let tmp: string;
  let headFile: string;
  let stagedFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ao2-"));
    headFile = path.join(tmp, "head.jsonl");
    stagedFile = path.join(tmp, "staged.jsonl");
    fs.writeFileSync(headFile, HEAD);
    fs.writeFileSync(stagedFile, HEAD + L("O4", 7) + "\n");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("不带 --quiet 时打印进度与结论两行（行 231-236）", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--head-file", headFile, "--staged-file", stagedFile])).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(out).toContain("凭证账本 append-only 检查：HEAD 3 行 → 待提交 4 行");
    expect(out).toContain("✅ 只追加了 1 行，历史一字未动");
  });

  it("--head-file / --staged-file 不带值 → 用法错（行 137/138）", async () => {
    expect(parseArgs(["--head-file"]).usageError).toMatch(/--head-file 需要一个文件路径/);
    expect(parseArgs(["--staged-file"]).usageError).toMatch(/--staged-file 需要一个文件路径/);
    expect(await main(["--head-file"])).toBe(2);
    expect(await main(["--staged-file"])).toBe(2);
  });

  it("--staged-file 指向读不出来的路径 → 用法错并给出原因（行 154）", async () => {
    const bad = path.join(tmp, "nope.jsonl");
    expect(parseArgs(["--head-file", headFile, "--staged-file", bad]).usageError).toMatch(
      /--staged-file 读不出来/,
    );
    expect(await main(["--head-file", headFile, "--staged-file", bad])).toBe(2);
  });

  it("【真缺陷回归】只给 --head-file → 必须报用法错，而不是无条件通过", async () => {
    // 修复前：离线分支两侧都兜成 "" → diffLedger("","") 恒 ok → **head 文件里写什么
    // 都退出 0**。这道门禁的价值就是"历史不可改"，一个半配置输入就把它整个架空，
    // 是最典型的假绿。现已补上与 --staged-file 对称的校验。
    expect(parseArgs(["--head-file", headFile]).usageError).toMatch(/--head-file 必须与 --staged-file/);

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--head-file", headFile])).toBe(2);
    expect(err.mock.calls.map((c) => String(c[0] ?? "")).join("\n")).toMatch(/必须与 --staged-file/);
  });
});

describe("入口行 process.exit(main())（行 261）", () => {
  it("直接执行时把退出码交给 process.exit（进程内跑，不 spawn 子进程）", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-entry-"));
    const head = path.join(tmp, "h.jsonl");
    const staged = path.join(tmp, "s.jsonl");
    fs.writeFileSync(head, HEAD);
    fs.writeFileSync(staged, HEAD + L("O9", 3) + "\n");

    const scriptPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "check-ledger-appendonly.ts",
    );
    const realArgv = process.argv;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`__exit__${code ?? 0}`);
    });
    vi.resetModules(); // 让动态 import 重新求值，才会走到模块底部的入口判断
    try {
      process.argv = ["node", scriptPath, "--head-file", head, "--staged-file", staged, "--quiet"];
      await expect(import("./check-ledger-appendonly")).rejects.toThrow("__exit__0");
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      process.argv = realArgv;
      exitSpy.mockRestore();
      vi.resetModules();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
