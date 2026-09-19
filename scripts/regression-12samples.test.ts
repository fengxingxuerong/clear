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
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./regression-12samples";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REAL_LOCK = path.join(SCRIPTS_DIR, "regression-12samples.lock.json");

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
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

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
