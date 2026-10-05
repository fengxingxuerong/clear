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
 *
 * 后半部分（第二～五组）再补三类真实故障：官分对不上、账本重复、档案本身缺失/抄漏。
 *
 * ---- 覆盖率上"够不着"的那几处，成因在这里，不去改源码凑数字 ----
 * 本文件把可测的分支基本都走到了；剩下这几条从测试面**结构上够不着**，
 * 它们要么是防御性死代码，要么只在"本文件就是进程入口"时才会发生。列在这里备查：
 *   · 行 107 `(m[2] ?? "")`：正则组 2 是 `(.+?)`，匹配成功时必为非空字符串，
 *     `?? ""` 那一侧永远不触发——纯防御写法。
 *   · 行 118 `if (rec)` 的 else 侧：块头循环（行 93）与回传行循环（行 116）共用同一张
 *     V2_MAP，而回传行里的 id 集合与块头 id 集合完全相同，故 `out.get(...)` 必然命中；
 *     改映射表造不出"只有回传没有块头"的 id。
 *   · 行 151 `c[gi] ?? ""`：gi = header.indexOf("genre")，真 TSV 表头含 genre，c[gi] 恒存在；
 *     要让 gi=-1 只能改 TSV 本身（禁止改档案）。
 *   · 行 266 的 `: ""` 分支：需要 process.argv[1] 为空（无脚本参数启动），测试进程里恒为真。
 *   · 行 267-268 的入口分支：只有本文件作为进程入口才成立（真实 CLI 子进程里会走到，
 *     但 v8 覆盖率不跨进程归因，故行 268 在报告里仍是未覆盖）。
 *     它的行为另由"CLI 入口"那组用真实子进程守住（--dry-run 只读、入口确实跑 build）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { V2_MAP, V3_MAP, genreMismatch, build, GENRES } from "./zhuque-retro-backfill.ts";
import { readLedger, storeFromOpts, type Store } from "./zhuque-evidence.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 抓 build 的全部 console 输出，便于逐条断言（不改全局 console 之外的任何东西） */
function capture(): { lines: string[]; run: (store: Store, dry: boolean) => number } {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  return {
    lines,
    run(store, dry) {
      try {
        return build(store, dry);
      } finally {
        console.log = real;
      }
    },
  };
}

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

/**
 * 第二组守卫（新增）：防**官分那一道闸**和**append-only 幂等**这两件事被摘掉。
 * 第一组只证"体裁/映射对得上时不会误拒"，这里反过来：闸门必须在场。
 */
describe("官分互证与 append-only 幂等", () => {
  let tmp: string;
  let store: Store;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retro-gate-"));
    store = storeFromOpts({ base: tmp });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /**
   * 行 230-233：档案官分与正本 y 不符 → 当场拒收、退出 1。
   * 手法：把 v2 的 N3（叙事文、官分 18）错挂到同为 narrative 的 N2v3（y=15）上。
   * 关键在于**体裁照样对得上**（都是 narrative），所以体裁闸完全无感——
   * 能拦下它的只有官分那道 `pct !== p.y`。
   * 对照：把映射还原后，同一个 store 再跑立刻回到全绿（证明红确实来自这一条改动）。
   */
  it("官分与正本 y 不符 → 拒收（体裁对得上也拦得住，只有官分这道闸起作用）", () => {
    const saved = V2_MAP.N3;
    const cap = capture();
    let code: number;
    try {
      V2_MAP.N3 = "N2v3"; // 叙事文稿（官分 18）挂到同为叙事的 N2v3（y=15）
      code = cap.run(store, true);
    } finally {
      V2_MAP.N3 = saved;
    }
    expect(code).toBe(1);
    const pctRej = cap.lines.filter((l) => l.includes("官分") && l.includes("不符"));
    // 关键对照：这条拒收**不是**体裁闸发的（体裁对得上）
    expect(cap.lines.filter((l) => l.includes("体裁对不上"))).toHaveLength(0);
    expect(pctRej).toHaveLength(1);
    expect(pctRej[0]).toContain("N2v3");
    expect(pctRej[0]).toMatch(/档案官分 18 与正本 y=15 不符/);
    // 源点 N3v2 因为被挪走而查无出处，也必须如实报出来（不许静默少一条）
    expect(cap.lines.filter((l) => l.includes("N3v2") && l.includes("三处档案里都没有"))).toHaveLength(1);
    // 还原后同一 store 立刻恢复全绿（防"这条守卫其实没在动代码"）
    const cap2 = capture();
    expect(cap2.run(store, true)).toBe(0);
  });

  /**
   * 行 180（readLedger 的 `.map` 回调）+ 行 235-238（have.has 跳过）：
   * 账本里已有记录 → 幂等跳过，不追加第二条（账本 append-only，重复跑不得造重）。
   * 对照：第一次跑落 18 条；第二次跑必须 18 条全跳过、账本条数不变、退出 0。
   */
  it("账本已有记录 → 幂等跳过，重复跑不追加第二条", () => {
    expect(build(store, false)).toBe(0);
    const first = readLedger(store);
    expect(first).toHaveLength(18);

    const cap = capture();
    expect(cap.run(store, false)).toBe(0);
    const skips = cap.lines.filter((l) => l.includes("账本已有记录"));
    expect(skips).toHaveLength(18);
    expect(skips.join("\n")).toMatch(/append-only/);
    // 第二次跑没有新增任何一条、也没有再落任何文本文件
    const second = readLedger(store);
    expect(second).toHaveLength(18);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect(cap.lines.filter((l) => l.includes("✅"))).toHaveLength(0);
  });
});

/**
 * 第三组守卫（新增）：防 `V2_MAP[x] ?? x` 这种**兜底透传**被悄悄摘掉或写死。
 * 生产代码里 `V2_MAP[m[1]] ?? m[1]` 的含义是："档案里出现映射表没登记过的裸 id 时，
 * 原样当正本 id 用，而不是当成致命错误"。`??` 那一侧一旦被换成 `||`+报错、或被删成
 * `V2_MAP[m[1]]`，未登记的 id 会静默变成 `undefined`，点就会被 `out.get(undefined)` 漏掉。
 * 这里靠**删掉映射表里的一条**把"未登记"这个状态真实造出来，证明兜底那侧真的会被走到。
 */
describe("映射表兜底：未登记的裸 id 原样透传，不静默变 undefined", () => {
  let tmp: string;
  let store: Store;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retro-fallback-"));
    store = storeFromOpts({ base: tmp });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /**
   * 行 93 与行 116：删掉 V2_MAP.N1 后，v2 档案块头与回传行两处的 `?? m[1]` 都要走兜底。
   * 因为 N1 在 V2_MAP 里本来就是恒等映射（"N1" → "N1"），删掉它**不改变任何结果**——
   * 所以这是一条纯兜底守卫：若 `??` 那一侧被摘成 `V2_MAP[m[1]]`，N1 会变成 undefined，
   * 归档条数立刻从 18 掉到 17（O 系列之外少一条），下面 `18 条` 的断言就会红。
   */
  it("V2 兜底：删掉恒等映射 N1 仍然回填满 18 点（证明 ?? 那一侧真的走到了）", () => {
    const saved = V2_MAP.N1;
    const cap = capture();
    let code: number;
    try {
      delete V2_MAP.N1;
      code = cap.run(store, false);
    } finally {
      V2_MAP.N1 = saved;
    }
    expect(code).toBe(0);
    expect(cap.lines.filter((l) => l.includes("不收") || l.includes("三处档案里都没有"))).toHaveLength(0);
    const recs = readLedger(store);
    expect(recs).toHaveLength(18);
    // 兜底后 N1 仍拿到它自己的那一条：pct/text 都对得上，不是靠"碰巧没被检查"
    const n1 = recs.find((r) => r.id === "N1");
    expect(n1).toBeDefined();
    expect(n1!.officialPct).toBe(99);
    expect(n1!.proof).toBe("text+transcript");
    // 对照：映射还原后行为完全一致（证明这条测的是兜底，不是别的副作用）
    const cap2 = capture();
    const tmp2 = storeFromOpts({ base: fs.mkdtempSync(path.join(os.tmpdir(), "retro-fallback-ctl-")) });
    expect(cap2.run(tmp2, false)).toBe(0);
    expect(readLedger(tmp2)).toHaveLength(18);
  });

  /**
   * 行 146：`V3_MAP[c[0]] ?? c[0]` 的兜底侧。v3 TSV 里每一行都是登记过的 id，
   * 删掉 O2 的映射就造出了"TSV 里有、映射表里没有"这个真实状态。
   *
   * 这条同时钉住一个**更重要的不变量**：兜底之后 v3 档案被记成了裸 id "O2"，
   * 而正本那个点叫 O2v3——于是这个点三处档案都查不到，**必须被如实拒收**。
   * 反过来看：如果兜底侧不存在、或者 out.get 的结果被忽略，O2v3 就会被静默跳过、
   * 账本少一条而退出码还是 0——那正是"少收一个点却没人发现"。
   */
  it("V3 兜底：删掉 O2 映射 → 该点当场拒收，不静默少收（退出码必须是 1）", () => {
    const saved = V3_MAP.O2;
    const cap = capture();
    let code: number;
    try {
      delete V3_MAP.O2;
      code = cap.run(store, true);
    } finally {
      V3_MAP.O2 = saved;
    }
    expect(code).toBe(1);
    const orphan = cap.lines.filter((l) => l.includes("O2v3") && l.includes("三处档案里都没有"));
    expect(orphan).toHaveLength(1);
    // 其余 17 点照旧入账——拒收是点粒度的，不是整批崩掉
    expect(cap.lines.filter((l) => l.includes("将回填"))).toHaveLength(17);
    // 对照：映射还原 → 立刻恢复 18/0
    const cap2 = capture();
    expect(cap2.run(store, true)).toBe(0);
    expect(cap2.lines.filter((l) => l.includes("将回填"))).toHaveLength(18);
  });
});

/**
 * 第四组守卫（新增）：CLI 入口那一层。
 * 上面所有用例都是 `import { build }` 直接调函数，模块底部的
 * `if (entry === import.meta.url) process.exit(build(..., --dry-run))` 一次都不会走到。
 * 那层要是被改坏（比如 `--dry-run` 不再传下去、或者入口整个删掉），import 路径的测试**全绿**，
 * 只有真正命令行跑的时候才发现"它不管 dry-run、直接往账本里写"。
 * 所以这里用一次真实的子进程跑 CLI，钉住"入口确实执行了 build、且 --dry-run 真的只读"。
 */
describe("CLI 入口：--dry-run 走只读、不往账本追加", () => {
  it("以真实子进程跑 CLI → 入口执行 build、--dry-run 生效（只读）", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const ledger = path.join(repoRoot, "evidence", "zhuque", "ledger.jsonl");
    const before = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : null;
    const r = spawnSync(
      process.execPath,
      [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repoRoot, "scripts", "zhuque-retro-backfill.ts"), "--dry-run"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    // 入口跑到了 build：合计行必然出现，且带 dry-run 标记
    expect(out).toMatch(/合计 18 点/);
    expect(out).toContain("dry-run，未落盘");
    // --dry-run 的语义：不得打印"非 dry 才会打印"的那段提醒，也不得动账本
    expect(out).not.toContain("注意：回填只补到 L1/L2");
    const after = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : null;
    expect(after).toBe(before);
  }, 60000);
});

/**
 * 第五组守卫（新增）：档案**缺失/抄漏**这两种现实故障。
 *
 * `parseV2` / `parseV07` 在每次 `build` 里现读仓库里的档案文件，读到的东西决定归档结果。
 * 两种故障在这套真实档案上永远不会自然发生（仓库里的档案是自洽的），所以这里在
 * `fs` 的读取入口上做**一次性内存改写**把故障造出来——不改任何仓库文件，改完立刻还原：
 *   ① 字数对不上（抄漏/改写）→ 该点拒收，"先查是谁抄漏了"
 *   ② O1 的原文单独档缺失 → 该点从 text+transcript 降级成 transcript-only，并显式告警
 *
 * 手法上这两处只拦 `node:fs` 上那一个方法名、只认本脚本自己的档案文件名，其余读写一律放行，
 * 因此不会影响账本解析、临时目录落盘或别的用例；finally 里恢复原函数。
 */
describe("档案故障：字数对不上 / O1 原文档缺失", () => {
  let tmp: string;
  let store: Store;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retro-fault-"));
    store = storeFromOpts({ base: tmp });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("v2 档案字数与正文不符 → 该点拒收、退出 1，并点名是抄漏", () => {
    const real = fs.readFileSync;
    const cap = capture();
    let code: number;
    let bumps = 0;
    try {
      // 把档案里每处「字数=N」抬高 5 字 ⇒ 正文实际字数与档案记录对不上
      fs.readFileSync = function (this: unknown, p: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) {
        const s = typeof p === "string" ? p : (p as { toString?: () => string })?.toString?.();
        const passthrough = () =>
          real.apply(fs, [p as never, ...rest] as unknown as Parameters<typeof fs.readFileSync>);
        if (s && s.endsWith("zhuque-manual-inputs-v2-genres.txt")) {
          bumps++;
          const txt = String(passthrough());
          return txt.replace(/字数=(\d+)/g, (_m, d: string) => {
            bumps++;
            return `字数=${Number(d) + 5}`;
          });
        }
        return passthrough();
      } as typeof fs.readFileSync;
      code = cap.run(store, true);
    } finally {
      fs.readFileSync = real;
    }
    // 九个 v2 点全部字数不符、全部拒收（这就是"抄漏"的真实形态）
    expect(bumps).toBeGreaterThan(0);
    expect(code).toBe(1);
    const rej = cap.lines.filter((l) => l.includes("字数不符"));
    expect(rej).toHaveLength(9);
    expect(rej.join("\n")).toMatch(/不收，先查是谁抄漏了/);
    // 一个都没落盘
    expect(fs.existsSync(store.ledgerFile)).toBe(false);
    // 对照：不改档案就全绿（证明红确实来自字数不一致这一条改动）
    const cap2 = capture();
    expect(cap2.run(store, true)).toBe(0);
    expect(cap2.lines.filter((l) => l.includes("字数不符"))).toHaveLength(0);
  });

  it("O1 原文档缺失 → 降级为 transcript-only，并显式告警只有 L2", () => {
    const real = fs.existsSync;
    const cap = capture();
    let code: number;
    let hidden = 0;
    try {
      // 假装 scripts/archive/EXPO_O1_RAW.txt 不存在
      fs.existsSync = function (this: unknown, p: Parameters<typeof fs.existsSync>[0]) {
        const s = typeof p === "string" ? p : (p as { toString?: () => string })?.toString?.();
        if (s && s.endsWith("EXPO_O1_RAW.txt")) {
          hidden++;
          return false;
        }
        return real.call(fs, p);
      } as typeof fs.existsSync;
      code = cap.run(store, false);
    } finally {
      fs.existsSync = real;
    }
    expect(hidden).toBeGreaterThan(0);
    expect(code).toBe(0); // 降级不等于拒收：官分出处仍在，账还是要记
    const recs = readLedger(store);
    expect(recs).toHaveLength(18);
    const o1 = recs.find((r) => r.id === "O1");
    expect(o1!.proof).toBe("transcript-only");
    expect(o1!.submitFile).toBe("");
    expect(o1!.submitChars).toBe(0);
    // 告警必须说清楚"这条只有 L2、没有 L1"，不是静默降级
    expect(cap.lines.filter((l) => l.includes("O1:") && l.includes("只有 L2"))).toHaveLength(1);
    // 对照：O1 原文档在时它是 text+transcript（缺失才降级）
    const cap2 = capture();
    const tmp2 = storeFromOpts({ base: fs.mkdtempSync(path.join(os.tmpdir(), "retro-fault-ctl-")) });
    expect(cap2.run(tmp2, false)).toBe(0);
    const o1ctl = readLedger(tmp2).find((r) => r.id === "O1");
    expect(o1ctl!.proof).toBe("text+transcript");
  });
});
