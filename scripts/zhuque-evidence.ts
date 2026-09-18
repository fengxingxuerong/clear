/**
 * scripts/zhuque-evidence.ts —— 官方送检凭证账本 + 审计
 * ---------------------------------------------------------
 * 为什么需要它：2026-09-19 的发布审计发现，标定数据源里 18 个"官方送检点"**一个凭证都没有**
 * ——没有页面截图、没有时间戳、没有当时送检的原文，只有一个人工抄进去的百分比。后果已经
 * 发生过：`5/5 判人类` 那条结论的引文「未发现明显的人工创作特征」在仓库内被反向解释过两次
 * （一处当 98.47%「疑似 AI」，另一处要求"人工特征较强"才算人类），极性很可能一开始就读反了，
 * 而没有任何东西能发现这件事。分数无法自证，标定线就只能靠信仰维护。
 *
 * 关键设计：**页面原文是独立于抄录人的那一路证据**。只把 --pct 和 --label 分别存下来，
 * 两者同源于同一次手抄，一起抄反就永远自洽、永远查不出来。所以 seal 当场用
 * `parseOfficialResult` 解析 verdict（官方那行原文），解析出的百分比/档位与手填值不符即拒绝入账；
 * audit 再解析一次，防的是账本被手改之后的状态。
 *
 * 凭证必须**入库**才叫凭证：送检原文历史上放在 `scripts/zhuque-v4-out/`、截图放在
 * `artifacts/`，两者都被 gitignore（前者"可随时重新生成"）。哈希指向一个不入库的文件，
 * 克隆下来的人什么都验不了。所以 seal 会把原文和截图**复制**进 `evidence/zhuque/`（已跟踪），
 * 并对复制件取哈希——账本自证自足，clone → audit 就能复算。
 *
 * 每条记录绑死四样：送检文本字节哈希 + 截图字节哈希 + 页面原文 + 手抄的百分比/档位，
 * 外加与 calibration-data.json 里同 id 的 `y` 互相印证（凭证与标定数据不符即报错）。
 * 本工具自身只追加写账本；手改历史行会留下 git diff，哈希与原文复算会把改动揪出来。
 *
 * 子命令（不带值的 --xxx 视为开关；路径一律相对 --base，默认仓库根）：
 *   seal --id O1 --submit-file scripts/zhuque-v4-out/O1.txt --pct 85 \
 *        --verdict "AI生成 85.00%" --label ai --screenshot artifacts/zhuque/O1.png [--by 张三]
 *   audit [--strict]   全量校验；有硬伤退出码 1
 *   list  [--id O1]    打印账本
 *
 * 送检本身仍是人工/半自动（游客档每天约 5 次且有滑块），这里只负责"做过的事留得下证据"。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseOfficialResult } from "../src/api/zhuque";
import { ZHUQUE_MIN_CHARS, type ZhuqueLabel } from "../src/engine/zhuque";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "calibration-data.json"), "utf8"));
/** 需要凭证的标定点 id（唯一真源是 calibration-data.json，不作注入） */
export const CALIB_IDS: string[] = (DATA.points as Array<{ id: string }>).map((p) => p.id);
/** id → 官方分（points[].y），用来把凭证和标定数据对上 */
const Y_BY_ID = new Map<string, number>((DATA.points as Array<{ id: string; y: number }>).map((p) => [p.id, p.y]));

export interface Store {
  /** 账本内所有路径都相对它，克隆到任何位置都能复算 */
  base: string;
  evidenceDir: string;
  ledgerFile: string;
}
export const DEFAULT_STORE: Store = {
  base: ROOT,
  evidenceDir: path.join(ROOT, "evidence", "zhuque"),
  ledgerFile: path.join(ROOT, "evidence", "zhuque", "ledger.jsonl"),
};

/**
 * 官方百分比的三档口径：≥60 AI生成 / ≥30 疑似AI辅助 / 否则人工特征
 * （src/api/zhuque.ts:177-186）。⚠️ 不要拿 engine/zhuque.ts:556 的 ≥40/≥20 来替代——
 * 那是对**我们自己的综合分**定档，刻度比官方保守，量纲不同，混用会把档位整体读严。
 * 页面原文里有档位词时以原文为准，这里只是没词可依据时的兜底。
 */
export function labelFromPct(pct: number): ZhuqueLabel {
  if (pct >= 60) return "ai";
  if (pct >= 30) return "suspected";
  return "human";
}

const LABELS: ZhuqueLabel[] = ["ai", "suspected", "human"];
const sha256 = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");
/** 与官方口径一致的字数：去掉空白后按码点计（UTF-16 长度对 emoji/生僻字不可靠） */
const countChars = (s: string) => Array.from(s).filter((c) => !/\s/.test(c)).length;
/** 仓库内相对路径（正斜杠）。落盘前已确保 dest 在 base 之内，故不可能逃出 */
const rel = (base: string, abs: string) => path.relative(base, abs).replace(/\\/g, "/");
const inside = (base: string, abs: string) => path.resolve(abs).startsWith(path.resolve(base) + path.sep);

export interface Evidence {
  id: string;
  ts: string;
  url: string;
  submitFile: string;
  submitSha256: string;
  submitChars: number;
  officialPct: number;
  verdict: string;
  label: string;
  screenshot: string;
  screenshotSha256: string;
  by: string;
}

export function readLedger(store: Store = DEFAULT_STORE): Evidence[] {
  if (!fs.existsSync(store.ledgerFile)) return [];
  return fs
    .readFileSync(store.ledgerFile, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Evidence);
}

export interface SealInput {
  id: string;
  submitFile: string;
  pct: number;
  /** 朱雀页面那一行原文，逐字粘，别改写成自己的话 */
  verdict: string;
  label: ZhuqueLabel;
  screenshot: string;
  by?: string;
}

/** 输入路径必须落在 base 之内：否则可以把仓库外任意文件抄进已跟踪的 evidence/ 里 */
function insideBase(store: Store, p: string, role: string): string {
  const abs = path.resolve(store.base, p);
  if (!inside(store.base, abs)) throw new Error(`${role}必须在 --base 之内（${p}）`);
  if (!fs.existsSync(abs)) throw new Error(`${role}不存在：${abs}`);
  return abs;
}

/**
 * 把一份产物收进证据目录。目标已存在且字节不同 → 拒绝（历史凭证不可覆盖）；一致 → 幂等。
 * 写盘前确认目标落在 base 之内，否则账本里会存成绝对路径，换台机器就再也解析不出来。
 */
function archive(srcAbs: string, destAbs: string, base: string): { buf: Buffer; hash: string } {
  const resolved = path.resolve(destAbs);
  if (!inside(base, resolved)) throw new Error(`凭证落点逃出了 base：${resolved}（base=${base}）`);
  const buf = fs.readFileSync(srcAbs);
  const hash = sha256(buf);
  if (fs.existsSync(resolved)) {
    if (sha256(fs.readFileSync(resolved)) !== hash)
      throw new Error(`证据目录里已有同名但内容不同的文件：${resolved}（不可覆盖历史凭证，请换 --id）`);
  } else {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, buf);
  }
  return { buf, hash };
}

/** 校验全部通过后才动盘：失败不留"半条记录"、不留孤儿凭证文件 */
export function seal(input: SealInput, store: Store = DEFAULT_STORE): { rec: Evidence; warnings: string[] } {
  const { id, pct, verdict, label } = input;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new Error(`--id 只能用作文件名（字母数字 . _ -），实得 ${JSON.stringify(id)}`);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error(`--pct 需在 0~100，实得 ${JSON.stringify(pct)}`);
  if (!LABELS.includes(label))
    throw new Error(`--label 只能是 ${LABELS.join("/")}（官方档位词），实得 ${JSON.stringify(label)}`);
  const srcText = insideBase(store, input.submitFile, "送检文本");
  const srcShot = insideBase(store, input.screenshot, "截图");

  // —— 页面原文与手填值互证：这一条正是"5/5 判人类"那类读反的防线 ——
  const page = parseOfficialResult(verdict);
  if (!page.ok) throw new Error(`verdict 里解析不出百分比或档位，逐字粘页面那行原文：${JSON.stringify(verdict)}`);
  if (page.probability !== null && Math.abs(page.probability - pct) > 0.01)
    throw new Error(`页面原文是 ${page.probability}%，你记的 --pct 是 ${pct}%——以原文为准，别改数字`);
  if (page.label && page.label !== label)
    throw new Error(`页面原文的档位是「${page.labelText}」(${page.label})，你记的 --label 是 ${label}——读反了就重看截图`);

  if (CALIB_IDS.includes(id)) {
    const y = Y_BY_ID.get(id);
    if (y !== undefined && Math.abs(y - pct) > 0.01)
      throw new Error(`${id} 在 calibration-data.json 里的官分是 ${y}%，你记的是 ${pct}%——两边必须对上一致`);
  }

  const warnings: string[] = [];
  if (!CALIB_IDS.includes(id)) warnings.push(`${id} 不在标定数据源里，audit 会算它一条"孤儿凭证"`);
  const chars = countChars(fs.readFileSync(srcText, "utf8"));
  if (chars < ZHUQUE_MIN_CHARS) warnings.push(`送检文本不足 ${ZHUQUE_MIN_CHARS} 字（朱雀下限），这个官分本身就不成立`);

  const ext = path.extname(srcShot) || ".png";
  const destText = path.join(store.evidenceDir, `${id}.txt`);
  const destShot = path.join(store.evidenceDir, `${id}${ext}`);
  const text = archive(srcText, destText, store.base);
  const shot = archive(srcShot, destShot, store.base);

  const rec: Evidence = {
    id,
    ts: new Date().toISOString(),
    url: "https://matrix.tencent.com/ai-detect/ai_gen",
    submitFile: rel(store.base, destText),
    submitSha256: text.hash,
    submitChars: chars,
    officialPct: pct,
    verdict,
    label,
    screenshot: rel(store.base, destShot),
    screenshotSha256: shot.hash,
    by: input.by || process.env.USER || "unknown",
  };
  fs.mkdirSync(path.dirname(store.ledgerFile), { recursive: true });
  fs.appendFileSync(store.ledgerFile, JSON.stringify(rec) + "\n");
  return { rec, warnings };
}

export type ProblemKind =
  | "no-evidence"
  | "bad-line"
  | "file-missing"
  | "hash-mismatch"
  | "outside-store"
  | "unknown-id"
  | "pct-conflict"
  | "polarity-conflict"
  | "verdict-conflict"
  | "dataset-conflict"
  | "short-text";

export interface AuditProblem {
  kind: ProblemKind;
  id: string;
  msg: string;
}

/** 硬伤 = 凭证本身不成立（一律拦）；软账 = 历史点还没补凭证（列出不拦，--strict 才升级） */
export const HARD_KINDS: ProblemKind[] = [
  "bad-line",
  "file-missing",
  "hash-mismatch",
  "outside-store",
  "unknown-id",
  "pct-conflict",
  "polarity-conflict",
  "verdict-conflict",
  "dataset-conflict",
  "short-text",
];
export const isHard = (p: AuditProblem, strict: boolean) => strict || HARD_KINDS.includes(p.kind);

/** 读账本并容错：坏行/合并冲突标记不能把整个审计炸掉，而是报一条硬伤 */
function loadLedger(store: Store): { recs: Evidence[]; bad: AuditProblem[] } {
  const recs: Evidence[] = [];
  const bad: AuditProblem[] = [];
  if (!fs.existsSync(store.ledgerFile)) return { recs, bad };
  const lines = fs.readFileSync(store.ledgerFile, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const e = JSON.parse(line) as Evidence;
      if (typeof e.id !== "string" || typeof e.submitFile !== "string" || typeof e.screenshot !== "string")
        throw new Error("缺 id/submitFile/screenshot 字段");
      recs.push(e);
    } catch (err) {
      bad.push({ kind: "bad-line", id: `#${i + 1}`, msg: `账本第 ${i + 1} 行解析失败：${(err as Error).message}` });
    }
  });
  return { recs, bad };
}

/**
 * 校验规则分软硬：
 *  - 硬伤：坏行、文件缺失/哈希不符、凭证没在证据目录里（克隆后拿不到）、id 不属于任何标定点
 *    （"记错行"的典型形态）、页面原文与手抄值不符、同一 id 多条矛盾官分、与标定数据源的 y 不符、
 *    送检不足 350 字
 *  - 软账：账本启用前就存在的老点无凭证。18 个历史点全无凭证，一律硬拦会让仓库永久红、
 *    进而没人看这个检查（`calib-sanity` 就是前车之鉴：报 14/18 漂移却退出 0）。
 *    发布前用 --strict 把"无凭证"升级为硬伤。
 */
export function audit(store: Store = DEFAULT_STORE, strict = false): AuditProblem[] {
  const { recs: all, bad } = loadLedger(store);
  const byId = new Map<string, Evidence[]>();
  for (const e of all) byId.set(e.id, [...(byId.get(e.id) || []), e]);
  const problems: AuditProblem[] = [...bad];

  for (const [id, recs] of byId) {
    if (!CALIB_IDS.includes(id))
      problems.push({ kind: "unknown-id", id, msg: `账本里的 ${id} 不是任何标定点——id 打错了？` });
    for (const e of recs) {
      for (const [role, p, hash] of [
        ["送检文本", e.submitFile, e.submitSha256],
        ["截图", e.screenshot, e.screenshotSha256],
      ] as const) {
        const abs = path.resolve(store.base, p);
        if (!inside(store.base, abs)) {
          problems.push({ kind: "outside-store", id, msg: `${role}路径逃出了仓库：${p}` });
          continue;
        }
        if (!fs.existsSync(abs)) {
          problems.push({ kind: "file-missing", id, msg: `${role}已不在：${p}` });
          continue;
        }
        const buf = fs.readFileSync(abs);
        if (sha256(buf) !== hash)
          problems.push({ kind: "hash-mismatch", id, msg: `${role}内容与凭证不符（${p} 被改过？）` });
        if (!inside(store.evidenceDir, abs))
          problems.push({ kind: "outside-store", id, msg: `${role}不在证据目录内，不会随仓库分发：${p}` });
      }

      // 页面原文是独立于手抄值的那一路：重新解析一次，与记录里的 pct/label 对照
      const page = parseOfficialResult(e.verdict || "");
      if (!page.ok)
        problems.push({ kind: "verdict-conflict", id, msg: `verdict 解析不出百分比/档位，不算凭证：${JSON.stringify((e.verdict || "").slice(0, 40))}` });
      else {
        if (page.probability !== null && Math.abs(page.probability - e.officialPct) > 0.01)
          problems.push({
            kind: "verdict-conflict",
            id,
            msg: `页面原文写 ${page.probability}%，账本记 ${e.officialPct}%`,
          });
        if (page.label && page.label !== e.label)
          problems.push({
            kind: "polarity-conflict",
            id,
            msg: `页面原文档位是「${page.labelText}」(${page.label})，账本记 ${e.label}`,
          });
      }
      // 原文解析不出档位词时，至少保证 pct 与 label 自洽
      if (!page.label && e.label !== labelFromPct(e.officialPct))
        problems.push({
          kind: "polarity-conflict",
          id,
          msg: `官分 ${e.officialPct}% 按官方口径属「${labelFromPct(e.officialPct)}」档，记录却写 ${e.label}`,
        });

      const y = Y_BY_ID.get(id);
      if (y !== undefined && Math.abs(y - e.officialPct) > 0.01)
        problems.push({ kind: "dataset-conflict", id, msg: `凭证官分 ${e.officialPct}% 与标定数据源 y=${y}% 不符` });

      // 字数以**文件实际内容**为准：账本字段本身是可被手改的
      const absText = path.resolve(store.base, e.submitFile);
      const chars = fs.existsSync(absText) ? countChars(fs.readFileSync(absText, "utf8")) : e.submitChars;
      if (chars < ZHUQUE_MIN_CHARS)
        problems.push({ kind: "short-text", id, msg: `送检 ${chars} 字 < 朱雀下限 ${ZHUQUE_MIN_CHARS}，该结果不成立` });
    }
    if (recs.length > 1) {
      const set = new Set(recs.map((r) => r.officialPct));
      if (set.size > 1)
        problems.push({ kind: "pct-conflict", id, msg: `同一 id 有多条矛盾官分：${[...set].join(" / ")}` });
    }
  }

  for (const id of CALIB_IDS) {
    if (byId.has(id)) continue;
    problems.push({
      kind: "no-evidence",
      id,
      msg: strict ? "标定点无凭证（--strict）" : "无凭证（历史点，仅列账）",
    });
  }
  return problems;
}

/** CLI 参数：不带值的 --xxx 是开关；带值的（含负数）照原样收 */
export function parseOpts(argv: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || a === "--") continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    opts[key] = next === undefined || next.startsWith("--") ? "1" : argv[++i];
  }
  return opts;
}

/** --base 一次定住三个路径：测试用临时目录、审计用别的 checkout 都靠它 */
export function storeFromOpts(opts: Record<string, string>): Store {
  const base = path.resolve(opts.base && opts.base !== "1" ? opts.base : ROOT);
  const pick = (v: string | undefined, dflt: string) =>
    v && v !== "1" ? path.resolve(base, v) : path.resolve(base, path.relative(ROOT, dflt));
  return {
    base,
    evidenceDir: pick(opts["evidence-dir"], DEFAULT_STORE.evidenceDir),
    ledgerFile: pick(opts.ledger, DEFAULT_STORE.ledgerFile),
  };
}

const CLI_KEYS = ["id", "submit-file", "pct", "verdict", "label", "screenshot"] as const;

export function main(argv: string[] = process.argv.slice(2)): number {
  const cmd = argv[0] || "audit";
  const opts = parseOpts(argv.slice(1));
  const store = storeFromOpts(opts);
  const strict = "strict" in opts;
  const report = () => {
    const problems = audit(store, strict);
    const hard = problems.filter((p) => isHard(p, strict));
    const soft = problems.filter((p) => !isHard(p, strict));
    const sealed = new Set(loadLedger(store).recs.map((e) => e.id));
    const covered = CALIB_IDS.filter((id) => sealed.has(id)).length;
    for (const p of hard) console.log(`❌ [${p.kind}] ${p.id}：${p.msg}`);
    for (const p of soft) console.log(`  ○ ${p.id}：${p.msg}`);
    console.log(`凭证覆盖率：${covered}/${CALIB_IDS.length} 个标定点有凭证`);
    console.log(
      hard.length
        ? `❌ 凭证审计未通过：${hard.length} 项硬伤${strict ? "" : `（另有 ${soft.length} 个历史点无凭证，只列账不拦）`}`
        : `✅ 凭证审计通过；${soft.length} 个历史点待补凭证`,
    );
    return hard.length ? 1 : 0;
  };

  if (cmd === "seal") {
    const missing = CLI_KEYS.filter((k) => !opts[k] || opts[k] === "1");
    if (missing.length) {
      console.error(`缺少参数：${missing.map((k) => "--" + k).join(" ")}`);
      return 2;
    }
    let out: { rec: Evidence; warnings: string[] };
    try {
      out = seal(
        {
          id: opts.id,
          submitFile: opts["submit-file"],
          pct: Number(opts.pct),
          verdict: opts.verdict,
          label: opts.label as ZhuqueLabel,
          screenshot: opts.screenshot,
          by: opts.by,
        },
        store,
      );
    } catch (err) {
      console.error(`❌ 入账失败：${(err as Error).message}`);
      return 2;
    }
    const { rec, warnings } = out;
    console.log(`已入账 ${rec.id}：官分 ${rec.officialPct}% (${rec.label}) 送检 ${rec.submitChars} 字`);
    console.log(`  submit ${rec.submitSha256.slice(0, 12)}… ${rec.submitFile}`);
    console.log(`  shot   ${rec.screenshotSha256.slice(0, 12)}… ${rec.screenshot}`);
    for (const w of warnings) console.log(`⚠️  ${w}`);
    console.log("凭证与账本都要入库，否则克隆后无法复算：git add evidence/");
  } else if (cmd === "list") {
    const { recs, bad } = loadLedger(store);
    for (const e of recs) if (!opts.id || e.id === opts.id) console.log(JSON.stringify(e));
    for (const b of bad) console.log(`❌ [${b.kind}] ${b.id}：${b.msg}`);
    console.log(`（账本 ${recs.length} 条${bad.length ? ` + ${bad.length} 行坏数据` : ""} → ${rel(ROOT, store.ledgerFile)}）`);
    return bad.length ? 1 : 0;
  } else if (cmd !== "audit") {
    console.error(`未知子命令 ${cmd}（可用：seal | audit | list）`);
    return 2;
  }
  return report();
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) process.exit(main());
