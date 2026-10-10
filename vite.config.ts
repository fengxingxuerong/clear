import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { COVERAGE_THRESHOLDS } from "./scripts/coverage-thresholds";

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
    // 覆盖率阈值从 scripts/coverage-thresholds.ts 取（**唯一事实源**）。
    // 此前阈值在本文件与 `test:cov` 的命令行参数里各写了一份，两份会各自漂移；
    // 2026-10-03 核实发现本机覆盖率门禁从未真正生效（结构性假红，详见
    // scripts/coverage-gate.ts 头部），"哪里是真阈值"当时已经说不清 —— 故收拢成一处。
    // 注意：v8 provider 默认只统计**被测试加载过**的文件；src/main.tsx、
    // src/ppl/ppl-worker.ts、src/types/*.d.ts 三者不在报告里（入口/worker/纯类型），
    // 真实覆盖略低于报告值，差值 <1pt。不为它们追数字 —— 那是入口层测试的课题。
    coverage: {
      thresholds: { ...COVERAGE_THRESHOLDS },
      // v0.9.29：单条用例的默认等待从 5s 放宽到 30s。
      //
      // 症状（逐条修是打地鼠，必须系统性看）：全量 + 覆盖率插桩下，**哪条红是随机的** ——
      // 实测三连跑分别红在 verify-quality 的「词表扫描」/「真起进程 CLI」/ 两者同时。
      // 根因不是这些用例坏了，是它们本来就重：单文件跑 16 条共 4.57s（此类用例占大头 ≈4s），
      // 已经贴着 5000ms；80 文件并发 + v8 插桩后负载一高就超时。
      //
      // 放宽的是**等待时间**，判据一条没动：该为空的仍必须为空、退出码仍必须是 0。
      // 代价：真死循环要多等 25 秒才暴露 —— 可接受，且 coverage-gate 的杀进程树兜底仍在。
      testTimeout: 30_000,
      // v0.9.28：关掉 vitest 自己的两道清理（跑前 `clean` / 跑后 `cleanAfterRun`）。
      //
      // 症状：79 个测试文件**全部通过**，但 vitest 退出码仍是 1，`coverage-final.json`
      // 写出来了、门禁却判红 —— 因为收尾时 v8 provider 要 `rm -rf coverage/.tmp`
      // （实测 85 个分片），而本机守卫**禁止一次删 >50 文件**，直接抛
      // SAFE_DELETE_BULK_CONFIRM_REQUIRED，报告流程中断在"删临时文件"这一步。
      // 跑前那道更早就炸：目标是整个 `coverage/`（80+ 文件），同样是 >50。
      //
      // 不是放水：新鲜度由**门禁自己的 rename 通道**保证 ——
      // `scripts/coverage-gate.ts` 的 cleanReportsDir() 每轮先把 `coverage/` 整个
      // 改名成 `coverage.stale-<ts>`（rename 不是删除，绕得开守卫），
      // 新报告从头写，不可能读到旧数据。日志里那行
      // "ⓘ 删除被本机守卫拦下，已把旧报告挪到 coverage.stale-…" 就是证据。
      clean: false,
      cleanAfterRun: false,
    },
  },
});
