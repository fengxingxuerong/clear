/**
 * rebuild-app.cjs —— 绕过 electron-packager 的 app 内容重建
 *
 * 为什么需要它：electron-packager 在本机打包时卡死在拷贝阶段
 * （12:34 建好空的 resources/app 后 18 分钟零进展，非符号链接、非 pnpm 结构问题，
 *   判定为 Windows 大目录拷贝 + 实时防护扫描的开销）。而它要复制的 Electron 运行时
 *   与现有 electron-dist 里的**完全一致**（Chrome/150.0.7871.224，exe 与 icudtl.dat 字节数相同），
 *   所以没必要每次重拷 216MB 运行时——只重建 resources/app 即可。
 *
 * 做法：用 `npm ls --omit=dev --parseable --all` 取真实生产依赖树（自动排除
 * electron / electron-packager 等 devDeps，避免把 348MB 的 electron 拷进去），
 * 再补上 app 顶层文件。onnxruntime-web 直接跳过（已实测主进程不加载它）。
 *
 * 用法：node rebuild-app.cjs [--dist <目录>]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const args = process.argv.slice(2);
const di = args.indexOf("--dist");
const DIST = di >= 0 ? args[di + 1] : path.join(__dirname, "..", "electron-dist", "QuAiWei-win32-x64");
const APP = path.join(DIST, "resources", "app");
const SRC_NM = path.join(__dirname, "node_modules");

/** 跳过项：已实测主进程不加载（见 trace-deps.cjs 的 require.cache 追踪） */
const SKIP_PKGS = [/^onnxruntime-web$/];

/** 拷贝时直接跳过的路径：非 win32 平台二进制（88MB，无谓复制后再删） */
const SKIP_PATH_RE = /[\\/]bin[\\/]napi-v6[\\/](linux|darwin)([\\/]|$)/;

/** app 顶层需要复制的文件/目录（使用说明.txt 属于交付压缩包根目录，不进 app 内部） */
const APP_ENTRIES = ["main.js", "preload.js", "ppl-engine.cjs", "package.json", "index.html", "assets"];

function sizeOf(p) {
  let total = 0;
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (st.isFile()) return st.size;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    total += sizeOf(path.join(p, e.name));
  }
  return total;
}
const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

/* 0. 前置检查 */
if (!fs.existsSync(DIST)) {
  console.error(`✗ 找不到 ${DIST}\n  需要先有一次成功的 electron-packager 产物作为运行时底座。`);
  process.exit(1);
}
for (const f of ["QuAiWei.exe", "icudtl.dat", "resources.pak"]) {
  if (!fs.existsSync(path.join(DIST, f))) {
    console.error(`✗ 运行时文件缺失：${f} —— electron-dist 不完整，需重新跑 electron-packager。`);
    process.exit(1);
  }
}
console.log(`运行时底座：${DIST}`);
console.log(`已有运行时文件校验通过（QuAiWei.exe / icudtl.dat / resources.pak）\n`);

/* 1. 取生产依赖树 */
console.log("[1] 解析生产依赖树（npm ls --omit=dev）");
let lines = [];
try {
  lines = execSync("npm ls --omit=dev --parseable --all", { cwd: __dirname, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
    .split(/\r?\n/).filter(Boolean);
} catch (e) {
  console.error(`✗ npm ls 执行失败：${e.message}`);
  process.exit(1);
}
const pkgs = [];
for (const line of lines) {
  if (!line.toLowerCase().includes("node_modules")) continue; // 根目录行
  const rel = path.relative(SRC_NM, line);
  if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
  const top = rel.split(/[\\/]/)[0];
  if (SKIP_PKGS.some((re) => re.test(top.replace(/^@[^\\/]+[\\/]/, "")))) {
    console.log(`    ⏭  跳过 ${rel}（主进程不加载）`);
    continue;
  }
  pkgs.push(rel);
}
console.log(`    生产依赖 ${pkgs.length} 项（已排除 devDeps 与 onnxruntime-web）`);

/* 2. 重建 resources/app */
console.log("\n[2] 重建 resources/app");
if (fs.existsSync(APP)) {
  // Windows 上杀软/索引服务会瞬时持有刚写过的文件，rmSync 默认不重试会直接 EPERM。
  // 实测同样的目录用 rm -rf 能删掉，说明不是硬占用——加退避重试即可。
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fs.rmSync(APP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      break;
    } catch (e) {
      if (attempt === 5) {
        console.error(`✗ 清空 app 目录失败（已重试 5 次）：${e.message}`);
        console.error("  提示：可能有进程占用该目录，或实时防护正在扫描。可先手动删除后重试。");
        process.exit(1);
      }
      console.log(`    ⚠️  第 ${attempt} 次删除失败（${e.code || e.message}），退避后重试…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    }
  }
  console.log("    已清空旧 app 目录");
}
fs.mkdirSync(path.join(APP, "node_modules"), { recursive: true });

let copied = 0, missing = 0;
for (const rel of pkgs) {
  const src = path.join(SRC_NM, rel);
  const dst = path.join(APP, "node_modules", rel);
  if (!fs.existsSync(src)) { missing++; continue; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, filter: (s) => !SKIP_PATH_RE.test(s) });
  copied++;
}
console.log(`    依赖拷贝完成：${copied} 项${missing ? `（${missing} 项源缺失，已跳过）` : ""}`);

for (const entry of APP_ENTRIES) {
  const src = path.join(__dirname, entry);
  if (!fs.existsSync(src)) { console.log(`    ⚠️  app 条目缺失：${entry}`); continue; }
  fs.cpSync(src, path.join(APP, entry), { recursive: true });
}
console.log(`    app 顶层文件已复制：${APP_ENTRIES.join(" / ")}`);

/* 3. 补齐运行时缺失文件
 * electron-packager 的 --overwrite 会先清空目标目录再重建；它中途卡死时，
 * 运行时文件可能已被删走（实测 locales/ 就是这样丢的）。
 * 从本机 electron dist 补齐，locales 只留 zh-CN / en-US（其余 46MB 无谓）。 */
console.log("\n[3] 运行时文件补齐");
const ELECTRON_DIST = path.join(__dirname, "node_modules", "electron", "dist");
const KEEP_LOCALES = ["zh-CN.pak", "en-US.pak"];
for (const dir of ["locales"]) {
  const srcDir = path.join(ELECTRON_DIST, dir);
  const dstDir = path.join(DIST, dir);
  const existCount = fs.existsSync(dstDir) ? fs.readdirSync(dstDir).length : 0;
  if (existCount > 0) {
    console.log(`    ⏭  ${dir}/ 已存在（${existCount} 项），跳过`);
    continue;
  }
  if (!fs.existsSync(srcDir)) {
    console.log(`    ⚠️  参照源缺失：${srcDir}`);
    continue;
  }
  fs.mkdirSync(dstDir, { recursive: true });
  const keep = dir === "locales" ? KEEP_LOCALES : fs.readdirSync(srcDir);
  for (const k of keep) {
    const s = path.join(srcDir, k);
    if (fs.existsSync(s)) fs.cpSync(s, path.join(dstDir, k));
  }
  console.log(`    ✅ ${dir}/ 已补齐（保留 ${keep.length} 项：${keep.slice(0, 4).join(" / ")}${keep.length > 4 ? " …" : ""}）`);
}

/* 4. 统计 */
console.log("\n[4] 结果");
console.log(`    resources/app 体积：${mb(sizeOf(APP))}`);
console.log(`    整个打包目录体积：${mb(sizeOf(DIST))}`);
console.log("\n下一步：node prune-dist.cjs  →  node verify-pruned.cjs");
