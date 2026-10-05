/**
 * scripts/regression-12samples.test.ts —— 「这道门禁真的会拦」的自证测试
 * -------------------------------------------------------------------------
 * regression-12samples 长期是红的（A 套件 3/12），红到没人再看它，于是等于没有。
 * 拆成 D（评分器漂移）/ E（引擎退化）两组之后，风险反过来：新写的棘轮如果只会在
 * 基线缺失时红、在真退化时绿，那它比原来更没用。所以这里每一条都**故意造一次退化**
 * 打穿它，而不是只测「今天绿不绿」：
 *   · D 组两个方向（want=low  ceiling 被顶穿 / want=high floor 被跌破）各测一次
 *   · E 组引擎分高于基线要红
 *   · 刻度守卫抬 1 分就要红（证明它不是永真式）
 *   · 锁文件缺失必须红、且**绝不**自动把今天的输出写成明天的真值
 *   · --rebaseline 必须带原因；有真退化时拒绝写锁
 *   · v1 扁平锁只做内存迁移，不回写；首次建线才允许落盘
 *
 * 所有写操作都发生在临时目录，真锁文件 scripts/regression-12samples.lock.json 只读。
 *
 * 补齐的边角（每条都对着一个此前测不到的分支）：
 *   · v2 标定文件读失败 / 条目缺失 → 报错 exit(1)，绝不拿空表或 undefined 继续算
 *   · v1 锁迁移的两个 continue（非 _e2e 键、score 非数字）→ 只迁合法条目且不回写
 *   · D1 刻度守卫两格：人写原文顶穿上限 / AI 原文跌破下限（桩掉评分器，按文本点名）
 *   · --accept-worse 空名单 / --lock 缺路径 / --sep-min 非法 → 用法错 exit 2
 *   · 脚本入口：argv[1] 指向自身时，main() 的返回值经 process.exit 交出去（进程内测）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./regression-12samples";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REAL_LOCK = path.join(SCRIPTS_DIR, "regression-12samples.lock.json");
const V2_JSON = path.join(SCRIPTS_DIR, "calibration-data-v2-genres.json");

/** 刻度守卫要"故意拧坏一格标尺"：按**文本**点名覆盖评分结果，其余文本仍走真评分器。
 *  vi.mock 工厂被提升到文件顶部，桩状态只能经 vi.hoisted 与工厂共享。 */
const scoreStub = vi.hoisted(() => ({ byText: new Map<string, number>() }));

vi.mock("../src/engine/humanize-metrics", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/engine/humanize-metrics")>();
  return {
    ...orig,
    aiScore: (text: string) => {
      const base = orig.aiScore(text);
      const hit = scoreStub.byText.get(text);
      return hit === undefined ? base : { ...base, score: hit };
    },
  };
});

type LockShape = {
  version: number;
  seed: number;
  drift: Record<string, { want: string; score: number }>;
  e2e: Record<string, { score: number; note?: string }>;
  rebaseLog: { at: string; reason: string; changes: string[] }[];
};

function readRealLock(): LockShape {
  return JSON.parse(fs.readFileSync(REAL_LOCK, "utf8")) as LockShape;
}

let tmp: string;
let lock: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg12-"));
  lock = path.join(tmp, "lock.json");
  scoreStub.byText.clear(); // 桩只在点名它的用例里生效，其余一律回落真评分器
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks(); // 用例中途失败也不把 console/process.exit/fs 的桩泄漏给下一条
});

/** 抓住 console 输出：既免得把整张回归表泼进测试报告，也用来断言报错文案 */
function capture() {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation((...a) => lines.push(a.join(" ")));
  return { lines, stop: () => (log.mockRestore(), err.mockRestore(), lines.join("\n")) };
}

type V2Row = { genre: string; level: string; text: string };
/** v2 标定数据里冻结的某一行文本（刻度守卫按文本点名打桩用；读真文件，只读） */
function v2Text(genre: string, level: string): string {
  const rows = JSON.parse(fs.readFileSync(V2_JSON, "utf8")) as V2Row[];
  const row = rows.find((r) => r.genre === genre && r.level === level);
  if (!row) throw new Error(`v2 标定数据里没有 ${genre}|${level}`);
  return row.text;
}

function writeLock(obj: unknown) {
  fs.writeFileSync(lock, JSON.stringify(obj, null, 2), "utf8");
}

/** 把真锁抄一份到临时目录并按需改数字：这样测的是"基线被收紧后会拦"，
 *  而不是靠造一份假锁去猜引擎行为。 */
function lockTweaked(tweak: (l: LockShape) => void): LockShape {
  const l = readRealLock();
  tweak(l);
  writeLock(l);
  return l;
}

describe("regression-12samples：在已提交状态下必须全绿", () => {
  it("默认参数退出码 0（真锁 + 真存档 + 真引擎）", () => {
    expect(main([])).toBe(0);
  });

  it("真锁是 v2 结构且 D/E 两组记录齐全", () => {
    const l = readRealLock();
    expect(l.version).toBe(2);
    expect(Object.keys(l.drift)).toHaveLength(10);
    expect(Object.keys(l.e2e)).toHaveLength(8);
    expect(l.rebaseLog.length).toBeGreaterThanOrEqual(1);
    expect(l.rebaseLog[l.rebaseLog.length - 1].reason.length).toBeGreaterThan(10);
  });
});

describe("regression-12samples：D 组评分器漂移棘轮会拦", () => {
  it("want=low 的存档文本分数顶穿基线上限 → 红", () => {
    // 人写稿 H0 实测 7 分；把上限写成 6，等于要求评分器比现在更宽容 → 必须红
    lockTweaked((l) => {
      l.drift["H0"].score = 6;
    });
    expect(main(["--lock", lock])).toBe(1);
  });

  it("want=high 的 AI 原文跌破基线下限 → 红", () => {
    // 论说文原文实测 43 分；把下限抬到 44，等于假装评分器漏检了也放行 → 必须红
    lockTweaked((l) => {
      l.drift["O1"].score = 44;
    });
    expect(main(["--lock", lock])).toBe(1);
  });

  it("基线比实测更好（有余量）时不红——棘轮只拦坏方向", () => {
    lockTweaked((l) => {
      l.drift["H0"].score = 20; // 上限放宽到 20，实测 7 自然过
      l.drift["O1"].score = 10; // 下限降到 10，实测 43 自然过
    });
    expect(main(["--lock", lock])).toBe(0);
  });
});

describe("regression-12samples：E 组引擎退化棘轮会拦", () => {
  it("当前引擎产物分数高于基线 → 红", () => {
    lockTweaked((l) => {
      l.e2e["N1"].score = 3; // 实测 8，基线写 3 就是在说"上次引擎只有 3 分"
    });
    expect(main(["--lock", lock])).toBe(1);
  });

  it("基线放松到实测之上时不红", () => {
    lockTweaked((l) => {
      l.e2e["N1"].score = 50;
    });
    expect(main(["--lock", lock])).toBe(0);
  });
});

describe("regression-12samples：刻度守卫不是永真式", () => {
  it("--sep-min 抬到实测之上 → 红（HEAD 分离度 26，抬到 27 就该拦）", () => {
    expect(main(["--sep-min", "27"])).toBe(1);
  });

  it("--sep-min 保持在实测之下 → 绿", () => {
    expect(main(["--sep-min", "5"])).toBe(0);
  });
});

describe("regression-12samples：不允许把今天的输出顺手当明天真值", () => {
  it("锁文件缺失 → 红，且不会自动创建锁文件", () => {
    expect(main(["--lock", lock])).toBe(1);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("--rebaseline 不带原因 → 退出码 2（用法错），且不写文件", () => {
    expect(main(["--rebaseline"])).toBe(2);
    expect(main(["--rebaseline", "--lock", lock])).toBe(2);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("存在真退化时 --rebaseline 拒绝写锁", () => {
    const before = lockTweaked((l) => {
      l.drift["H0"].score = 6; // 真退化：人写稿被评得比上限更高
    });
    expect(main(["--rebaseline", "顺手把基线改成今天的样子", "--lock", lock])).toBe(1);
    // 锁内容必须还是被灌进去的那份，没有被"修好"
    expect((JSON.parse(fs.readFileSync(lock, "utf8")) as LockShape).drift["H0"].score).toBe(
      before.drift["H0"].score,
    );
  });

  it("真退化 + --accept-worse 点名吻合 → 放行，且原因里带上是谁被放行", () => {
    const real = readRealLock();
    lockTweaked((l) => {
      l.drift["H0"].score = 6;
    });
    expect(
      main([
        "--rebaseline",
        "修病句的代价，H0 代理分 +1",
        "--accept-worse",
        "H0",
        "--lock",
        lock,
      ]),
    ).toBe(0);
    const l = JSON.parse(fs.readFileSync(lock, "utf8")) as LockShape;
    expect(l.drift["H0"].score).toBe(real.drift["H0"].score); // 回到引擎当前真值
    const last = l.rebaseLog[l.rebaseLog.length - 1];
    expect(last.reason.startsWith("【接受恶化 H0】")).toBe(true);
    expect(last.changes.join("、")).toContain("D/H0:6→");
  });

  it("--accept-worse 点名与实际红灯不吻合 → 仍拒绝且不写锁（不接受整表放行）", () => {
    const before = lockTweaked((l) => {
      l.drift["H0"].score = 6;
    });
    expect(
      main(["--rebaseline", "随便写个原因", "--accept-worse", "O2,O3", "--lock", lock]),
    ).toBe(1);
    const l = JSON.parse(fs.readFileSync(lock, "utf8")) as LockShape;
    expect(l.drift["H0"].score).toBe(before.drift["H0"].score);
    expect(l.rebaseLog).toHaveLength(before.rebaseLog.length); // 没有偷偷追加
  });

  it("--accept-worse 缺名单或没配 --rebaseline → 退出码 2", () => {
    expect(main(["--accept-worse", "--lock", lock])).toBe(2);
    expect(main(["--accept-worse", "H0", "--lock", lock])).toBe(2);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("v1 扁平锁只在内存里迁移，不回写文件", () => {
    const v1 = { N1_e2e: { score: 8, note: "seed=20260826" } };
    writeLock(v1);
    expect(main(["--lock", lock])).toBe(1); // D 组 10 条无基线 → 必红
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toEqual(v1);
  });

  it("首次建线（只有缺记录、无真退化）允许 --rebaseline 落盘，且 rebaseLog 记原因与差值", () => {
    writeLock({ N1_e2e: { score: 8, note: "seed=20260826" } });
    expect(main(["--rebaseline", "首轮建立 D 组基线", "--lock", lock])).toBe(0);
    const l = JSON.parse(fs.readFileSync(lock, "utf8")) as LockShape;
    expect(l.version).toBe(2);
    expect(Object.keys(l.drift)).toHaveLength(10);
    expect(Object.keys(l.e2e)).toHaveLength(8);
    expect(l.rebaseLog).toHaveLength(1);
    expect(l.rebaseLog[0].reason).toBe("首轮建立 D 组基线");
    expect(l.rebaseLog[0].changes.join("、")).toMatch(/D\/N0:∅→\d+/);
  });

  it("再次 --rebaseline 时 rebaseLog 追加而不是覆盖", () => {
    writeLock({});
    expect(main(["--rebaseline", "第一次", "--lock", lock])).toBe(0);
    expect(main(["--rebaseline", "第二次", "--lock", lock])).toBe(0);
    const l = JSON.parse(fs.readFileSync(lock, "utf8")) as LockShape;
    expect(l.rebaseLog.map((e) => e.reason)).toEqual(["第一次", "第二次"]);
  });
});

/* ---------------- v2 标定数据异常：硬失败，不拿脏数据继续算 ---------------- */

describe("regression-12samples：v2 标定数据异常必须硬失败", () => {
  /** process.exit 只记录不真退出：既拿到退出码，又能看它放行后还敢不敢继续跑 */
  const armExit = () => vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

  it("标定文件读失败 → 报错 exit(1)，绝不拿空表继续算（80-82）", () => {
    const orig = fs.readFileSync.bind(fs) as (...args: any[]) => any;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args: any[]) => {
      if (String(args[0]).endsWith("calibration-data-v2-genres.json"))
        throw new Error("EACCES: 拒绝访问");
      return orig(...args);
    });
    const c = capture();
    const exit = armExit();
    // exit 被放行后必须真走到 82 行 return []，随后空表触发"条目缺失"再往下炸 —— 完整链路
    expect(() => main([])).toThrow(TypeError);
    const out = c.stop();
    expect(out).toMatch(/无法加载 v2 标定数据: EACCES/);
    expect(out).toMatch(/v2 JSON 条目缺失/); // 走到这说明 82 行的 return 落了地
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("条目缺失（某档位行不存在）→ 报错 exit(1)，不拿 undefined 往下算（102-103）", () => {
    const orig = fs.readFileSync.bind(fs) as (...args: any[]) => any;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args: any[]) => {
      if (String(args[0]).endsWith("calibration-data-v2-genres.json"))
        return JSON.stringify([{ genre: "narrative", level: "原文", text: "只剩叙事原文一行" }]);
      return orig(...args);
    });
    const c = capture();
    const exit = armExit();
    expect(() => main([])).toThrow(TypeError); // 缺的那条在 N1.text 处先炸，不会静默 undefined 通过
    const out = c.stop();
    expect(out).toMatch(/v2 JSON 条目缺失/);
    expect(out).toMatch(/narrative\|原文/); // 连实际存在的键一起打出来，方便排查
    expect(exit).toHaveBeenCalledWith(1);
  });
});

/* ---------------- v1 锁迁移的两个 continue ---------------- */

describe("regression-12samples：v1 锁迁移只收合法条目", () => {
  it("非 _e2e 键与 score 非数字的脏条目被两个 continue 跳过，只迁合法那条，且不回写（273-274）", () => {
    const v1 = {
      drift_up: { score: 1 }, // 不以 _e2e 结尾 → continue
      N2_e2e: { score: "bad" }, // score 不是数字 → continue
      N1_e2e: { score: 8, note: "seed=20260826" },
    };
    writeLock(v1);
    const c = capture();
    expect(main(["--lock", lock])).toBe(1); // D 组无基线必红，红灯不影响迁移计数
    const out = c.stop();
    expect(out).toMatch(/迁移出 1 条 E2E 记录/); // 两个脏条目没被算进去
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toEqual(v1); // 只在内存迁移，文件原样
  });
});

/* ---------------- D1 刻度守卫：按格拦（桩掉评分器） ---------------- */

describe("regression-12samples：D1 刻度守卫按格拦", () => {
  it("人写原文被抬过人写上限 → 守卫推送失败 → 红（348）", () => {
    scoreStub.byText.set(v2Text("humanHand", "纯人写稿(无处理)"), 90);
    const c = capture();
    expect(main([])).toBe(1);
    const out = c.stop();
    expect(out).toMatch(/人写原文 H0=90 越过人写上限 \d+ → 评分器在误杀真人稿/);
    expect(out).toMatch(/❌ D1 绝对刻度守卫失败/);
  });

  it("AI 原文跌破机器下限 → 守卫按 id 推送失败 → 红（356-358）", () => {
    scoreStub.byText.set(v2Text("narrative", "原文"), 10);
    const c = capture();
    expect(main([])).toBe(1);
    const out = c.stop();
    expect(out).toMatch(/N0 原文=10 低于机器下限 \d+ → 评分器漏检机器稿/);
    expect(out).toMatch(/❌ D1 绝对刻度守卫失败/);
  });
});

/* ---------------- 参数用法错误：exit 2 ---------------- */

describe("regression-12samples：参数用法错误一律 exit 2", () => {
  it("--accept-worse 不给名单（空名单）→ 2，且不写文件（416-418）", () => {
    const c = capture();
    expect(main(["--accept-worse"])).toBe(2);
    expect(c.stop()).toMatch(/--accept-worse 需要点名至少一条 id/);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("--lock 缺路径参数 → 2（429-430）", () => {
    const c = capture();
    expect(main(["--lock"])).toBe(2);
    expect(c.stop()).toMatch(/--lock 需要一个路径参数/);
  });

  it("--sep-min 非法（非数字 / 负数）→ 2（438-439）", () => {
    const c1 = capture();
    expect(main(["--sep-min", "abc"])).toBe(2);
    expect(c1.stop()).toMatch(/--sep-min 需要一个非负数字/);
    const c2 = capture();
    expect(main(["--sep-min", "-3"])).toBe(2);
    expect(c2.stop()).toMatch(/--sep-min 需要一个非负数字/);
  });
});

/* ---------------- 脚本入口：argv[1] 指向自身时经 process.exit 交出返回值 ---------------- */

describe("regression-12samples：入口 process.exit(main())", () => {
  it("全绿时入口把 0 交给 process.exit（进程内跑，覆盖入口行 617）", async () => {
    const realArgv = process.argv;
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new Error(`__exit__${code}`);
    });
    const c = capture();
    process.argv = [realArgv[0], path.join(SCRIPTS_DIR, "regression-12samples.ts")];
    vi.resetModules(); // 让动态 import 重新求值，才会走到入口判断
    try {
      await expect(import("./regression-12samples")).rejects.toThrow("__exit__0");
      expect(exit).toHaveBeenCalledWith(0); // 真锁 + 真引擎 + 真存档 → 0
    } finally {
      process.argv = realArgv;
      exit.mockRestore();
      c.stop();
    }
  });
});
