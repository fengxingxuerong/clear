/**
 * src/api/llm-config.presetkeys.test.ts — Key 池加载回归（v0.8.7 ESM Bug 锁死）
 * 背景：loadPresetKeys 曾用 new Function("return require")，在 "type":"module" 的
 * ESM 脚本里 require 未定义，被 catch 吞掉 → SENSENOVA_PRESET.keys 恒为空，
 * Node 侧 LLM 通道静默失效。本文件锁死两条加载路径。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadPresetKeys,
  effectiveKeys,
  hydratePresetKeys,
  SENSENOVA_PRESET,
  type ApiConfig,
} from "./llm-config";

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

/* 2026-10-05 分支补测：loadPresetKeys 的三级回退链（行 107-131）此前从未被走到
   ——本机 Node ≥22.3 一定有 getBuiltinModule，于是 require 兜底与「拿不到模块」
   两条降级路全是死代码。而它们正是 v0.8.7 那次「Key 池恒空、Node 侧 LLM 通道
   静默失效」的事故所在，必须锁住降级语义：宁可少读文件，也不能让 env 路径一起哑掉。 */
/* v0.9.46：桌面端 Key 池异步补齐。
   loadPresetKeys 在浏览器 bundle 里跑不到文件那一支 ⇒ 桌面版 SENSENOVA_PRESET.keys 恒空、
   「填入常驻通道」按钮置灰。hydratePresetKeys 是唯一的修复路径，必须锁住四条语义。 */
describe("hydratePresetKeys（桌面端 IPC 补齐）", () => {
  const g = globalThis as Record<string, unknown>;
  const origPreset = g.preset;
  const hadPreset = "preset" in g;
  // SENSENOVA_PRESET.keys 是模块级共享数组，每个用例后必须还原，否则污染其它断言
  let snapshot: string[] = [];

  function restore(): void {
    SENSENOVA_PRESET.keys.length = 0;
    SENSENOVA_PRESET.keys.push(...snapshot);
    if (hadPreset) g.preset = origPreset;
    else delete g.preset;
  }

  beforeEach(() => {
    snapshot = [...SENSENOVA_PRESET.keys];
  });

  it("无 bridge（Web 版）→ 直接返回现有 Key，不多不少", async () => {
    delete g.preset;
    try {
      const keys = await hydratePresetKeys();
      expect(keys).toEqual(snapshot);
    } finally {
      restore();
    }
  });

  it("bridge 返回多行 Key → 追加并去重，已有条目不被重复添加", async () => {
    g.preset = { keys: async () => "sk-box-a\nsk-box-b；sk-box-a" };
    try {
      const keys = await hydratePresetKeys();
      expect(keys.slice(snapshot.length)).toEqual(["sk-box-a", "sk-box-b"]);
      expect(new Set(keys).size).toBe(keys.length);
      // 幂等：再调用一次不得重复追加
      await hydratePresetKeys();
      expect(SENSENOVA_PRESET.keys.length).toBe(snapshot.length + 2);
    } finally {
      restore();
    }
  });

  it("bridge 抛错 / 返回值非字符串 → 不抛、不清空、原样返回", async () => {
    g.preset = {
      keys: async () => {
        throw new Error("no such file");
      },
    };
    try {
      expect(await hydratePresetKeys()).toEqual(snapshot);
    } finally {
      restore();
    }
    g.preset = { keys: async () => 42 };
    try {
      expect(await hydratePresetKeys()).toEqual(snapshot);
    } finally {
      restore();
    }
  });
});

describe("loadPresetKeys：getBuiltinModule → require → 静默降级", () => {
  type Proc = NodeJS.Process & { getBuiltinModule?: unknown };
  const proc = process as Proc;
  const g = globalThis as Record<string, unknown>;
  const origBuiltin = Object.getOwnPropertyDescriptor(proc, "getBuiltinModule");
  const origRequire = g.require;
  const hadRequire = "require" in g;

  function dropBuiltin(): void {
    delete (proc as unknown as Record<string, unknown>).getBuiltinModule;
    expect(typeof proc.getBuiltinModule, "前置：getBuiltinModule 必须已被摘除").toBe("undefined");
  }
  function restoreAll(): void {
    if (origBuiltin) Object.defineProperty(proc, "getBuiltinModule", origBuiltin);
    if (hadRequire) g.require = origRequire;
    else delete g.require;
  }

  it("无 getBuiltinModule 且无 require（老 Node ESM）→ 走 new Function 分支并静默降级，env 路径照常", () => {
    const prevEnv = process.env.SENSENOVA_KEYS;
    process.env.SENSENOVA_KEYS = "sk-env-1，sk-env-2";
    dropBuiltin();
    delete g.require; // 保证 new Function("return require") 抛错 → 命中 111-113 与 catch
    try {
      // 关键语义：文件读不到，但 env 不能跟着一起哑（v0.8.7 就是整条链一起静默）
      expect(loadPresetKeys()).toEqual(["sk-env-1", "sk-env-2"]);
    } finally {
      restoreAll();
      if (prevEnv === undefined) delete process.env.SENSENOVA_KEYS;
      else process.env.SENSENOVA_KEYS = prevEnv;
    }
  });

  it("无 getBuiltinModule 但有 require → 走 require 兜底；文件不存在则一条不读（行 114-115/126）", () => {
    const prevEnv = process.env.SENSENOVA_KEYS;
    delete process.env.SENSENOVA_KEYS;
    dropBuiltin();
    g.require = (mod: string) =>
      mod === "node:fs"
        ? { existsSync: () => false, readFileSync: () => "" }
        : { resolve: (...parts: string[]) => parts.join("/") };
    try {
      expect(loadPresetKeys()).toEqual([]); // 两个候选路径都 existsSync=false
    } finally {
      restoreAll();
      if (prevEnv === undefined) delete process.env.SENSENOVA_KEYS;
      else process.env.SENSENOVA_KEYS = prevEnv;
    }
  });

  it("require 兜底能真正读到文件 → 与 env 合并去重（行 126/127 真支）", () => {
    const prevEnv = process.env.SENSENOVA_KEYS;
    process.env.SENSENOVA_KEYS = "sk-env,sk-file";
    dropBuiltin();
    g.require = (mod: string) =>
      mod === "node:fs"
        ? { existsSync: () => true, readFileSync: () => "sk-file\nsk-file2" }
        : { resolve: (...parts: string[]) => parts.join("/") };
    try {
      expect(loadPresetKeys()).toEqual(["sk-env", "sk-file", "sk-file2"]);
    } finally {
      restoreAll();
      if (prevEnv === undefined) delete process.env.SENSENOVA_KEYS;
      else process.env.SENSENOVA_KEYS = prevEnv;
    }
  });
});
