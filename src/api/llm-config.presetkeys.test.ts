/**
 * src/api/llm-config.presetkeys.test.ts — Key 池加载回归（v0.8.7 ESM Bug 锁死）
 * 背景：loadPresetKeys 曾用 new Function("return require")，在 "type":"module" 的
 * ESM 脚本里 require 未定义，被 catch 吞掉 → SENSENOVA_PRESET.keys 恒为空，
 * Node 侧 LLM 通道静默失效。本文件锁死两条加载路径。
 */
import { describe, it, expect } from "vitest";
import { loadPresetKeys, effectiveKeys, type ApiConfig } from "./llm-config";

describe("loadPresetKeys（ESM Key 池回归）", () => {
  it("环境变量 SENSENOVA_KEYS：多 Key 去重、分隔符兼容（env 与文件 Key 合并）", () => {
    const prev = process.env.SENSENOVA_KEYS;
    process.env.SENSENOVA_KEYS = "sk-a,sk-b；sk-a\nsk-c";
    try {
      const keys = loadPresetKeys();
      // env 三个 Key 按序解析在最前，sk-a 去重
      expect(keys.slice(0, 3)).toEqual(["sk-a", "sk-b", "sk-c"]);
      // 全局无重复（env + 文件合并去重语义）
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      if (prev === undefined) delete process.env.SENSENOVA_KEYS;
      else process.env.SENSENOVA_KEYS = prev;
    }
  });

  it("Node 环境下读 scripts/.sensenova-keys 不再静默返回空（ESM require 修复回归）", () => {
    if (typeof process === "undefined" || !process.versions?.node) return; // 仅 Node
    const prev = process.env.SENSENOVA_KEYS;
    delete process.env.SENSENOVA_KEYS; // 隔离 env 路径，专测文件路径
    try {
      const keys = loadPresetKeys();
      // 本仓库开发机存在 scripts/.sensenova-keys；CI 无该文件时允许为空（不误报），
      // 但只要文件在，就绝不允许 0 —— 那正是被修掉的静默失效
      const fs = process.getBuiltinModule("node:fs");
      const path = process.getBuiltinModule("node:path");
      const keyFile = path.resolve(process.cwd(), "scripts/.sensenova-keys");
      if (fs.existsSync(keyFile)) {
        expect(keys.length).toBeGreaterThan(0);
      }
    } finally {
      if (prev !== undefined) process.env.SENSENOVA_KEYS = prev;
    }
  });

  it("effectiveKeys：apiKey 与 apiKeys 合并去重", () => {
    const cfg: ApiConfig = {
      enabled: true,
      baseUrl: "",
      apiKey: "sk-x",
      apiKeys: "sk-x\nsk-y",
      model: "",
      temperature: 1,
      deepMode: false,
      judgeModel: "",
      altModel: "",
      style: "casual",
    };
    expect(effectiveKeys(cfg)).toEqual(["sk-x", "sk-y"]);
  });
});
