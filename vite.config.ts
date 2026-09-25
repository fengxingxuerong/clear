import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 中文/括号等非 ASCII 路径下，Windows 文件系统事件不可靠（HMR 失灵、改了不热更），
// 需要轮询模式兜底（代价是一点 CPU）。纯 ASCII 路径用原生监听更省资源——
// 这里按项目实际路径动态决定，两种场景都拿到最优配置。
const needsPolling = /[^\x00-\x7f]/.test(process.cwd());

// Vitest 会继承外部 NODE_ENV：若机器全局设了 NODE_ENV=production（环境污染很常见），
// React 会被解析成生产构建，@testing-library 的 act() 直接报错。
// 在配置加载期（早于测试模块解析）强制 NODE_ENV=test，npm script / CI / 直接
// npx vitest 三种入口都能覆盖，且不影响正常 vite build（Vite 自己会重设 NODE_ENV）。
if (process.env.VITEST || process.argv.some((a) => a.includes("vitest"))) {
  process.env.NODE_ENV = "test";
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    ...(needsPolling ? { watch: { usePolling: true, interval: 500 } } : {}),
    // SenseNova 网关的 CORS 预检 OPTIONS 返回 404（带对了 Allow-Origin 头也没用），
    // 浏览器直连必挂。dev 下走同源代理：设置里 Base URL 填 /sensenova/v1 即可。
    proxy: {
      "/sensenova": {
        target: "https://token.sensenova.cn",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/sensenova/, ""),
      },
    },
  },
  // 打包后的资源用相对路径，便于 Tauri 与静态托管
  base: "./",
  // emptyOutDir 说明：早期因外部 safe-delete 工具在中文路径下清空 dist 失败而禁用，
  // 导致历史 hash 产物堆积（发布时要手动清）。vite 自身的 fs 清理没有该问题，改回自动清空。
  build: { outDir: "dist", target: "es2020", emptyOutDir: true },
  // Worker 默认按 iife 打包，但 transformers.js 依赖链会触发代码分割（iife 不支持），
  // 改用 ES 格式——ppl-worker 的实例化本就是 { type: "module" }。
  worker: { format: "es" },
  // Vitest 配置
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    exclude: ["node_modules"],
    // 覆盖率 75% 硬门禁（v0.9.16 硬化）：跑 --coverage 时自动断言，低于阈值测试即失败。
    // 七轮测试补盲后的基线：Stmt 89.3 / Branch 82.3 / Func 86.0+ / Lines 90.4——
    // 均远高于阈值；写进配置防止"某次提交悄悄拉低覆盖率"（门禁不再依赖记得手动传参）。
    coverage: {
      thresholds: {
        statements: 75,
        branches: 75,
        functions: 75,
        lines: 75,
      },
    },
  },
});
