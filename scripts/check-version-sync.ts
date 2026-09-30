/**
 * check-version-sync.ts —— 版本号一致性门禁（补上漏了三次的缺口）
 *
 * 为什么需要它（三次都靠人眼发现）：
 *   v0.9.16、v0.9.18、v0.9.19 三次 bump，都是改了 `package.json` 两处 + CHANGELOG，
 *   却漏掉 README 的标题行或下载行。原因是既有的 `verify-pruned` [3] 只比对
 *   「产物内 `resources/app/package.json`」与「仓库根 `package.json`」——
 *   **两边一起停在旧值时它照样绿**，而 README 里写什么它根本不看。
 *
 * 本脚本把"版本号出现在哪几处"这件事本身当成检查对象：任何一处与 `package.json` 不一致即退出 1，
 * 并逐处打印"期望值 vs 实际值"，不用再去猜是谁落后了。
 *
 * 用法：
 *   npx tsx scripts/check-version-sync.ts [--repo <目录>]
 *   退出码：0 = 全部一致；1 = 有不一致（逐条列出）；2 = 用法/环境错（例如读不到 package.json）
 */
import fs from "node:fs";
import path from "node:path";

const VERSION_RE = /^v?(\d+\.\d+\.\d+)$/;

export interface VersionCheckResult {
  expected: string;
  /** 一处版本号落点的比对结果：loc=给人看的落点描述，actual=实际读到的值（读不到为 null） */
  rows: { loc: string; actual: string | null; ok: boolean; note?: string }[];
  ok: boolean;
}

/** README 标题行：# 趣AI味 · QuAiWei v0.9.19 */
const README_TITLE_RE = /^#\s*趣AI味\s*·\s*QuAiWei\s*v(\d+\.\d+\.\d+)\s*$/m;
/** README 下载行：**下载**：[Windows 免安装包（v0.9.19）](...)，容错链接文案变化 */
const README_DL_RE = /\*\*下载\*\*[\s\S]{0,120}?（v(\d+\.\d+\.\d+)）/;
/** CHANGELOG 章节标题：## v0.9.19 更新（…） */
const CHANGELOG_SEC_RE = /^##\s+v(\d+\.\d+\.\d+)\s+更新/gm;

function read(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), "utf-8");
  } catch {
    return null;
  }
}

function jsonVersion(root: string, rel: string): string | null {
  const raw = read(root, rel);
  if (!raw) return null;
  try {
    const v = (JSON.parse(raw) as { version?: string }).version;
    return v ? (VERSION_RE.exec(v)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * 比对全部落点。产物内的 package.json 只在产物存在时才比（本地没打包不该红）。
 */
export function checkVersionSync(root: string): VersionCheckResult {
  const expected = jsonVersion(root, "package.json");
  if (!expected) {
    throw new Error(`读不到 ${path.join(root, "package.json")} 的 version 字段`);
  }

  const rows: VersionCheckResult["rows"] = [];
  const push = (loc: string, actual: string | null, note?: string) =>
    rows.push({ loc, actual, ok: actual === expected, note });

  push("根 package.json", jsonVersion(root, "package.json"));
  push("electron-app/package.json", jsonVersion(root, "electron-app/package.json"));

  const readme = read(root, "README.md");
  if (readme === null) {
    push("README.md 标题行", null, "文件不存在");
  } else {
    push("README.md 标题行", README_TITLE_RE.exec(readme)?.[1] ?? null);
    push("README.md 下载行", README_DL_RE.exec(readme)?.[1] ?? null);
  }

  const changelog = read(root, "CHANGELOG.md");
  if (changelog === null) {
    push("CHANGELOG.md 本版章节", null, "文件不存在");
  } else {
    const versions = [...changelog.matchAll(CHANGELOG_SEC_RE)].map((m) => m[1]);
    push("CHANGELOG.md 本版章节", versions.includes(expected) ? expected : (versions[0] ?? null),
      versions.includes(expected) ? undefined : `现有章节：${versions.slice(0, 3).join(" / ")}…`);
  }

  // 产物是可选落点：不存在时不算失败（门禁要在没打包的机器上也能跑）
  const distPkg = "electron-dist/QuAiWei-win32-x64/resources/app/package.json";
  if (fs.existsSync(path.join(root, distPkg))) {
    push("产物 resources/app/package.json", jsonVersion(root, distPkg));
  }

  return { expected, rows, ok: rows.every((r) => r.ok) };
}

/* ------------------------------ CLI ------------------------------ */
function main(): void {
  const args = process.argv.slice(2);
  const i = args.indexOf("--repo");
  const root = i >= 0 ? path.resolve(args[i + 1] ?? ".") : process.cwd();

  let result: VersionCheckResult;
  try {
    result = checkVersionSync(root);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(2);
  }

  console.log("══════════ 版本号一致性检查 ══════════");
  console.log(`期望版本（根 package.json）：${result.expected}\n`);
  for (const r of result.rows) {
    const actual = r.actual === null ? "（读不到）" : r.actual;
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.loc.padEnd(32)} ${actual}${r.note ? `  ← ${r.note}` : ""}`);
  }

  if (result.ok) {
    console.log("\n✅ 全部落点一致（根/electron-app/README 标题/README 下载行/CHANGELOG[/产物]）");
    return;
  }

  const bad = result.rows.filter((r) => !r.ok);
  console.error(`\n❌ ${bad.length} 处版本号与根 package.json（${result.expected}）不一致：`);
  for (const r of bad) console.error(`   · ${r.loc}：现在是 ${r.actual ?? "（读不到）"}，应为 ${result.expected}`);
  console.error("   修法：把这几个落点一起改成 " + result.expected + " —— 它们漏改过三次（v0.9.16/v0.9.18/v0.9.19），别再靠人眼。");
  process.exit(1);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("check-version-sync.ts")) {
  main();
}
