/**
 * scripts/zhuque-retro-backfill.test.ts —— 回填脚本的映射自证
 * ---------------------------------------------------------
 * 这个文件要防的只有一件事：**id 映射写错，而账本照样绿。**
 *
 * 回填时我把档案里的裸 id（N2 / D1 / H2 …）映射到正本带版本的 id（N2v2 / D0 / H2v2 …），
 * 其中 `D1 → D0` 这类是**推断**出来的（档案里 D1 那块的块头写着"对话体 / 原文"，
 * 而正本管那个点叫 D0）。映射一旦写错：文本会照样归档、哈希照样对得上、
 * audit 照样通过——因为 audit 只验"文件与账本一致"，它不知道哪段文本本该属于哪个点。
 *
 * 所以这里用两条彼此独立的信号去夹它：
 *   ① 官分：档案声明的 pct 必须等于正本该点的 y（能挡住大多数错位）
 *   ② 体裁：档案自己声明的 genre（v2 块头是中文、v3 TSV 是英文枚举）必须等于正本 genre
 * ②存在的意义是①漏得掉的那一类：两个点官分恰好相等时，① 完全无感。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { V2_MAP, V3_MAP, genreMismatch, build, GENRES } from "./zhuque-retro-backfill.ts";
import { readLedger, storeFromOpts, type Store } from "./zhuque-evidence.ts";

describe("genreMismatch（档案声明体裁 vs 正本 genre）", () => {
  it("中文块头声明能对上正本枚举", () => {
    expect(genreMismatch("对话体", "dialogue")).toBe(null);
    expect(genreMismatch("叙事文", "narrative")).toBe(null);
    expect(genreMismatch("纯人写稿(去味对照)", "humanHand")).toBe(null);
    expect(genreMismatch("论说文", "expository")).toBe(null);
  });

  it("v3 TSV 那种已经是英文枚举的写法也要认（第一版只认中文，六个 v3 点全被误拒）", () => {
    for (const g of GENRES) expect(genreMismatch(g, g)).toBe(null);
  });

  it("官分相同但体裁不同——只有这条能拦住，正是它存在的理由", () => {
    // 构造：档案声明 humanHand，却被挂到一个 narrative 的点上；两边官分恰好都是 18
    const msg = genreMismatch("humanHand", "narrative");
    expect(msg).not.toBe(null);
    expect(String(msg)).toMatch(/narrative/);
  });

  it("没声明 / 不认识的声明一律报问题，不静默放过", () => {
    expect(genreMismatch("", "dialogue")).not.toBe(null);
    expect(genreMismatch(undefined, "dialogue")).not.toBe(null);
    expect(genreMismatch("诗歌", "dialogue")).not.toBe(null);
  });
});

describe("真档案的映射：18 个点逐条自证", () => {
  let tmp: string;
  let store: Store;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retro-map-"));
    store = storeFromOpts({ base: tmp });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("dry-run 不写任何文件", () => {
    expect(build(store, true)).toBe(0);
    expect(fs.existsSync(store.ledgerFile)).toBe(false);
  });

  it("dry-run 逐条列出 18 点、没有一条因体裁被拒（= 15 个带声明的点全部自证通过）", () => {
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    let code: number;
    try {
      code = build(store, true);
    } finally {
      console.log = real;
    }
    expect(code).toBe(0);
    expect(lines.filter((l) => l.includes("将回填"))).toHaveLength(18);
    expect(lines.filter((l) => l.includes("体裁对不上"))).toHaveLength(0);
    expect(lines.filter((l) => l.includes("不收"))).toHaveLength(0);
    expect(lines.filter((l) => l.includes("字数不符"))).toHaveLength(0);
  });

  it("落盘后账本 18 条，proof 分级与「文本在不在」严格对应", () => {
    expect(build(store, false)).toBe(0);
    const recs = readLedger(store);
    expect(recs).toHaveLength(18);
    for (const r of recs) {
      if (r.proof === "text+transcript") {
        expect(r.submitChars).toBeGreaterThanOrEqual(350);
        expect(fs.existsSync(path.join(store.base, r.submitFile))).toBe(true);
      } else {
        expect(r.proof).toBe("transcript-only");
        expect(r.submitFile).toBe("");
      }
      // 回填级永远不该带截图
      expect(r.screenshot).toBe("");
    }
    expect(recs.filter((r) => r.proof === "text+transcript")).toHaveLength(10);
    expect(recs.filter((r) => r.proof === "transcript-only")).toHaveLength(8);
  });

  it("故意把一条映射改错 → 当场拒收、退出 1，不会静默归档", () => {
    const saved = V2_MAP.N3;
    try {
      V2_MAP.N3 = "H1"; // 叙事文稿挂到 humanHand 的点上
      expect(build(store, true)).toBe(1);
    } finally {
      V2_MAP.N3 = saved;
    }
    expect(build(store, true)).toBe(0); // 还原后立刻恢复全绿
  });

  /**
   * 体裁检查存在的**唯一理由**：两个点官分恰好相等时，官分那道闸完全无感。
   * v2 档案的 N3 块官分 18，正本 H2v3 的 y 也是 18 —— 把 N3 错挂到 H2v3 上，
   * 官分比对照样通过，只有体裁（叙事文 vs humanHand）能发现。
   * 这条要是不红，就说明体裁检查是装饰。
   */
  it("官分恰好相等的错位映射 → 只有体裁检查拦得住", () => {
    const saved = V2_MAP.N3;
    const lines: string[] = [];
    const real = console.log;
    try {
      V2_MAP.N3 = "H2v3";
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
      expect(build(store, true)).toBe(1);
      const hit = lines.filter((l) => l.includes("体裁对不上"));
      expect(hit.length).toBeGreaterThan(0);
      expect(hit.join("\n")).toMatch(/叙事文/);
      expect(hit.join("\n")).toMatch(/humanHand/);
      // 关键：它不是被官分那道闸拦下的——两边官分都是 18
      expect(lines.filter((l) => l.includes("官分") && l.includes("不符"))).toHaveLength(0);
    } finally {
      console.log = real;
      V2_MAP.N3 = saved;
    }
  });

  it("映射表本身不许出现重复目标（两个档案块抢同一个正本 id 是隐性覆盖）", () => {
    const targets = [...Object.values(V2_MAP), ...Object.values(V3_MAP)];
    expect(new Set(targets).size).toBe(targets.length);
  });
});
