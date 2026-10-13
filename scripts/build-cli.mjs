/**
 * 构建 CLI 单文件产物：scripts/cli.ts → dist-cli/cli.mjs
 *
 * 为什么独立目录（不并进 vite 的 dist/）：
 *   vite 产物是浏览器应用，sync-dist.mjs 会整目录同步进 electron-app/assets；
 *   CLI 是 node 单文件，混进去只会污染 Electron 包。dist-cli/ 自成一统，
 *   package.json 的 bin 字段指向它，npm link / 全局安装后即可用 `ai-humanizer` 命令。
 *
 * 用法：node scripts/build-cli.mjs（由 npm run build:cli 调用）
 */
import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist-cli", "humanize-cli.mjs");

// 干净重建：esbuild 的 outdir 清理只认 outdir 模式，单文件 outfile 不会自动清理，
// 手动删避免 stale 产物被当成新产物分发（本机 repack 已两次栽在"静默留 stale"上）。
rmSync(join(root, "dist-cli"), { recursive: true, force: true });
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [join(root, "scripts", "humanize-cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  // shebang 不能省：npm 在 Linux/macOS 上直接 exec bin 目标，没有这行会 "bad interpreter"
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

console.log(`✅ CLI 产物（humanize-cli）：${outfile}`);
