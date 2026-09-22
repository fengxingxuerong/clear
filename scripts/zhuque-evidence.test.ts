/**
 * scripts/zhuque-evidence.test.ts —— 凭证账本的自证测试
 * ---------------------------------------------------------
 * 账本这套东西如果本身不报错，就等于没有。所以每条审计规则都要"故意造一次假"打穿：
 * 改过原文、换过截图、删过文件、凭证没入库、id 记错行、页面原文与手抄值读反、字数不够、
 * 账本字段本身被手改、坏行、以及 --strict 把历史无凭证升级为硬伤。
 * 全部跑在临时目录（--base 注入），不碰真账本。
 *
 * 注意导入写 `./zhuque-evidence`（无 .ts 后缀）：tsconfig 开了 allowImportingTsExtensions，
 * 带后缀会被 tsc 以 TS5097 直接拒绝，而无后缀 tsc / vite 两边都吃。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  CALIB_IDS,
  audit,
  isHard,
  labelFromPct,
  main,
  parseOpts,
  readLedger,
  isCertified,
  seal,
  sealApi,
  sealRetro,
  storeFromOpts,
  type Evidence,
  type SealInput,
  type SealApiInput,
  type Store,
} from "./zhuque-evidence";
import { ZHUQUE_MIN_CHARS } from "../src/engine/zhuque";

/** 数据集里真实存在的标定点：O1 的官方分 y=85（覆盖率与 y 互证都必须绑死真数据） */
const PID = "O1";
const Y = 85;
/** 够长的"送检原文"，且含「大家」——历史上标尺会把它当错字罚 60 分 */
const LONG = "这是一段用于凭证自测的中文文本，大家一起看看，字数需要超过朱雀的下限才有意义。".repeat(12);
const SHORT = "太短了，不可能通过朱雀。";
/** 页面原文（逐字粘的形态）：档位词 + 百分比 */
const VERDICT = `AI生成 ${Y.toFixed(2)}%`;

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const SHOT = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n"), Buffer.from("fake-screenshot-bytes")]);

let tmp: string;
let store: Store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zqev-"));
  store = storeFromOpts({ base: tmp });
  fs.mkdirSync(path.join(tmp, "in"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "in", `${PID}.txt`), LONG);
  fs.writeFileSync(path.join(tmp, "in", `${PID}.png`), SHOT);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const input = (over: Partial<SealInput> = {}): SealInput => ({
  id: PID,
  submitFile: `in/${PID}.txt`,
  pct: Y,
  verdict: VERDICT,
  label: "ai",
  screenshot: `in/${PID}.png`,
  ...over,
});
const archived = (name: string) => path.join(store.evidenceDir, name);
const hard = () => audit(store).filter((p) => isHard(p, false));
const kinds = (...ks: string[]) => audit(store).filter((p) => ks.includes(p.kind));
/** 手改账本：模拟"凭证被事后编辑"，seal 的当场校验管不到这一路 */
const tamper = (patch: Partial<Evidence>) => {
  const first = fs.readFileSync(store.ledgerFile, "utf8").trim().split(/\r?\n/)[0];
  const rec = JSON.parse(first) as Evidence;
  fs.writeFileSync(store.ledgerFile, JSON.stringify({ ...rec, ...patch }) + "\n");
};

/* ----------------------------- 定档口径 ----------------------------- */

describe("labelFromPct：官方百分比口径，不是内部综合分口径", () => {
  it("≥60 AI / ≥30 疑似 / 否则人工，档位词用官方的 suspected", () => {
    const cases: [number, string][] = [
      [100, "ai"],
      [60, "ai"],
      [59.9, "suspected"],
      [45, "suspected"], // 内部综合分口径会把它判成 ai —— 这里必须不是
      [30, "suspected"],
      [29.9, "human"],
      [20, "human"], // 同上：≥20 是 engine/zhuque.ts 对综合分的阈值
      [0, "human"],
    ];
    for (const [pct, want] of cases) expect(labelFromPct(pct)).toBe(want);
  });
});

/* ----------------------------- seal：正常路径 ----------------------------- */

describe("seal 正常入账", () => {
  it("复制原文与截图进证据目录，哈希对得上，除历史点外零硬伤", () => {
    const { rec, warnings } = seal(input(), store);
    expect(warnings).toEqual([]);
    expect(fs.existsSync(archived(`${PID}.txt`))).toBe(true);
    expect(fs.existsSync(archived(`${PID}.png`))).toBe(true);
    expect(rec.submitSha256).toBe(sha(LONG));
    expect(rec.screenshotSha256).toBe(sha(SHOT));
    expect(hard()).toEqual([]);
    expect(readLedger(store)).toHaveLength(1);
  });

  it("submitChars 按码点去空白计数", () => {
    const { rec } = seal(input(), store);
    expect(rec.submitChars).toBe(Array.from(LONG).length);
    expect(rec.submitChars).toBeGreaterThan(ZHUQUE_MIN_CHARS);
  });

  it("码点计数不受代理对影响（UTF-16 长度会把 emoji 数成 2 个）", () => {
    const withEmoji = "🎉".repeat(ZHUQUE_MIN_CHARS);
    expect(withEmoji.length).toBe(ZHUQUE_MIN_CHARS * 2);
    fs.writeFileSync(path.join(tmp, "in", "emoji.txt"), withEmoji + "   \n");
    const { rec } = seal(input({ id: "Z9", submitFile: "in/emoji.txt" }), store);
    expect(rec.submitChars).toBe(ZHUQUE_MIN_CHARS);
  });

  it("账本路径相对 base 存，克隆到别处也能解析", () => {
    const { rec } = seal(input(), store);
    expect(rec.submitFile).toBe(`evidence/zhuque/${PID}.txt`);
    expect(path.resolve(store.base, rec.submitFile)).toBe(archived(`${PID}.txt`));
  });

  it("重复 seal 同一内容：幂等，多一条记录但不报错", () => {
    seal(input(), store);
    expect(() => seal(input(), store)).not.toThrow();
    expect(readLedger(store)).toHaveLength(2);
    expect(hard()).toEqual([]);
  });
});

/* ----------------------------- seal：当场拒绝 ----------------------------- */

describe("seal 拒绝入账", () => {
  it("pct 越界或非数字", () => {
    for (const bad of [-1, 101, NaN, Number("abc")]) expect(() => seal(input({ pct: bad }), store)).toThrow(/--pct/);
  });

  it("id 会当文件名用，带路径分隔符或空的一律拒绝", () => {
    for (const bad of ["../O5", "a/b", ".hidden", "O5;rm", ""]) {
      expect(() => seal(input({ id: bad }), store)).toThrow(/--id/);
    }
    expect(fs.existsSync(path.join(tmp, "O5.txt"))).toBe(false);
  });

  it("档位词必须是官方那三个（suspect 这类自造词拒收）", () => {
    expect(() => seal(input({ label: "suspect" as SealInput["label"] }), store)).toThrow(/--label/);
    // 换 id 用 Z9：O1 的官分已被标定数据源钉死为 85%，35% 会先撞上 y 互证
    expect(() => seal(input({ id: "Z9", pct: 35, verdict: "疑似AI辅助 35.00%", label: "suspected" }), store)).not.toThrow();
  });

  it("源文件不存在时抛错，不留半条记录也不留孤儿文件", () => {
    expect(() => seal(input({ submitFile: "in/nope.txt" }), store)).toThrow(/不存在/);
    expect(fs.existsSync(store.ledgerFile)).toBe(false);
    expect(fs.existsSync(store.evidenceDir)).toBe(false);
  });

  it("输入路径逃出 base 一律拒绝（否则能把仓库外任意文件抄进已跟踪的 evidence/）", () => {
    expect(() => seal(input({ submitFile: "../outside.txt" }), store)).toThrow(/必须在 --base 之内/);
    const abs = path.resolve(tmp, "..", "abs-outside.txt");
    fs.writeFileSync(abs, LONG);
    expect(() => seal(input({ submitFile: abs }), store)).toThrow(/必须在 --base 之内/);
    fs.rmSync(abs, { force: true });
  });

  it("凭证落点逃出 base 时拒绝（否则账本存成绝对路径，换机器解析不出）", () => {
    const esc = storeFromOpts({ base: tmp, "evidence-dir": "../escape" });
    expect(esc.evidenceDir.startsWith(tmp)).toBe(false);
    expect(() => seal(input(), esc)).toThrow(/逃出了 base/);
  });

  it("同名不同内容的历史凭证不可覆盖，旧字节原样保留", () => {
    seal(input(), store);
    fs.writeFileSync(path.join(tmp, "in", `${PID}.txt`), LONG + "后又加了一句");
    expect(() => seal(input(), store)).toThrow(/不可覆盖历史凭证/);
    expect(fs.readFileSync(archived(`${PID}.txt`), "utf8")).toBe(LONG);
  });

  it("verdict 只抄结论句、没有数字 → 不算凭证，拒收", () => {
    expect(() => seal(input({ verdict: "未发现明显的人工创作特征" }), store)).toThrow(/解析不出百分比或档位/);
    expect(fs.existsSync(store.ledgerFile)).toBe(false);
  });

  it("手抄百分比与页面原文不符 → 拒收（以原文为准）", () => {
    expect(() => seal(input({ pct: 12.4, label: "human", verdict: "AI生成 98.47%" }), store)).toThrow(
      /页面原文是 98\.47%，你记的 --pct 是 12\.4/,
    );
  });

  it("极性读反（页面写 AI生成、人记成 human）→ 当场拒收，这正是 5/5 判人类 那类事故", () => {
    expect(() => seal(input({ pct: Y, label: "human", verdict: VERDICT }), store)).toThrow(
      /页面原文的档位是「AI生成\/AI特征」\(ai\)，你记的 --label 是 human/,
    );
    expect(fs.existsSync(store.ledgerFile)).toBe(false);
  });

  it("与 calibration-data.json 里同 id 的官分不符 → 拒收", () => {
    expect(() => seal(input({ pct: 50, verdict: "AI生成 50.00%" }), store)).toThrow(
      new RegExp(`calibration-data.json 里的官分是 ${Y}%`),
    );
  });
});

/* ----------------------------- seal：提醒 ----------------------------- */

describe("seal 警告（不阻断）", () => {
  it("id 不属于任何标定点 → 提示会在 audit 里算孤儿凭证", () => {
    expect(CALIB_IDS).not.toContain("Z9");
    const { warnings } = seal(input({ id: "Z9" }), store);
    expect(warnings.join("\n")).toMatch(/孤儿凭证/);
  });

  it(`送检不足 ${ZHUQUE_MIN_CHARS} 字 → 入账前就提醒（这官分本身不成立）`, () => {
    fs.writeFileSync(path.join(tmp, "in", "tiny.txt"), SHORT);
    const { warnings } = seal(input({ submitFile: "in/tiny.txt", id: "Z9" }), store);
    expect(warnings.join("\n")).toMatch(/不足 350 字/);
  });
});

/* ----------------------------- audit：逐条规则打穿 ----------------------------- */

describe("audit 造假检测", () => {
  it("干净账本零硬伤（防误报）", () => {
    seal(input(), store);
    expect(hard()).toEqual([]);
  });

  it("送检原文被改过一个字 → hash-mismatch", () => {
    seal(input(), store);
    const before = fs.readFileSync(archived(`${PID}.txt`), "utf8");
    fs.writeFileSync(archived(`${PID}.txt`), before + "事后动了一笔");
    const hit = kinds("hash-mismatch");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(/送检文本内容与凭证不符/);
  });

  it("截图被换掉 → hash-mismatch（截图单独一条，不与原文混淆）", () => {
    seal(input(), store);
    fs.writeFileSync(archived(`${PID}.png`), Buffer.concat([SHOT, Buffer.from("x")]));
    const hit = kinds("hash-mismatch");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(/截图内容与凭证不符/);
  });

  it("凭证文件被删 → file-missing", () => {
    seal(input(), store);
    fs.rmSync(archived(`${PID}.png`));
    const hit = kinds("file-missing");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(/截图已不在/);
  });

  it("凭证指向证据目录外 → outside-store（随仓库分发不了）", () => {
    fs.mkdirSync(path.join(tmp, "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "artifacts", `${PID}.txt`), LONG);
    seal(input(), store);
    tamper({ submitFile: `artifacts/${PID}.txt` });
    const hit = kinds("outside-store");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(/不在证据目录内/);
    expect(kinds("hash-mismatch", "file-missing")).toEqual([]);
  });

  it("极性读反漏进账本（手改 label）→ polarity-conflict", () => {
    seal(input(), store);
    tamper({ label: "human" });
    const hit = kinds("polarity-conflict");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(/页面原文档位是「AI生成\/AI特征」\(ai\)，账本记 human/);
  });

  it("手改 officialPct 而 verdict 不变 → verdict-conflict", () => {
    seal(input(), store);
    tamper({ officialPct: 12.4 });
    expect(kinds("verdict-conflict").map((p) => p.msg).join()).toMatch(/页面原文写 85%，账本记 12\.4%/);
  });

  it("pct 与 verdict 一起改（自洽但与标定数据源的 y 不符）→ dataset-conflict", () => {
    seal(input(), store);
    tamper({ officialPct: 50, verdict: "AI生成 50.00%" });
    const hit = kinds("dataset-conflict");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(/凭证官分 50% 与标定数据源 y=85% 不符/);
    expect(kinds("verdict-conflict", "polarity-conflict")).toEqual([]);
  });

  it("送检不足下限 → short-text", () => {
    fs.writeFileSync(path.join(tmp, "in", "tiny.txt"), SHORT);
    seal(input({ id: "Z9", submitFile: "in/tiny.txt" }), store);
    const hit = kinds("short-text");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(new RegExp(`送检 \\d+ 字 < 朱雀下限 ${ZHUQUE_MIN_CHARS}`));
  });

  it("账本字段 submitChars 被手改大 → 仍按文件真实内容判 short-text", () => {
    fs.writeFileSync(path.join(tmp, "in", "tiny.txt"), SHORT);
    seal(input({ id: "Z9", submitFile: "in/tiny.txt" }), store);
    tamper({ submitChars: 99999 });
    const hit = kinds("short-text");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(new RegExp(`送检 ${Array.from(SHORT).length} 字`));
  });

  it("id 记错行（不在标定集里）→ unknown-id", () => {
    seal(input({ id: "Z9" }), store);
    const hit = kinds("unknown-id");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.id).toBe("Z9");
  });

  it("同一 id 两条矛盾官分 → pct-conflict", () => {
    seal(input(), store);
    const rec = readLedger(store)[0]!;
    fs.appendFileSync(store.ledgerFile, JSON.stringify({ ...rec, officialPct: 84, verdict: "AI生成 84.00%" }) + "\n");
    const hit = kinds("pct-conflict");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(/85 \/ 84/);
  });

  it("坏行（手改语法错 / git 合并冲突标记）只报一条硬伤，不把审计炸掉", () => {
    seal(input(), store);
    fs.appendFileSync(store.ledgerFile, "{ not json\n");
    fs.appendFileSync(store.ledgerFile, '<<<<<<< HEAD\n{"id":"O2v07"}\n=======\n>>>>>>> b\n');
    expect(() => audit(store)).not.toThrow();
    const hit = kinds("bad-line");
    expect(hit.length).toBeGreaterThanOrEqual(2);
    expect(hit.map((p) => p.id).join()).toContain("#2");
  });

  it("缺字段的行也报 bad-line 而不是崩在 undefined", () => {
    fs.mkdirSync(store.evidenceDir, { recursive: true });
    fs.writeFileSync(store.ledgerFile, JSON.stringify({ id: "O1" }) + "\n");
    const hit = kinds("bad-line");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(/缺 id\/submitFile\/screenshot 字段/);
  });

  it("有凭证的标定点退出无凭证名单，其余 17 个仍列软账", () => {
    seal(input(), store);
    const soft = audit(store).filter((p) => !isHard(p, false));
    expect(soft.map((p) => p.id)).toEqual(CALIB_IDS.filter((i) => i !== PID));
    expect(soft[0]?.msg).toMatch(/历史点，仅列账/);
  });

  it("--strict 把无凭证升级为硬伤", () => {
    seal(input(), store);
    expect(audit(store, false).some((p) => !isHard(p, false))).toBe(true);
    expect(audit(store, true).every((p) => isHard(p, true))).toBe(true);
  });

  it("账本为空也不炸", () => {
    expect(readLedger(store)).toEqual([]);
    expect(kinds("hash-mismatch", "file-missing")).toEqual([]);
    expect(hard()).toEqual([]);
  });
});

/* ----------------------------- CLI ----------------------------- */

describe("parseOpts", () => {
  it("裸 --strict 记为开关，不吃掉后面的值", () => {
    const o = parseOpts(["audit", "--strict", "--id", "O1"]);
    expect(o.strict).toBe("1");
    expect(o.id).toBe("O1");
  });
  it("负数是值不是开关（--pct -1 不能变成两个开关）", () => {
    const o = parseOpts(["seal", "--pct", "-1", "--id", "O1"]);
    expect(o.pct).toBe("-1");
    expect(o.id).toBe("O1");
  });
});

describe("main 走真 CLI", () => {
  /** 抓住 stdout/stderr，避免把审计输出泼进测试报告；返回收好的行 */
  const capture = () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
    const err = vi.spyOn(console, "error").mockImplementation((...a) => lines.push(a.join(" ")));
    return { lines, stop: () => (log.mockRestore(), err.mockRestore(), lines.join("\n")) };
  };
  const sealArgv = (over: string[] = []) =>
    ["seal", "--base", tmp, "--id", PID, "--submit-file", `in/${PID}.txt`, "--pct", String(Y),
      "--verdict", VERDICT, "--label", "ai", "--screenshot", `in/${PID}.png`, ...over];

  it("seal 成功即接着审计：无硬伤返回 0", () => {
    const c = capture();
    expect(main(sealArgv())).toBe(0);
    expect(c.lines.join("\n")).toMatch(/凭证分级：认证（截图\/API）1\/18｜/);
    c.stop();
    expect(readLedger(store)).toHaveLength(1);
  });

  it("历史点无凭证：非 strict 放行(0)，strict 拦下(1)", () => {
    const c = capture();
    main(sealArgv());
    expect(main(["audit", "--base", tmp])).toBe(0);
    expect(main(["audit", "--base", tmp, "--strict"])).toBe(1);
    c.stop();
  });

  it("覆盖率只算真标定点，孤儿凭证不算覆盖", () => {
    const c = capture();
    main(sealArgv(["--id", "Z9"]));
    expect(c.lines.join("\n")).toMatch(/凭证分级：认证（截图\/API）0\/18｜/);
    expect(main(["audit", "--base", tmp])).toBe(1); // 孤儿凭证 = 硬伤
    c.stop();
  });

  it("有硬伤时非 strict 也拦下", () => {
    const c = capture();
    main(sealArgv());
    fs.writeFileSync(archived(`${PID}.txt`), LONG + "动过");
    expect(main(["audit", "--base", tmp])).toBe(1);
    expect(main(["audit", "--base", tmp, "--strict"])).toBe(1);
    c.stop();
  });

  it("缺必填参数返回 2 且不写账本", () => {
    const c = capture();
    expect(main(["seal", "--base", tmp, "--id", PID])).toBe(2);
    expect(c.lines.join("\n")).toMatch(/缺少参数：--submit-file --pct --verdict --label --screenshot/);
    c.stop();
    expect(fs.existsSync(store.ledgerFile)).toBe(false);
  });

  it("seal 校验失败返回 2（而不是抛未捕获异常），账本保持干净", () => {
    const c = capture();
    expect(main(sealArgv(["--pct", "12.4"]))).toBe(2);
    expect(c.lines.join("\n")).toMatch(/入账失败/);
    c.stop();
    expect(fs.existsSync(store.ledgerFile)).toBe(false);
  });

  it("未知子命令返回 2", () => {
    const c = capture();
    expect(main(["frobnicate", "--base", tmp])).toBe(2);
    c.stop();
  });

  it("list 只读账本，不改状态", () => {
    seal(input(), store);
    const c = capture();
    expect(main(["list", "--base", tmp, "--id", PID])).toBe(0);
    expect(c.stop()).toMatch(/账本 1 条/);
    expect(readLedger(store)).toHaveLength(1);
  });
});

/* ----------------------------- sealRetro：历史点低强度回填 ----------------------------- */

describe("sealRetro（回填不是认证）", () => {
  const SRC = "scripts/archive/zhuque-calibration-v2.txt:2";

  it("带文本回填 → proof=text+transcript，文本进证据目录且哈希可复核", () => {
    const { rec } = sealRetro({ id: PID, text: LONG, pct: Y, proofSource: SRC }, store);
    expect(rec.proof).toBe("text+transcript");
    expect(rec.screenshot).toBe("");
    expect(rec.submitChars).toBe(LONG.replace(/\s/g, "").length);
    expect(fs.existsSync(path.join(store.base, rec.submitFile))).toBe(true);
    expect(audit(store).filter((x) => ["hash-mismatch","file-missing","proof-mismatch"].includes(x.kind))).toHaveLength(0);
  });

  it(`送检文本不足 ${ZHUQUE_MIN_CHARS} 字 → 当场提醒，不静默入账`, () => {
    const { warnings } = sealRetro({ id: PID, text: SHORT, pct: Y, proofSource: SRC }, store);
    expect(warnings.join("、")).toMatch(/朱雀下限 350/);
  });

  it("没有文本 → proof=transcript-only，且**绝不**因为「回填过」就算认证", () => {
    sealRetro({ id: PID, pct: Y, proofSource: SRC }, store);
    const soft = audit(store).filter((x) => x.kind === "no-evidence");
    expect(soft.length).toBeGreaterThan(0);
    expect(soft.map((x) => x.id)).toContain(PID);
    expect(isCertified(readLedger(store)[0])).toBe(false);
  });

  it("回填不能把发布门禁洗绿：--strict 下未认证一律算硬伤", () => {
    sealRetro({ id: PID, text: LONG, pct: Y, proofSource: SRC }, store);
    const strictProblems = audit(store, true);
    const ids = strictProblems.filter((x) => isHard(x, true)).map((x) => x.id);
    expect(ids).toContain(PID);
  });

  it("出处不写到行号 → 拒绝（否则数字仍然无出处可查）", () => {
    expect(() => sealRetro({ id: PID, text: LONG, pct: Y, proofSource: "某档案" }, store)).toThrow(/文件:行号/);
    expect(() => sealRetro({ id: PID, text: LONG, pct: Y, proofSource: "" }, store)).toThrow(/文件:行号/);
  });

  it("官分与 calibration-data 的 y 不符 → 拒收（两处必须一致）", () => {
    expect(() => sealRetro({ id: PID, text: LONG, pct: 50, proofSource: SRC }, store)).toThrow(/对不上/);
  });

  it("手改成 screenshot 级冒充认证 → proof-mismatch 硬伤", () => {
    sealRetro({ id: PID, text: LONG, pct: Y, proofSource: SRC }, store);
    tamper({ proof: "screenshot" });
    const bad = audit(store).filter((x) => x.kind === "proof-mismatch");
    expect(bad.length).toBeGreaterThan(0);
    expect(isHard(bad[0], false)).toBe(true);
  });
  it("同一条文本重复回填 → 幂等；内容不同 → 拒绝覆盖历史", () => {
    sealRetro({ id: PID, text: LONG, pct: Y, proofSource: SRC }, store);
    expect(() => sealRetro({ id: PID, text: LONG, pct: Y, proofSource: SRC }, store)).not.toThrow();
    expect(() => sealRetro({ id: PID, text: LONG + "多了一段", pct: Y, proofSource: SRC }, store)).toThrow(/不可覆盖/);
  });
});

/* ----------------------------- sealApi：官方 API 响应级凭证 ----------------------------- */

describe("sealApi（官方 API 原始 JSON 入账，与 screenshot 同算认证）", () => {
  /** 造一份与 pct 对齐的假 API 响应：softmax_confidence = pct/100 */
  const writeApi = (pct: number, name = `${PID}.api.json`): string => {
    const raw = {
      softmax_confidence: pct / 100,
      labels_ratio: { "0": 1 - pct / 100, "1": pct / 100, "2": 0 },
      makers_models_usage: { total_tokens: 1234 },
    };
    fs.writeFileSync(path.join(tmp, "in", name), JSON.stringify(raw), "utf8");
    return `in/${name}`;
  };

  const apiInput = (over: Partial<SealApiInput> = {}): SealApiInput => ({
    id: PID,
    submitFile: `in/${PID}.txt`,
    pct: Y,
    label: "ai",
    apiResponse: writeApi(Y),
    ...over,
  });

  it("归档文本与 API JSON，proof=api-response 且算认证，零硬伤", () => {
    const { rec, warnings } = sealApi(apiInput(), store);
    expect(warnings).toEqual([]);
    expect(rec.proof).toBe("api-response");
    expect(isCertified(rec)).toBe(true);
    expect(fs.existsSync(archived(`${PID}.txt`))).toBe(true);
    expect(fs.existsSync(archived(`${PID}.api.json`))).toBe(true);
    expect(rec.apiResponse).toBe(`evidence/zhuque/${PID}.api.json`);
    expect(rec.screenshot).toBe("");
    expect(rec.apiResponseSha256).toBe(
      sha(fs.readFileSync(path.join(tmp, "in", `${PID}.api.json`), "utf8")),
    );
    expect(hard()).toEqual([]);
  });

  it("从 API JSON 复算的分数与手填 pct 不符 → 拒收（以 JSON 为准，不留半条记录）", () => {
    // JSON 里 softmax=0.85（=85），手填 pct=50
    expect(() => sealApi(apiInput({ pct: 50, label: "human" }), store)).toThrow(/复算的分数是 85/);
    expect(fs.existsSync(store.ledgerFile)).toBe(false);
  });

  it("API 重测与历史 y 不符 → 只警告不拦，audit 不报 dataset-conflict", () => {
    const api80 = writeApi(80, "api80.json");
    const { warnings } = sealApi(apiInput({ pct: 80, label: "ai", apiResponse: api80 }), store);
    expect(warnings.join("\n")).toMatch(/API 官分 80% 与标定数据源 y=85% 不符/);
    // api-response 级跳过 dataset-conflict：审计里不该出现这条
    expect(kinds("dataset-conflict")).toEqual([]);
    expect(hard()).toEqual([]);
  });

  it("归档的 API JSON 被换掉 → hash-mismatch", () => {
    sealApi(apiInput(), store);
    fs.writeFileSync(archived(`${PID}.api.json`), JSON.stringify({ softmax_confidence: 0.5 }));
    const hit = kinds("hash-mismatch");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(/API 响应内容与凭证不符/);
  });

  it("手改 officialPct 而 JSON 不变 → 复算不符 verdict-conflict", () => {
    sealApi(apiInput(), store);
    tamper({ officialPct: 12 });
    const hit = kinds("verdict-conflict");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.msg).toMatch(/从 API 响应复算 85%，账本记 12%/);
  });

  it("手把低强度行改成 api-response 冒充认证（但没有 API JSON）→ proof-mismatch 硬伤", () => {
    sealRetro({ id: PID, text: LONG, pct: Y, proofSource: "scripts/archive/zhuque-calibration-v2.txt:2" }, store);
    tamper({ proof: "api-response" });
    const hit = kinds("proof-mismatch");
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]?.msg).toMatch(/proof=api-response 但 apiResponse 为空/);
    expect(isHard(hit[0]!, false)).toBe(true);
  });

  it("路径逃出 base 拒收", () => {
    expect(() => sealApi(apiInput({ apiResponse: "../outside.json" }), store)).toThrow(/必须在 --base 之内/);
  });

  it("幂等：同内容重复 sealApi 不报错（多一条记录）", () => {
    sealApi(apiInput(), store);
    expect(() => sealApi(apiInput(), store)).not.toThrow();
    expect(readLedger(store).filter((e) => e.proof === "api-response")).toHaveLength(2);
    expect(hard()).toEqual([]);
  });

  it("有 api-response 凭证的点退出无凭证名单", () => {
    sealApi(apiInput(), store);
    const soft = audit(store).filter((p) => !isHard(p, false));
    expect(soft.map((p) => p.id)).toEqual(CALIB_IDS.filter((i) => i !== PID));
  });

  it("--strict 下有 api-response 凭证即放行（认证级不再算硬伤）", () => {
    sealApi(apiInput(), store);
    const strictHard = audit(store, true).filter((p) => isHard(p, true) && p.id === PID);
    expect(strictHard).toEqual([]);
  });
});

describe("main sealApi 走真 CLI", () => {
  const capture = () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
    const err = vi.spyOn(console, "error").mockImplementation((...a) => lines.push(a.join(" ")));
    return { lines, stop: () => (log.mockRestore(), err.mockRestore(), lines.join("\n")) };
  };
  const writeApi = (pct: number) => {
    fs.writeFileSync(
      path.join(tmp, "in", `${PID}.api.json`),
      JSON.stringify({ softmax_confidence: pct / 100, makers_models_usage: { total_tokens: 1 } }),
      "utf8",
    );
    return `in/${PID}.api.json`;
  };
  const sealApiArgv = (over: string[] = []) =>
    ["sealApi", "--base", tmp, "--id", PID, "--submit-file", `in/${PID}.txt`, "--pct", String(Y),
      "--label", "ai", "--api-response", writeApi(Y), ...over];

  it("sealApi 成功即接着审计：无硬伤返回 0，认证数 +1", () => {
    const c = capture();
    expect(main(sealApiArgv())).toBe(0);
    expect(c.lines.join("\n")).toMatch(/凭证分级：认证（截图\/API）1\/18｜/);
    c.stop();
    expect(readLedger(store)[0]?.proof).toBe("api-response");
  });

  it("sealApi 复算不符返回 2，账本保持干净", () => {
    const c = capture();
    expect(main(sealApiArgv(["--pct", "12"]))).toBe(2);
    expect(c.lines.join("\n")).toMatch(/入账失败/);
    c.stop();
    expect(fs.existsSync(store.ledgerFile)).toBe(false);
  });

  it("缺必填参数返回 2", () => {
    const c = capture();
    expect(main(["sealApi", "--base", tmp, "--id", PID])).toBe(2);
    expect(c.lines.join("\n")).toMatch(/缺少参数：--submit-file --pct --label --api-response/);
    c.stop();
  });
});
