/**
 * 构建后自动同步 Web 产物到 electron-app/
 * 用法：node scripts/sync-dist.mjs
 * 由 npm run build 与 npm run build:electron 调用（tsc -b → vite build → 本脚本），
 * 保证 dist/ 与 electron-app/ 永远同批产物，不出现版本漂移
 */
import { cpSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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