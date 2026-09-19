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
 *      ＋ 随包《使用说明.txt》与源文件逐字节一致、产物 package.json 版本与仓库根一致
 *      （见下方 [3] 节：2026-09-19 发现产物里那份文档停在 v0.8.2 并写着已不存在的"内置 3 Key"）
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

/* 4. 随包文档与版本一致性 */
// 起因（2026-09-19）：产物里的《使用说明.txt》停在 **v0.8.2**，比引擎落后 12 个版本，
// 里面还写着"内置 3 Key 轮换"——桌面版从 v0.8.6 起根本不内置任何 Key（loadPresetKeys 只读
// SENSENOVA_KEYS / scripts/.sensenova-keys，两者都不在产物里）。也就是说：**交出去的那份文档
// 在描述一个已不存在的功能**。这类东西不会因为代码改了就跟着自己变，只能查。
// 同理再查一遍版本号：resources/app/package.json 应当与仓库根 package.json 同版本，
// 不一致 = 这个产物是从旧代码树上打出来的。
console.log("\n[3] 随包文档与版本一致性");
const SRC_DOC = path.join(__dirname, "使用说明.txt");
const SHIPPED_DOCS = [path.join(DIST, "使用说明.txt"), path.join(APP, "使用说明.txt")].filter((p) =>
  fs.existsSync(p),
);
if (!fs.existsSync(SRC_DOC)) {
  bad(`源文档不存在：${SRC_DOC}`);
} else if (SHIPPED_DOCS.length === 0) {
  bad("产物里没有随包《使用说明.txt》——用户拿不到任何说明");
} else {
  const src = fs.readFileSync(SRC_DOC);
  for (const p of SHIPPED_DOCS) {
    const rel = path.relative(DIST, p);
    const via = "npm run repack（rebuild-app 会刷新 resources/app 与交付目录根的《使用说明.txt》）";
    Buffer.compare(src, fs.readFileSync(p)) === 0
      ? ok(`与源一致：${rel}`)
      : bad(`落后于源，用户会拿到旧说明。跑 ${via} 才会更新：${rel}`);
  }
}
try {
  const rootV = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
  const appV = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")).version;
  appV === rootV
    ? ok(`版本一致：resources/app/package.json = ${appV}`)
    : bad(`版本不一致：产物 app=${appV} 而仓库根=${rootV} —— 这个产物是旧代码树上打的。` +
        `先 npm run build 再 npm run repack`);
} catch (e) {
  bad(`版本核对失败：${e.message}`);
}

/* 4. 依赖链实测 */
console.log("\n[4] 依赖链实测（按产物绝对路径加载）");
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
    console.log(`结果：❌ ${failed} 项未通过 —— 不要发布。缺文件就恢复，文档/版本落后就按上面的命令重打包。`);
    process.exit(1);
  }
  console.log("结果：✅ 全部通过。依赖链完整，可以发布。");
  console.log("提示：本脚本只验证「模块可加载」与「随包文档/版本一致」，未跑端到端模型推理。");
  console.log("      首次使用 PPL 功能时会下载约 99MB 模型，建议在真机上点一次确认。");
})();
