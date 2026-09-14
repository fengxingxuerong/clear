/**
 * 追踪 @huggingface/transformers 在 Node 侧实际 require 了哪些顶层包。
 * 用途：判断 onnxruntime-web / @img 等是否可安全剔除，缩小 Electron 打包体积。
 * 用完即删。
 */
const before = new Set(Object.keys(require.cache));

import("@huggingface/transformers")
  .then((m) => {
    const after = Object.keys(require.cache).filter((k) => !before.has(k));
    const tops = new Set();
    for (const p of after) {
      const m = p.match(/node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/);
      if (m) tops.add(m[1].replace(/\\/g, "/"));
    }
    console.log("transformers 导入成功，导出符号数 =", Object.keys(m).length);
    console.log("--- 实际加载的顶层包 ---");
    console.log([...tops].sort().join("\n"));
  })
  .catch((e) => {
    console.error("导入失败:", e.message);
    process.exit(1);
  });
