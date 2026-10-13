/**
 * coverage.stale-* 清理模块测试
 *
 * 关键断言：
 *  · 只删 `coverage.stale-<纯数字>` **目录**——同名文件、花名目录、其他前缀一律不碰
 *  · 删除通道抛错不向上抛（stale 清不掉 ≠ 门禁失败，这是本模块存在的纪律）
 *  · found/removed 分离：通道自报不算数，以 existsSync 复核为准
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepStaleReports } from "./coverage-stale-sweep.ts";

let tmp: string;

beforeEach(() => {
  // mkdtemp 在系统 temp：名字唯一，刻意不清理（本机并行全量下 rmSync 有
  // ENOTEMPTY/挂住史，见 .workbuddy/memory 2026-10-13）
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-sweep-"));
});

function mkStale(name: string): string {
  const p = path.join(tmp, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe("sweepStaleReports", () => {
  it("无 stale 目录 → found 0，不调 rmdir", () => {
    const calls: string[] = [];
    const r = sweepStaleReports({ parentDir: tmp, rmdir: (p) => calls.push(p) });
    expect(r).toEqual({ found: 0, removed: 0 });
    expect(calls).toEqual([]);
  });

  it("父目录不存在 → found 0，不抛", () => {
    const r = sweepStaleReports({
      parentDir: path.join(tmp, "no-such-dir"),
      rmdir: () => {
        throw new Error("不应被调用");
      },
    });
    expect(r).toEqual({ found: 0, removed: 0 });
  });

  it("精确匹配 coverage.stale-<数字> 目录，其余一律不碰", () => {
    const good1 = mkStale("coverage.stale-1791830615270");
    const good2 = mkStale("coverage.stale-1791832101217");
    mkStale("coverage.stale-abc"); // 非纯数字
    mkStale("coverage.stale-"); // 空 ts
    mkStale("coverage.stale-123.bak"); // 带尾巴
    mkStale("coveragex.stale-123"); // 前缀不同
    fs.writeFileSync(path.join(tmp, "coverage.stale-999"), "x"); // 同名文件
    const calls: string[] = [];
    const r = sweepStaleReports({ parentDir: tmp, rmdir: (p) => calls.push(p) });
    expect(r.found).toBe(2);
    expect(calls.sort()).toEqual([good1, good2].sort());
  });

  it("rmdir 真删（rename 挪走模拟）→ removed 计入", () => {
    const a = mkStale("coverage.stale-1");
    mkStale("coverage.stale-2");
    const r = sweepStaleReports({
      parentDir: tmp,
      rmdir: (p) => fs.renameSync(p, `${p}.gone`),
    });
    expect(r).toEqual({ found: 2, removed: 2 });
    expect(fs.existsSync(a)).toBe(false);
  });

  it("rmdir 抛错 → 不向上抛、removed 0（留给下次启动）", () => {
    mkStale("coverage.stale-1");
    const r = sweepStaleReports({
      parentDir: tmp,
      rmdir: () => {
        throw new Error("SAFE_DELETE_BULK_CONFIRM_REQUIRED");
      },
    });
    expect(r).toEqual({ found: 1, removed: 0 });
  });

  it("rmdir 部分失败 → 成功的计入、失败的留下，整体不抛", () => {
    const a = mkStale("coverage.stale-1");
    const b = mkStale("coverage.stale-2");
    const c = mkStale("coverage.stale-3");
    const r = sweepStaleReports({
      parentDir: tmp,
      rmdir: (p) => {
        if (p === b) throw new Error("busy");
        fs.renameSync(p, `${p}.gone`);
      },
    });
    expect(r.found).toBe(3);
    expect(r.removed).toBe(2);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(true);
    expect(fs.existsSync(c)).toBe(false);
  });

  it("reportsDirName 可覆盖（非默认目录名）", () => {
    const custom = mkStale("mycov.stale-7");
    mkStale("coverage.stale-8"); // 默认名的不该被扫到
    const calls: string[] = [];
    const r = sweepStaleReports({
      parentDir: tmp,
      reportsDirName: "mycov",
      rmdir: (p) => calls.push(p),
    });
    expect(r.found).toBe(1);
    expect(calls).toEqual([custom]);
  });
});

afterEach(() => {
  // 与 beforeEach 对应：刻意不删临时目录（系统 temp、名字唯一、可残留）。
  // vitest 的 afterEach 若在此 rmSync，并行全量下会踩 ENOTEMPTY/挂住（2026-10-13 实测）。
});
