/**
 * check-version-sync.test.ts —— 版本号一致性门禁的自测
 *
 * 为什么每条都要"故意造一次不一致"：这道门禁的存在理由就是"漏改三次没人发现"，
 * 所以它自己必须证明**每一种漏法都能被抓到**，否则它只是又一道绿着的摆设。
 * 另有一条专门断言"下载行**不**参与比对"——那是发版流程的正常中间态，加了会挡住发布。
 * 下半段补了 CLI main() 的自测：退出码 0/1/2 是这道门禁的对外契约（源码头注释白纸黑字写着），
 * 光测 checkVersionSync 不算测完——用"受控 argv + 重导入触发模块底部守卫"把三条路径真跑一遍。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

/** CLI 底部守卫触发 process.exit 时抛出的信号：拦截"真退出"，测试进程不许被杀 */
class CliExit extends Error {}

type CliRun = { code: number; out: string[]; errOut: string[] };

/**
 * 在受控 argv（可选 cwd）下**重新导入**被测模块：模块底部
 * 「argv[1] 以 check-version-sync.ts 结尾就执行 main()」的守卫会同步跑 main()，
 * console / process.exit 全部哑桩并在 finally 还原，不污染同文件其它用例。
 * code：0 = main() 正常走完（没碰 exit）；1/2 = 被 exit 替身捕获的退出码。
 */
async function runCli(opts: { argv?: string[]; cwd?: string } = {}): Promise<CliRun> {
  const origArgv = process.argv;
  const origCwd = process.cwd;
  const exits: number[] = [];
  const out: string[] = [];
  const errOut: string[] = [];
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    }),
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errOut.push(a.join(" "));
    }),
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      exits.push(typeof code === "number" ? code : Number(code ?? 0));
      throw new CliExit(`exit ${code ?? 0}`);
    }),
  ];
  // cwd 回退分支（不带 --repo / --repo 漏值）要钉在受控仓库上，不能依赖真实仓库状态
  if (opts.cwd) process.cwd = (() => opts.cwd!) as typeof process.cwd;
  process.argv = [origArgv[0], "check-version-sync.ts", ...(opts.argv ?? [])];
  vi.resetModules(); // 让下一行的 import 重新执行模块（含底部守卫）
  try {
    await import("./check-version-sync");
    return { code: exits[0] ?? 0, out, errOut };
  } catch (e) {
    if (e instanceof CliExit) return { code: exits[0] ?? 0, out, errOut };
    throw e;
  } finally {
    process.argv = origArgv;
    process.cwd = origCwd;
    for (const s of spies) s.mockRestore();
  }
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

  /* ---------------- 读不到 / 解析失败：每一种"读不出值"都必须 fail-closed ---------------- */

  it("README.md 文件不存在 → 标题行落点读不到并注明「文件不存在」，且不重复推「当前版本」行", () => {
    makeRepo();
    fs.rmSync(path.join(dir, "README.md"));
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    // 文件级缺失只报一次（标题行代表整个 README），「当前版本」行不再单独推
    expect(r.rows.map((x) => x.loc)).toEqual([
      "根 package.json",
      "electron-app/package.json",
      "README.md 标题行",
      "CHANGELOG.md 本版章节",
    ]);
    const bad = r.rows.find((x) => x.loc === "README.md 标题行");
    expect(bad?.actual).toBeNull();
    expect(bad?.note).toBe("文件不存在");
    expect(bad?.ok).toBe(false);
  });

  it("CHANGELOG.md 文件不存在 → 本版章节落点读不到并注明「文件不存在」", () => {
    makeRepo();
    fs.rmSync(path.join(dir, "CHANGELOG.md"));
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    expect(r.rows).toHaveLength(5); // 5 行照推：CHANGELOG 行读不到但带注记占位，不是不推
    const bad = r.rows.find((x) => x.loc === "CHANGELOG.md 本版章节");
    expect(bad?.actual).toBeNull();
    expect(bad?.note).toBe("文件不存在");
  });

  it("README 在但标题行没了（版本号被删/行改坏）→ 标题行读不到，且注记不是「文件不存在」", () => {
    makeRepo();
    write("README.md", `# 趣AI味 · QuAiWei\n\n完整版本历史见 CHANGELOG.md。当前版本 **v0.9.19**（以 \`package.json\` 为准）。\n`);
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    const bad = r.rows.find((x) => x.loc === "README.md 标题行");
    expect(bad?.actual).toBeNull();
    expect(bad?.note).toBeUndefined(); // 文件在只是匹配不上——与"文件缺失"两种情况区分开
    expect(r.rows.find((x) => x.loc === "README.md「当前版本」行")?.ok).toBe(true); // 同文件另一行照常查
  });

  it("README 在但「当前版本 **vX.Y.Z**」声明没了 → 该行读不到（标题行照常查，两行各查各的）", () => {
    makeRepo();
    write("README.md", `# 趣AI味 · QuAiWei v0.9.19\n\n完整版本历史见 CHANGELOG.md。\n`);
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    expect(r.rows.find((x) => x.loc === "README.md 标题行")?.ok).toBe(true);
    const bad = r.rows.find((x) => x.loc === "README.md「当前版本」行");
    expect(bad?.actual).toBeNull();
    expect(bad?.note).toBeUndefined();
  });

  it("CHANGELOG 一个「## vX.Y.Z 更新」章节都没有 → actual 为 null，注记列出（空的）现有章节", () => {
    makeRepo();
    write("CHANGELOG.md", "# 更新日志\n\n（整理中，暂无章节。）\n");
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    const bad = r.rows.find((x) => x.loc === "CHANGELOG.md 本版章节");
    expect(bad?.actual).toBeNull();
    expect(bad?.note).toBe("现有章节：…"); // 空列表 join 后的退化形态，也要给出可读注记
  });

  /* ---------------- package.json 四种坏法：全都必须抛错（fail-closed，不许静默一致） ---------------- */

  it("根 package.json 没有 version 字段 → 抛错（bump 漏字段不许当成一致）", () => {
    write("package.json", JSON.stringify({ name: "x" }));
    expect(() => checkVersionSync(dir)).toThrow(/version 字段/);
  });

  it("根 package.json 是坏 JSON → 抛错（JSON.parse 失败走 null 落点，不许静默通过）", () => {
    write("package.json", '{ 这不是合法 JSON');
    expect(() => checkVersionSync(dir)).toThrow(/version 字段/);
  });

  it("根 package.json 版本格式非法（VERSION_RE 不认，如 0.9.24-beta）→ 抛错", () => {
    write("package.json", JSON.stringify({ name: "x", version: "0.9.24-beta" }));
    expect(() => checkVersionSync(dir)).toThrow(/version 字段/);
  });

  it("electron-app/package.json 是坏 JSON → 该落点读不到 → 红", () => {
    makeRepo();
    write("electron-app/package.json", '{ 这不是合法 JSON');
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    const bad = r.rows.find((x) => x.loc === "electron-app/package.json");
    expect(bad?.actual).toBeNull();
    expect(bad?.ok).toBe(false);
  });

  it("electron-app/package.json 缺 version 字段 → 该落点读不到 → 红（文件在≠版本对）", () => {
    makeRepo();
    write("electron-app/package.json", JSON.stringify({ name: "x" }));
    const r = checkVersionSync(dir);
    expect(r.ok).toBe(false);
    expect(r.rows.find((x) => x.loc === "electron-app/package.json")?.actual).toBeNull();
  });
});

/* ---------------- CLI main()：退出码 0/1/2 是对外契约，必须真跑 ---------------- */
describe("check-version-sync CLI 退出码", () => {
  it("退出码 0：全部一致 → 5 个落点行逐行 ✅ + 收尾「全部落点一致」，stderr 干净", async () => {
    makeRepo();
    const cli = await runCli({ argv: ["--repo", dir] });
    expect(cli.code).toBe(0);
    expect(cli.out.some((l) => l.includes("期望版本（根 package.json）：0.9.19"))).toBe(true);
    expect(cli.out.filter((l) => l.includes("✅"))).toHaveLength(6); // 5 个落点行 + 1 行收尾
    expect(cli.out.some((l) => l.includes("全部落点一致"))).toBe(true);
    expect(cli.errOut).toEqual([]);
  });

  it("退出码 1：有落点读不到 → stdout 打「（读不到）← 文件不存在」，stderr 逐条「现在是…应为…」+ 修法提示", async () => {
    makeRepo();
    fs.rmSync(path.join(dir, "README.md"));
    const cli = await runCli({ argv: ["--repo", dir] });
    expect(cli.code).toBe(1);
    expect(cli.out.filter((l) => l.includes("❌"))).toHaveLength(1); // 只有 README 标题行是坏的
    expect(cli.out.some((l) => l.includes("（读不到）") && l.includes("← 文件不存在"))).toBe(true);
    expect(cli.errOut.some((l) => l.includes("1 处版本号与根 package.json（0.9.19）不一致"))).toBe(true);
    expect(cli.errOut.some((l) => l.includes("README.md 标题行：现在是 （读不到），应为 0.9.19"))).toBe(true);
    expect(cli.errOut.some((l) => l.includes("修法") && l.includes("0.9.19"))).toBe(true);
  });

  it("退出码 2：读不到根 package.json → 打 ✗ 退 2，且一行正常输出都没有（环境错≠一致）", async () => {
    const cli = await runCli({ argv: ["--repo", dir] }); // beforeEach 的空目录：连 package.json 都没有
    expect(cli.code).toBe(2);
    expect(cli.out).toEqual([]);
    expect(
      cli.errOut.some((l) => l.startsWith("✗") && l.includes(path.join(path.resolve(dir), "package.json"))),
    ).toBe(true);
    expect(cli.errOut.some((l) => l.includes("version 字段"))).toBe(true);
  });

  it("不带 --repo → 用 process.cwd() 当仓库根（与 npm run check:version 的默认调用同路径）", async () => {
    makeRepo();
    const cli = await runCli({ cwd: dir }); // 把 cwd 钉在受控仓库上，不依赖真实仓库状态
    expect(cli.code).toBe(0);
    expect(cli.out.some((l) => l.includes("全部落点一致"))).toBe(true);
  });

  it("--repo 后面漏了目录参数 → 退回当前目录（`args[i+1] ?? \".\"`）", async () => {
    makeRepo();
    const cli = await runCli({ argv: ["--repo"], cwd: dir });
    expect(cli.code).toBe(0);
    expect(cli.out.some((l) => l.includes("全部落点一致"))).toBe(true);
  });
});
