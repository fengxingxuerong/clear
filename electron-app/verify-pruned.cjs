/**
 * verify-pruned.cjs —— 校验裁剪后的打包产物依赖链是否完整
 *
 * 为什么不能直接在上面跑 `node -e "import(...)"`：Node 的模块解析基于脚本自身位置，
 * 在 electron-app/ 下跑会解析到「源 node_modules」而不是裁剪后的产物目录，
 * 那样等于什么都没验证。这里显式按绝对路径加载产物里的包。
 *
 * 校验内容：
 *   1. @huggingface/transformers 能从产物目录加载
 *   2. 关键导出存在（AutoModel / AutoTokenizer / Tensor）
 *   3. 真正实例化一次 Tensor（触碰 onnxruntime-common 的绑定层）
 *   4. 产物目录里已不存在被裁掉的包（onnxruntime-web / 非 win32 平台二进制）
 *
 * 用法：node verify-pruned.cjs [--dist <目录>]
 * 退出码 0 = 通过，1 = 失败
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { createRequire } = require("module");

const args = process.argv.slice(2);
const di = args.indexOf("--dist");
const DIST = di >= 0 ? args[di + 1] : path.join(__dirname, "..", "electron-dist", "QuAiWei-win32-x64");
const APP = path.join(DIST, "resources", "app");
const NM = path.join(APP, "node_modules");

let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { failed++; console.log(`  ❌ ${m}`); };

console.log(`校验产物：${DIST}\n`);

/* 1. 裁剪结果确认 */
console.log("[1] 裁剪项确认（应当均已不存在）");
const shouldBeGone = [
  path.join(NM, "onnxruntime-web"),
  path.join(NM, "onnxruntime-node", "bin", "napi-v6", "linux"),
  path.join(NM, "onnxruntime-node", "bin", "napi-v6", "darwin"),
];
for (const p of shouldBeGone) {
  fs.existsSync(p) ? bad(`仍存在：${path.relative(DIST, p)}`) : ok(`已移除：${path.relative(DIST, p)}`);
}

/* 2. 必须保留的关键路径 */
console.log("\n[2] 必须保留项");
const mustKeep = [
  path.join(NM, "@huggingface", "transformers"),
  path.join(NM, "onnxruntime-node", "bin", "napi-v6", "win32"),
  path.join(NM, "@img", "sharp-win32-x64"),
  path.join(APP, "main.js"),
  path.join(APP, "preload.js"),
  path.join(APP, "ppl-engine.cjs"),
  path.join(APP, "index.html"),
  path.join(APP, "package.json"),
  path.join(DIST, "locales", "zh-CN.pak"),
  path.join(DIST, "locales", "en-US.pak"),
  path.join(DIST, "QuAiWei.exe"),
  path.join(DIST, "icudtl.dat"),
  path.join(DIST, "resources.pak"),
];
for (const p of mustKeep) {
  fs.existsSync(p) ? ok(`存在：${path.relative(DIST, p)}`) : bad(`缺失：${path.relative(DIST, p)}`);
}

/* 3. 依赖链实测 */
console.log("\n[3] 依赖链实测（按产物绝对路径加载）");
(async () => {
  try {
    // 关键：按 ppl-engine.cjs 的实际方式解析——从产物 app 目录按"包名"解析，
    // 而不是按脚本所在位置（否则会解析到源 node_modules，等于没验证）。
    const req = createRequire(path.join(APP, "_probe.cjs"));
    const resolved = req.resolve("@huggingface/transformers");
    ok(`包名解析成功 → ${path.relative(APP, resolved)}`);

    const mod = await import(pathToFileURL(resolved).href);
    ok(`transformers 加载成功，导出符号 ${Object.keys(mod).length} 个`);

    for (const name of ["AutoModel", "AutoTokenizer", "Tensor", "env"]) {
      typeof mod[name] === "function" || typeof mod[name] === "object"
        ? ok(`导出存在：${name}`)
        : bad(`导出缺失：${name}`);
    }

    // 触碰一次 Tensor 实例化，确认底层张量层可用
    if (typeof mod.Tensor === "function") {
      const t = new mod.Tensor("int64", BigInt64Array.from([1n, 2n, 3n]), [1, 3]);
      const dims = t && t.dims ? Array.from(t.dims).join("x") : "?";
      dims === "1x3" ? ok(`Tensor 实例化正常（dims=${dims}）`) : bad(`Tensor dims 异常：${dims}`);
    }
  } catch (e) {
    bad(`加载失败：${e.message}`);
  }

  console.log("\n" + "-".repeat(60));
  if (failed) {
    console.log(`结果：❌ ${failed} 项未通过 —— 不要发布，先恢复被误删的文件。`);
    process.exit(1);
  }
  console.log("结果：✅ 全部通过。依赖链完整，可以发布。");
  console.log("提示：本脚本只验证「模块可加载」，未跑端到端模型推理。");
  console.log("      首次使用 PPL 功能时会下载约 99MB 模型，建议在真机上点一次确认。");
})();
