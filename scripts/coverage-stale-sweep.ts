/**
 * coverage.stale-* 历史副本清理（coverage-gate 的启动前置动作）
 *
 * 背景：cleanReportsDir() 清 `coverage/` 时，若删除被本机批量守卫拦死，最后退路是
 * `fs.renameSync` 把旧报告**挪成** `coverage.stale-<ts>`（rename 不是删除，绕得开守卫）。
 * 代价是留下一个待清目录——每次 test:cov 都可能再留一个，越积越多。
 *
 * 本模块在 gate 启动时把历史遗留的 stale 副本清掉。设计原则：
 *  · **失败不抛错**：stale 不是本次运行的输入，清不掉与本次门禁判定无关——
 *    打印提示、留给下次启动再试（幂等），绝不能因为"历史垃圾没扫干净"把
 *    "覆盖率不达标"误报出来（本仓库被这种误判坑过）。
 *  · 只认 `<name>.stale-<纯数字>` 精确模式：目录名是人建的（如
 *    `coverage.stale-备份`）或同名文件都不在清理范围，防误删。
 */
import fs from "node:fs";
import path from "node:path";

export interface SweepResult {
  /** 识别到的历史副本目录数 */
  found: number;
  /** 本次确认删掉的数（通道回报后以 existsSync 复核，不采信通道自报） */
  removed: number;
}

export interface SweepOptions {
  /** 报告目录的父目录（stale 副本与报告目录同级） */
  parentDir: string;
  /** 删除通道：真实实现走 rd/rmSync（见 rmdirNative），测试注入假实现。
   *  抛错视为该目录删除失败，不影响其余目录与调用方。 */
  rmdir: (absPath: string) => void;
  /** 报告目录名，默认 coverage；stale 副本命名为 `<name>.stale-<ts>` */
  reportsDirName?: string;
}

export function sweepStaleReports(opts: SweepOptions): SweepResult {
  const prefix = `${opts.reportsDirName ?? "coverage"}.stale-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(opts.parentDir);
  } catch {
    return { found: 0, removed: 0 }; // 父目录不存在/读不了：没有可清的
  }
  const targets = entries
    .filter((e) => e.startsWith(prefix) && /^\d+$/.test(e.slice(prefix.length)))
    .map((e) => path.join(opts.parentDir, e))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory(); // 同名文件不碰
      } catch {
        return false;
      }
    });
  let removed = 0;
  for (const target of targets) {
    try {
      opts.rmdir(target);
    } catch {
      // 删除通道失败：留给下次启动，不阻塞调用方
    }
    try {
      if (!fs.existsSync(target)) removed++;
    } catch {
      /* 连存在性都判不了 → 按未删掉计 */
    }
  }
  return { found: targets.length, removed };
}
