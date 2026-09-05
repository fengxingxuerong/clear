/**
 * src/api/node-keys.ts —— Node-only 的 SenseNova 预置 Key 加载（v0.8.6 安全改造）。
 *
 * 背景：Key 曾明文硬编码在 llm-config.ts，随 git 历史泄露。现改为：
 *   1) 环境变量 SENSENOVA_KEYS（换行/逗号分隔多个）—— 优先，适合 CI / 一次性脚本
 *   2) scripts/.sensenova-keys 本地文件（已 gitignore）—— 适合日常开发
 *   3) 都没有 → 返回空数组，UI「填入 SenseNova 常驻通道」按钮置灰提示手动填写
 *
 * 仅限 Node 入口（tsx 脚本 / Electron 主进程）导入；浏览器侧禁止 import 本文件
 * （vite 会把 node:fs 外部化报错），浏览器构建树里不要出现它。
 */
import { createRequire } from "node:module";
import { parseKeyList } from "./key-parse";

// Node-only 模块（见文件头注释）：浏览器侧禁止 import 本文件
const require0 = createRequire(import.meta.url);

export function loadNodePresetKeys(cwd: string = process.cwd()): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    for (const k of parseKeyList(raw)) if (!out.includes(k)) out.push(k);
  };
  // 1) 环境变量优先
  push(process.env?.SENSENOVA_KEYS);
  // 2) 本地非托管文件
  try {
    // Node-only 模块：顶层静态 import 即可（浏览器侧不得 import 本文件）
    const fs = require0("node:fs") as typeof import("node:fs");
    const path = require0("node:path") as typeof import("node:path");
    const candidates = [
      path.resolve(cwd, "scripts/.sensenova-keys"),
      path.resolve(cwd, "../scripts/.sensenova-keys"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        push(fs.readFileSync(p, "utf-8"));
        break;
      }
    }
  } catch {
    // 无 fs 环境静默降级（理论上 Node 侧不会走到）
  }
  return out;
}
