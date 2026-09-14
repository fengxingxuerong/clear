/**
 * prune-dist.cjs —— Electron 打包产物裁剪（Windows x64）
 *
 * 背景：electron-packager 会把整个 node_modules 拷进 resources/app，
 * 其中包括 runtime 根本不会加载的东西：
 *   · onnxruntime-web  —— 130MB，浏览器版 ORT。主进程走 onnxruntime-node（已实测：
 *                         import("@huggingface/transformers") 后 require.cache 里没有它）
 *   · onnxruntime-node/bin/napi-v6/{linux,darwin} —— 88MB，非 win32 平台二进制
 *   · locales 里除 zh-CN / en-US 外的语言包 —— 约 46MB
 *
 * 本脚本只动「打包产物」，不碰源 node_modules，所以本地 npm start 调试不受影响。
 *
 * 用法：node prune-dist.cjs [--dry-run] [--dist <目录>]
 *   默认目录：../electron-dist/QuAiWei-win32-x64
 *
 * ⚠️ 裁剪后请跑一次依赖自检再发布（在裁剪后的 resources/app 目录下执行）：
 *   node -e "import('@huggingface/transformers').then(m=>console.log('OK',Object.keys(m).length))"
 *   输出 OK 935 即表示 PPL 依赖链在裁剪后仍完整可解析。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const distArgIdx = args.indexOf("--dist");
const DIST = distArgIdx >= 0 ? args[distArgIdx + 1] : path.join(__dirname, "..", "electron-dist", "QuAiWei-win32-x64");
const APP_MODULES = path.join(DIST, "resources", "app", "node_modules");
const LOCALES = path.join(DIST, "locales");

/** 语言包白名单：Electron 会按系统语言加载，其余回退 en-US */
const KEEP_LOCALES = new Set(["zh-CN.pak", "en-US.pak"]);

function sizeOf(p) {
  let total = 0;
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    total += e.isDirectory() ? sizeOf(full) : (() => { try { return fs.statSync(full).size; } catch { return 0; } })();
  }
  return total;
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

/** 待裁剪目标：整目录删除 */
const DROP_DIRS = [
  { p: path.join(APP_MODULES, "onnxruntime-web"), why: "浏览器版 ORT，主进程不加载" },
  { p: path.join(APP_MODULES, "onnxruntime-node", "bin", "napi-v6", "linux"), why: "非 win32 平台二进制" },
  { p: path.join(APP_MODULES, "onnxruntime-node", "bin", "napi-v6", "darwin"), why: "非 win32 平台二进制" },
];

if (!fs.existsSync(DIST)) {
  console.error(`✗ 找不到打包目录：${DIST}\n  先执行 npm run dist 完成打包。`);
  process.exit(1);
}

const before = sizeOf(DIST);
console.log(`裁剪目标：${DIST}`);
console.log(`裁剪前总体积：${mb(before)}${DRY ? "（dry-run，不会真的删）" : ""}`);
console.log("-".repeat(72));

let freed = 0;

console.log("[1] 无用依赖 / 非目标平台二进制");
for (const d of DROP_DIRS) {
  if (!fs.existsSync(d.p)) {
    console.log(`    ⏭  ${path.relative(DIST, d.p)} 不存在，跳过`);
    continue;
  }
  const s = sizeOf(d.p);
  freed += s;
  if (!DRY) fs.rmSync(d.p, { recursive: true, force: true });
  console.log(`    🗑  ${path.relative(DIST, d.p).padEnd(52)} ${mb(s).padStart(9)}  ← ${d.why}`);
}

console.log("\n[2] 语言包（保留 zh-CN / en-US）");
if (fs.existsSync(LOCALES)) {
  let removed = 0;
  for (const f of fs.readdirSync(LOCALES)) {
    if (KEEP_LOCALES.has(f) || !f.endsWith(".pak")) continue;
    const full = path.join(LOCALES, f);
    const s = sizeOf(full);
    freed += s;
    if (!DRY) fs.rmSync(full, { force: true });
    removed++;
  }
  const left = fs.readdirSync(LOCALES).filter((f) => f.endsWith(".pak")).length;
  console.log(`    🗑  移除 ${removed} 个语言包（保留 ${left} 个：${[...KEEP_LOCALES].join(" / ")}）`);
}

const after = DRY ? before - freed : sizeOf(DIST);
console.log("-".repeat(72));
console.log(`裁剪后总体积：${mb(after)}`);
console.log(`共释放：${mb(freed)}（${((freed / before) * 100).toFixed(1)}%）`);
if (DRY) console.log("\n提示：去掉 --dry-run 才会真正删除。");
