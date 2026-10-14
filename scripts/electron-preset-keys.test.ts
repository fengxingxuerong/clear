/**
 * scripts/electron-preset-keys.test.ts — 桌面版 Key 池接线的静态守卫（v0.9.46）
 *
 * 为什么要静态守卫：这条链路横跨四个文件（主进程 → preload → 前端 config → 启动入口），
 * 任何一处改名或漏注册都不会编译报错——表现只是桌面端「填入 SenseNova 常驻通道」
 * 按钮又被置灰，极容易被当成"Key 失效"而误诊。
 * 另一半风险在反面：**明文 Key 一旦误入 Git 或被 ssybyl 打进公开包就不可逆**，
 * 故同时锁住 .gitignore 规则与"源码里不得出现明文 Key"。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ⚠️ 不能用 process.cwd()：本文件可能被 --root 从别的目录调起（vitest 的 cwd 是调用目录），
// 那样 existsSync 全假、报出来的却是「文件不存在」这种完全误导的错误。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const read = (rel: string): string => {
  const abs = path.resolve(ROOT, rel);
  expect(existsSync(abs), `前置：文件必须存在 ${rel}`).toBe(true);
  return readFileSync(abs, "utf8");
};

describe("桌面版 Key 池接线（main → preload → llm-config → 启动入口）", () => {
  const main = read("electron-app/main.js");
  const preload = read("electron-app/preload.js");
  const llmConfig = read("src/api/llm-config.ts");
  const entry = read("src/main.tsx");

  it("主进程注册 preset-keys 通道，且读的是 preset-keys.txt", () => {
    expect(main).toMatch(/ipcMain\.handle\(\s*"preset-keys"/);
    expect(main).toMatch(/preset-keys\.txt/);
  });

  it("preload 把 preset.keys 暴露到渲染层（名字必须与 llm-config 读的一致）", () => {
    expect(preload).toMatch(/exposeInMainWorld\(\s*"preset"/);
    expect(preload).toMatch(/invoke\(\s*"preset-keys"/);
    // llm-config 里的 bridge 名写错（比如写成 presets）会让 Key 静默丢失
    expect(llmConfig).toMatch(/\bpreset\b/);
    expect(llmConfig).toContain("hydratePresetKeys");
  });

  it("启动入口在 adoptSecureApiKeys 之前补齐 Key 池", () => {
    const iHydrate = entry.indexOf("hydratePresetKeys");
    const iAdopt = entry.indexOf("adoptSecureApiKeys");
    expect(iHydrate, "main.tsx 必须调用 hydratePresetKeys").toBeGreaterThan(-1);
    expect(iHydrate).toBeLessThan(
      entry.indexOf("await adoptSecureApiKeys()") > -1
        ? entry.indexOf("await adoptSecureApiKeys()")
        : iAdopt,
    );
  });

  it("读不到文件时降级为空串，不得抛出（公开包形态靠这条保证不崩）", () => {
    // registerPresetKeys 的 handler 必须带 try/catch 兜底：公开包没有 key 文件是常态
    expect(main).toMatch(/preset-keys[\s\S]{0,200}catch/);
  });
});

describe("Key 不得随源码/Git 泄露", () => {
  it(".gitignore 忽略 electron-app/preset-keys.txt", () => {
    expect(read(".gitignore")).toMatch(/electron-app\/preset-keys\.txt/);
  });

  it("主进程/前端源码里没有明文 Key（sk- 开头的真实凭证形态）", () => {
    for (const rel of [
      "electron-app/main.js",
      "electron-app/preload.js",
      "src/main.tsx",
      "src/api/llm-config.ts",
    ]) {
      const src = read(rel);
      expect(src, `${rel} 里不得出现明文 sk- 凭证`).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    }
  });
});
