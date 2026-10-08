/**
 * 构建后自动同步 Web 产物到 electron-app/
 * 用法：node scripts/sync-dist.mjs
 * 由 npm run build 与 npm run build:electron 调用（tsc -b → vite build → 本脚本），
 * 保证 dist/ 与 electron-app/ 永远同批产物，不出现版本漂移
 */
import {
  cpSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readGitState, dirtyBuildAllowed } from "./build-stamp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
const electron = join(root, "electron-app");
const assetsDir = join(electron, "assets");

if (!existsSync(dist)) {
  console.error("❌ dist/ 不存在，请先运行 npm run build");
  process.exit(1);
}

// 清理 electron-app/assets 里的陈旧 hash 产物（vite 每次构建会换文件名），
// 避免老版本 JS/CSS 堆积。main.js / package.json 不受影响。
if (existsSync(assetsDir)) {
  for (const f of readdirSync(assetsDir)) {
    const p = join(assetsDir, f);
    if (statSync(p).isFile()) rmSync(p, { force: true });
  }
  console.log("🧹 electron-app/assets/ 陈旧产物已清理");
}

// 复制 dist 到 electron-app（覆盖 index.html 和 assets/）
cpSync(dist, electron, { recursive: true, force: true });
console.log("✅ dist/ → electron-app/ 同步完成");

// 注入 CSP meta（如果新构建的 index.html 没有 CSP）
const htmlPath = join(electron, "index.html");
let html = readFileSync(htmlPath, "utf8");
if (!html.includes("Content-Security-Policy")) {
  html = html.replace(
    '<meta name="viewport"',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src https:; media-src 'self' data:;" />\n    <meta name="viewport"`,
  );
  writeFileSync(htmlPath, html, "utf8");
  console.log("✅ CSP meta 已注入 electron-app/index.html");
} else {
  console.log(
    "ℹ️ 源 index.html 已含 CSP，跳过 electron 注入（请确认其 connect-src 覆盖 API 域名）",
  );
}

/* 盖源码指纹章——**必须发生在 build 链里**，不能挪到 repack：
 * 只 repack 不 build 时，如果那时才算指纹，就会把"新源码"的指纹配着"旧 bundle"记进产物，
 * verify-pruned 的新鲜度断言当场失效（2026-09-20 设计时确认过的坑）。 */
try {
  const require2 = createRequire(import.meta.url);
  const { fingerprint } = require2(join(electron, "build-fingerprint.cjs"));
  const fp = fingerprint(root);
  // 判定逻辑住在 build-stamp.mjs（纯函数、可单测），这里只负责「用」它
  // readGitState 是异步的（见 build-stamp.mjs：同步 spawn 在部分环境会被整体挡下）
  const gitState = await readGitState(root);
  const head = gitState.head;
  const dirty = gitState.dirty;
  const dirtyFiles = gitState.files;
  /** 逃生口：显式声明"我知道这是脏产物，我只是要先发一版" */
  const allowDirty = dirtyBuildAllowed();
  const info = {
    builtAt: new Date().toISOString(),
    head,
    /** true = 打包时工作区有未提交改动，产物不对应任何一次提交 */
    dirty,
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    fingerprintFiles: fp.files,
    combined: fp.combined,
    groups: fp.groups,
  };
  writeFileSync(join(electron, "build-info.json"), JSON.stringify(info, null, 2) + "\n", "utf8");
  writeFileSync(join(dist, "build-info.json"), JSON.stringify(info, null, 2) + "\n", "utf8");
  console.log(
    `🔒 源码指纹已盖章：${fp.combined.slice(0, 16)}…（${fp.files} 个文件，HEAD=${head}${dirty ? "，工作区有未提交改动" : ""}）`,
  );

  /* ── dirty 硬失败（2026-10-05 新增） ──────────────────────────────
   *
   * 起因是实测出的真实缺口：dirty 此前只打印一行警告就放过，于是
   * 「产物里带着不属于任何提交的代码」这件事可以静默发生。
   * 更糟的是它和 verify-pruned 的关系是反的——verify 会在 [4] 节
   * 报「盖章时工作区有未提交改动」，但那只是**事后**提醒：
   * 等你想到去跑 verify 时，脏产物早就躺在 electron-dist/ 里了。
   *
   * 为什么现在硬失败而以前不失败：dirty 判定的是**进产物的那些文件**
   * （src / 前端入口 / 主进程脚本 / 随包文档）。这些文件有未提交改动时，
   * 产物的行为与仓库里任何一个提交都对不上——它既不能复现，也不能追溯。
   * 那种「先 build 看看效果，回头再提交」的开发节奏，在 dev 阶段有 vite HMR 兜着，
   * 不需要靠产物来试；一旦走到打包这一步，就该先把改动落成提交。
   *
   * 逃生口：确需在脏工作区打包（比如就是要发给同事看一版），
   * 设 QUAIWEI_ALLOW_DIRTY_BUILD=1 显式声明，章里照样记 dirty=true。
   */
  if (dirty && !allowDirty) {
    console.error("");
    console.error("❌ 源码指纹盖章失败：工作区有未提交改动，产物不对应任何一次提交。");
    console.error("   这份产物既不能复现也不能追溯，发出去等于给了一版无法追责的代码。");
    console.error("");
    console.error("   处理方式二选一：");
    console.error("     · 正常做法：先 git add + commit，再 npm run build");
    console.error("     · 确需先发一版给同事看：");
    console.error("         $env:QUAIWEI_ALLOW_DIRTY_BUILD=1; npm run build");
    console.error("       （章里仍会记 dirty=true，verify-pruned 也会提示「别拿去发布」）");
    console.error("");
    console.error("   当前未提交的改动：");
    for (const l of dirtyFiles) console.error(`     ${l}`);
    process.exit(1);
  }
  if (dirty && allowDirty) {
    console.warn(
      "⚠️  QUAIWEI_ALLOW_DIRTY_BUILD=1：已放行脏产物。章里记 dirty=true，verify-pruned 会提示别发布。",
    );
  }
} catch (e) {
  console.error(`❌ 源码指纹盖章失败：${e.message}`);
  console.error("   没有 build-info.json 的产物无法证明来自当前代码树，verify-pruned 会拒绝发布。");
  process.exit(1);
}
