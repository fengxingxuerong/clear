/**
 * multi-roles 通道组装测试
 * ---------------------------------------------------------
 * 该模块是「谁去改写、谁去质检、合议庭几席」的唯一装配点，
 * 且直接读本地 Key 文件（缺 Key 必须静默降级而不是抛错）。
 * 一旦这里回归，表现为「用着用着某个角色突然没人干活」，
 * 从 UI 上看不出根因，所以必须单测锁死。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// 虚拟文件系统：Key 文件是 gitignored 的本地文件，测试里不能碰真盘
const vfs = new Map<string, string>();

vi.mock("fs", () => ({
  readFileSync: (p: string) => {
    const v = vfs.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  },
  existsSync: (p: string) => vfs.has(p),
}));

import { buildRoleEndpoints } from "./multi-roles";

const SENSENOVA_FILE = "scripts/.sensenova-keys";
const ENDPOINTS_LOCAL = "endpoints.local.json";
const ENDPOINTS_PARENT = "../endpoints.local.json";

beforeEach(() => {
  vfs.clear();
  vi.clearAllMocks();
});

describe("buildRoleEndpoints（Key 全缺失）", () => {
  it("三个角色全为 null、合议庭 0 席，且不抛错", () => {
    const r = buildRoleEndpoints();
    expect(r.writer).toBeNull();
    expect(r.altWriter).toBeNull();
    expect(r.qc).toBeNull();
    expect(r.judgeSeats).toEqual([]);
  });
});

describe("buildRoleEndpoints（仅 sensenova）", () => {
  it("写手可用，备份/质检为 null，合议庭 1 席", () => {
    vfs.set(SENSENOVA_FILE, "sk-a\nsk-b\n");
    const r = buildRoleEndpoints();
    expect(r.writer).toEqual({
      baseUrl: "https://token.sensenova.cn/v1",
      keys: ["sk-a", "sk-b"],
      model: "deepseek-v4-flash",
    });
    expect(r.altWriter).toBeNull();
    expect(r.qc).toBeNull();
    expect(r.judgeSeats).toHaveLength(1);
    expect(r.judgeSeats[0].id).toBe("sensenova-ds-pro");
    // 合议庭取池中第一个 Key，不是全部
    expect(r.judgeSeats[0].apiKey).toBe("sk-a");
    expect(r.judgeSeats[0].model).toBe("deepseek-v4-pro");
  });

  it("Key 文件支持换行/逗号/分号混排并去空白", () => {
    vfs.set(SENSENOVA_FILE, "  sk-a , sk-b；sk-c\n\nsk-d  ");
    const r = buildRoleEndpoints();
    expect(r.writer?.keys).toEqual(["sk-a", "sk-b", "sk-c", "sk-d"]);
  });

  it("Key 文件全为空白时视为缺失", () => {
    vfs.set(SENSENOVA_FILE, "\n  \n\t\n");
    const r = buildRoleEndpoints();
    expect(r.writer).toBeNull();
    expect(r.judgeSeats).toEqual([]);
  });
});

describe("buildRoleEndpoints（amd / nvidia）", () => {
  it("amd Key 在则备份写手与质检同时可用（同一网关同型号）", () => {
    vfs.set(ENDPOINTS_LOCAL, JSON.stringify({ amd: "rc-1", nvidia: "" }));
    const r = buildRoleEndpoints();
    expect(r.writer).toBeNull();
    expect(r.altWriter).toEqual({
      baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
      key: "rc-1",
      model: "DeepSeek-V4-Flash",
    });
    expect(r.qc).toEqual(r.altWriter);
    expect(r.judgeSeats.map((s) => s.id)).toEqual(["amd-ds-flash"]);
  });

  it("nvidia 席位 maxTokens 不低于 4000（glm 思考型吃 token）", () => {
    vfs.set(ENDPOINTS_LOCAL, JSON.stringify({ nvidia: "nvapi-1" }));
    const r = buildRoleEndpoints();
    const seat = r.judgeSeats.find((s) => s.id === "nvidia-glm53");
    expect(seat).toBeDefined();
    expect(seat!.maxTokens).toBeGreaterThanOrEqual(4000);
    expect(seat!.model).toBe("z-ai/glm-5.3-flash");
  });

  it("三通道齐全时合议庭 3 席、席位 id 唯一", () => {
    vfs.set(SENSENOVA_FILE, "sk-a");
    vfs.set(ENDPOINTS_LOCAL, JSON.stringify({ amd: "rc-1", nvidia: "nvapi-1" }));
    const r = buildRoleEndpoints();
    expect(r.judgeSeats).toHaveLength(3);
    const ids = r.judgeSeats.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("buildRoleEndpoints（异常降级）", () => {
  it("endpoints.local.json 是坏 JSON 时静默降级，不抛错", () => {
    vfs.set(ENDPOINTS_LOCAL, "{ 这不是 json");
    expect(() => buildRoleEndpoints()).not.toThrow();
    const r = buildRoleEndpoints();
    expect(r.altWriter).toBeNull();
    expect(r.judgeSeats).toEqual([]);
  });

  it("amd/nvidia 为 null 字段时取空串而非字符串 'null'", () => {
    vfs.set(ENDPOINTS_LOCAL, JSON.stringify({ amd: null, nvidia: null }));
    const r = buildRoleEndpoints();
    expect(r.altWriter).toBeNull();
    expect(r.qc).toBeNull();
  });

  it("父目录 endpoints.local.json 作为兜底路径生效", () => {
    vfs.set(ENDPOINTS_PARENT, JSON.stringify({ amd: "rc-parent" }));
    const r = buildRoleEndpoints();
    expect(r.altWriter?.key).toBe("rc-parent");
  });
});
