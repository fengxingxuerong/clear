/**
 * 构建后自动同步 Web 产物到 electron-app/
 * 用法：node scripts/sync-dist.mjs
 * 由 npm run build 与 npm run build:electron 调用（tsc -b → vite build → 本脚本），
 * 保证 dist/ 与 electron-app/ 永远同批产物，不出现版本漂移
 */
import { cpSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src https:; media-src 'self' data:;" />\n    <meta name="viewport"`
  );
  writeFileSync(htmlPath, html, "utf8");
  console.log("✅ CSP meta 已注入 electron-app/index.html");
} else {
  console.log("ℹ️ 源 index.html 已含 CSP，跳过 electron 注入（请确认其 connect-src 覆盖 API 域名）");
}

/* 盖源码指纹章——**必须发生在 build 链里**，不能挪到 repack：
 * 只 repack 不 build 时，如果那时才算指纹，就会把"新源码"的指纹配着"旧 bundle"记进产物，
 * verify-pruned 的新鲜度断言当场失效（2026-09-20 设计时确认过的坑）。 */
try {
  const require2 = createRequire(import.meta.url);
  const { fingerprint } = require2(join(electron, "build-fingerprint.cjs"));
  const fp = fingerprint(root);
  let head = "(非 git 检出或取不到)";
  let dirty = null;
  try {
    const { execSync } = await import("node:child_process");
    head = execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8" }).trim();
    dirty = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim().length > 0;
  } catch {
    /* git 不可用时只靠指纹，不影响盖章 */
  }
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
  console.log(`🔒 源码指纹已盖章：${fp.combined.slice(0, 16)}…（${fp.files} 个文件，HEAD=${head}${dirty ? "，工作区有未提交改动" : ""}）`);
} catch (e) {
  console.error(`❌ 源码指纹盖章失败：${e.message}`);
  console.error("   没有 build-info.json 的产物无法证明来自当前代码树，verify-pruned 会拒绝发布。");
  process.exit(1);
}