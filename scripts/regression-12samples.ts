/**
 * scripts/regression-12samples.ts
 * 12 样本回归套件（4 体裁 × 3 档位）——两组各自有独立语义的门禁
 *
 * 样本来源：
 *  - 叙事 ×3 / 对话 ×3 / 人写 ×3 ← calibration-data-v2-genres.json（存档文本随仓库冻结）
 *  - 论说文 ×3 ← 本文件里的 EXPO_O1_RAW 字面量 + 当前引擎产物
 *
 * ── 为什么拆成两组 ──
 * 旧版把 A（对存档文本打分）和 B（对当前引擎产物打分）都拿去和「老 aiScore」比 ±10%。
 * 这两件事的量纲根本不是一回事，实测下来 A 套件在已提交状态上永久红（3/12）：
 * 存档的 dialogue·0.6 记的是 6 分，同一段文字今天重打是 100 分。
 * 而 A 的输入文本**冻在 git 里**，引擎根本不参与——能动它的只有评分器本身。
 * 所以 A 天生只能测「评分器漂移」，拿它判「引擎有没有退化」是拿错了尺子。
 *
 * ── 现在这两组各测各的 ──
 * 【D 评分器漂移组】输入 = 冻结在仓库里的文本（9 条 v2 存档 + O1 字面量）。引擎不参与。
 *   D1 绝对刻度守卫（不依赖任何历史数字）：人写原文 ≤ AI_SCORE_HUMAN_MAX，
 *      AI 原文 ≥ AI_SCORE_MACHINE_MIN，且分离度 ≥ SEP_MIN。
 *      → 换了权重也拦得住「两类糊到一起」，这才是评分器真正该守的东西。
 *   D2 方向棘轮（看基线）：每条按 want 只许朝好的方向走，朝坏方向动 1 分即红。
 *      aiScore 纯确定性 ⇒ slack=0；要放行恶化必须显式 --rebaseline 并写原因。
 * 【E 引擎退化组】输入 = 当前引擎在同一 seed 下的产物，8 条 intensity>0。
 *   对锁里的记录做只降不升棘轮。记录缺失即红——旧版 loadOrInitLock 会在锁不在时
 *   把「今天的输出」直接写成明天的真值，那是自欺。
 *
 * 退出码：0=全绿；1=有红灯（并打印完整失败现场）；2=参数用法错误。
 * 本脚本只读锁文件；写锁只有一条路：--rebaseline "<原因>"（且有红灯时拒绝写）。
 *
 * 自检开关（为了让"这道门禁真的会拦"可被证明，而不是看着绿）：
 *  --lock <path>    换锁文件路径（测试用坏基线喂它，看它红不红）
 *  --sep-min <n>    临时抬高人机分离度门槛（HEAD 实测 26，抬到 27 就该红）
 */

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { aiScore, AI_SCORE_HUMAN_MAX, AI_SCORE_MACHINE_MIN } from "../src/engine/humanize-metrics";
import { humanize } from "../src/engine/humanize";

// ESM 下没有 __dirname（package.json "type": "module"），从 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const V2_JSON_PATH = path.join(__dirname, "calibration-data-v2-genres.json");
const DEFAULT_LOCK_PATH = path.join(__dirname, "regression-12samples.lock.json");
/** E2E 固定种子：所有强度>0 档都用同一 seed 跑，保证 deterministic 前后严格对比 */
const CI_SEED = 20260826;
/** 冻结文本里「AI 原文」与「人写原文」的最小间隔。
 *  低于它说明评分器把两类糊到了一起——比任何单条绝对分漂移都严重。
 *  HEAD 实测：min(N0,D0,O1)=33，H0=7 → 26 分。 */
const SEP_MIN = 20;

const EXPO_O1_RAW = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元人民币，占 GDP 的比重达到了 41.8%，较上一年度同比提升了 2.3 个百分点。值得注意的是，这一增长速度已经连续八年保持在 15% 以上，充分体现了数字经济作为国民经济核心增长引擎的强大动力与韧性。
综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入，根据相关调研数据显示，2025 年全球企业数字化研发预算平均占比已经达到了营收的 8.9%，而国内领先企业这一数字更是高达 12.3%；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系，目前国内仅有不到 23% 的企业真正实现了数据资产化运营，这意味着绝大多数企业在这一领域还有非常大的提升空间；最后，也是最为重要的一点，企业需要培养和引进既懂业务又懂技术的复合型数字化人才，根据人社部发布的最新人才缺口报告显示，到 2027 年我国数字化人才缺口预计将超过 2500 万，人才争夺战正在进入前所未有的白热化阶段。
最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有那些真正把数字化战略上升到企业核心战略层面，并脚踏实地、一步一个脚印去落地执行的企业，才能在未来十年甚至更长的时间周期里，始终立于不败之地，创造出属于自己的辉煌业绩。`;

type Want = "low" | "high";

type Sample = {
  id: string;
  genre: string;
  level: string;
  intensity: number;
  zhuqueMode: boolean;
  /** E 组输入：送进引擎的原文 */
  sourceText: string;
  /** D 组输入：冻结在仓库里的文本。null = 该档位产物没进仓库（论说 O2/O3 当年现算），D 组跳过 */
  archivedText: string | null;
  /** aiScore 朝哪个方向算变好 */
  want: Want;
  /** 是否属于「原文」对照组（D1 刻度守卫用） */
  original?: "human" | "ai";
};

function loadV2(): any[] {
  try {
    return JSON.parse(fs.readFileSync(V2_JSON_PATH, "utf8"));
  } catch (e) {
    console.error("❌ 无法加载 v2 标定数据:", (e as Error).message);
    process.exit(1);
    return [] as any; // unreachable，安抚 strict tsc 非 undefined 返回
  }
}

function buildSamples(): Sample[] {
  const v2 = loadV2();
  const byGenreLevel: Record<string, any> = {};
  for (const r of v2) byGenreLevel[`${r.genre}|${r.level}`] = r;

  const N0 = byGenreLevel["narrative|原文"];
  const N1 = byGenreLevel["narrative|基础档(0.6)"];
  const N2 = byGenreLevel["narrative|朱雀档(0.9)"];
  const D0 = byGenreLevel["dialogue|原文"];
  const D1 = byGenreLevel["dialogue|基础档(0.6)"];
  const D2 = byGenreLevel["dialogue|朱雀档(0.9)"];
  const H0 = byGenreLevel["humanHand|纯人写稿(无处理)"];
  const H1 = byGenreLevel["humanHand|基础档(0.6)"];
  const H2 = byGenreLevel["humanHand|朱雀档(0.9)"];

  if (!N0 || !N1 || !N2 || !D0 || !D1 || !D2 || !H0 || !H1 || !H2) {
    console.error("❌ v2 JSON 条目缺失，存在:", Object.keys(byGenreLevel));
    process.exit(1);
  }

  /** want 怎么定的：
   *  - 原文行：AI 原文 want=high（评分器必须认得出机器稿，掉下来 = 漏检），
   *    人写原文 want=low（评分器不许误杀真人稿）。
   *  - 去味档位行（0.6/0.7/0.9）：产品目标就是让分往下走 → want=low。
   *    注意 D 组比的是「旧引擎留在仓库里那版产物」，它分高只说明旧引擎不行，
   *    当前引擎那一版由 E 组单独测——两组同一个 id 分数差很多是设计如此。 */
  return [
    {
      id: "N0",
      genre: "叙事文",
      level: "原文",
      intensity: 0,
      zhuqueMode: false,
      sourceText: N0.text,
      archivedText: N0.text,
      want: "high",
      original: "ai",
    },
    {
      id: "N1",
      genre: "叙事文",
      level: "基础档(0.6)",
      intensity: 0.6,
      zhuqueMode: false,
      sourceText: N0.text,
      archivedText: N1.text,
      want: "low",
    },
    {
      id: "N2",
      genre: "叙事文",
      level: "朱雀档(0.9)",
      intensity: 0.9,
      zhuqueMode: true,
      sourceText: N0.text,
      archivedText: N2.text,
      want: "low",
    },
    {
      id: "D0",
      genre: "对话体",
      level: "原文",
      intensity: 0,
      zhuqueMode: false,
      sourceText: D0.text,
      archivedText: D0.text,
      want: "high",
      original: "ai",
    },
    {
      id: "D1",
      genre: "对话体",
      level: "基础档(0.6)",
      intensity: 0.6,
      zhuqueMode: false,
      sourceText: D0.text,
      archivedText: D1.text,
      want: "low",
    },
    {
      id: "D2",
      genre: "对话体",
      level: "朱雀档(0.9)",
      intensity: 0.9,
      zhuqueMode: true,
      sourceText: D0.text,
      archivedText: D2.text,
      want: "low",
    },
    {
      id: "H0",
      genre: "纯人写稿",
      level: "纯人写稿(无处理)",
      intensity: 0,
      zhuqueMode: false,
      sourceText: H0.text,
      archivedText: H0.text,
      want: "low",
      original: "human",
    },
    {
      id: "H1",
      genre: "纯人写稿",
      level: "基础档(0.6)",
      intensity: 0.6,
      zhuqueMode: false,
      sourceText: H0.text,
      archivedText: H1.text,
      want: "low",
    },
    {
      id: "H2",
      genre: "纯人写稿",
      level: "朱雀档(0.9)",
      intensity: 0.9,
      zhuqueMode: true,
      sourceText: H0.text,
      archivedText: H2.text,
      want: "low",
    },
    {
      id: "O1",
      genre: "论说文",
      level: "原文",
      intensity: 0,
      zhuqueMode: false,
      sourceText: EXPO_O1_RAW,
      archivedText: EXPO_O1_RAW,
      want: "high",
      original: "ai",
    },
    {
      id: "O2",
      genre: "论说文",
      level: "基础档(0.7)",
      intensity: 0.7,
      zhuqueMode: false,
      sourceText: EXPO_O1_RAW,
      archivedText: null,
      want: "low",
    },
    {
      id: "O3",
      genre: "论说文",
      level: "朱雀档(0.9+P3)",
      intensity: 0.9,
      zhuqueMode: true,
      sourceText: EXPO_O1_RAW,
      archivedText: null,
      want: "low",
    },
  ];
}

// ───────────────────────────── 锁文件 ─────────────────────────────

type LockV2 = {
  version: 2;
  seed: number;
  drift: Record<string, { want: Want; score: number }>;
  e2e: Record<string, { score: number; note: string }>;
  rebaseLog: { at: string; reason: string; changes: string[] }[];
};

function emptyLock(): LockV2 {
  return { version: 2, seed: CI_SEED, drift: {}, e2e: {}, rebaseLog: [] };
}

function noteFor(s: Sample) {
  return `seed=${CI_SEED}, intensity=${s.intensity}, zhuque=${s.zhuqueMode}, genre=${s.genre}`;
}

/** 读锁。v1（扁平 "N1_e2e"）在内存里迁移成 v2，不落盘——
 *  v1 那批数字本来就是同 seed 的引擎产物分，迁移后仍是 E 组的合法棘轮记录。 */
function loadLock(lockPath: string): LockV2 {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    console.log("⚠️  锁文件缺失/损坏：所有棘轮记录按「无基线」处理（E 组会直接红，不自动初始化）");
    return emptyLock();
  }
  if (raw && raw.version === 2) return raw as LockV2;

  const lock = emptyLock();
  let migrated = 0;
  for (const [k, v] of Object.entries<any>(raw ?? {})) {
    if (!k.endsWith("_e2e")) continue;
    if (typeof v?.score !== "number") continue;
    lock.e2e[k.slice(0, -"_e2e".length)] = { score: v.score, note: v.note ?? "" };
    migrated++;
  }
  console.log(
    `🗝️  锁文件为 v1，已在内存迁移出 ${migrated} 条 E2E 记录（D 组基线为空，需 --rebaseline 建立）`,
  );
  return lock;
}

// ───────────────────────────── 评估 ─────────────────────────────

type Row = {
  id: string;
  genre: string;
  level: string;
  want: Want;
  base: number | null;
  now: number;
  ok: boolean;
  /** 红灯原因是「锁里还没这条记录」（首次建线），而不是「相对基线退化了」 */
  missing: boolean;
  rule: string;
};

/** slack=0 的方向棘轮：aiScore 是纯确定性的，同一段文本同一次实现不可能自己动，
 *  所以任何朝坏方向的位移都只能是这次改动引入的，没有「测量噪声」可以借口。 */
function ratchet(s: Sample, base: number | undefined, now: number): Row {
  let bad = "";
  const missing = base == null;
  if (missing) {
    bad = `锁里无 ${s.id} 基线记录`;
  } else if (s.want === "low" && now > base) {
    bad = `上升 ${base} → ${now}（更像机器了）`;
  } else if (s.want === "high" && now < base) {
    bad = `下降 ${base} → ${now}（检出能力变弱）`;
  }
  const dir = s.want === "low" ? "≤" : "≥";
  return {
    id: s.id,
    genre: s.genre,
    level: s.level,
    want: s.want,
    base: base ?? null,
    now,
    ok: bad === "",
    missing,
    rule: bad === "" ? `${now} ${dir} 基线 ${base}` : `❌ ${bad}，违反「${dir} 基线」`,
  };
}

function report(title: string, rows: Row[], extra: string[] = []): number {
  console.log(`\n━━━━━━━━━━━━━ ${title} ━━━━━━━━━━━━━`);
  for (const line of extra) console.log(line);
  for (const r of rows) {
    console.log(
      `  ${r.ok ? "✅" : "❌"} ${r.id.padEnd(2)} [${r.genre.slice(0, 2)}·${r.level.padEnd(16)}] ${r.want === "low" ? "降为优" : "升为优"}  ${r.rule}`,
    );
  }
  const fail = rows.filter((r) => !r.ok).length;
  console.log(`  → 小计：${rows.length - fail}/${rows.length} 通过，失败 ${fail} 例`);
  return fail;
}

/** D1 绝对刻度守卫：只依赖导出的刻度常量，不依赖任何历史基线 */
function checkBand(rows: Record<string, number>, sepMin: number) {
  const fails: string[] = [];
  const lines: string[] = ["  【D1 绝对刻度守卫】不比对历史数字，只比对打分刻度本身："];
  const human = rows["H0"];
  const aiIds = ["N0", "D0", "O1"];
  const ai = aiIds.map((i) => rows[i]);

  const humanOk = human <= AI_SCORE_HUMAN_MAX;
  if (!humanOk)
    fails.push(`人写原文 H0=${human} 越过人写上限 ${AI_SCORE_HUMAN_MAX} → 评分器在误杀真人稿`);
  lines.push(
    `    ${humanOk ? "✅" : "❌"} 人写原文 H0=${human} ${humanOk ? "≤" : ">"} 人写上限 ${AI_SCORE_HUMAN_MAX}`,
  );

  for (let i = 0; i < aiIds.length; i++) {
    const ok = ai[i] >= AI_SCORE_MACHINE_MIN;
    if (!ok)
      fails.push(
        `${aiIds[i]} 原文=${ai[i]} 低于机器下限 ${AI_SCORE_MACHINE_MIN} → 评分器漏检机器稿`,
      );
    lines.push(
      `    ${ok ? "✅" : "❌"} ${aiIds[i]} 原文=${ai[i]} ${ok ? "≥" : "<"} 机器下限 ${AI_SCORE_MACHINE_MIN}`,
    );
  }

  const sep = Math.min(...ai) - human;
  const sepOk = sep >= sepMin;
  if (!sepOk) fails.push(`人机分离度 ${sep} < ${sepMin} → 两类被糊到一起，标定线全部失去意义`);
  lines.push(
    `    ${sepOk ? "✅" : "❌"} 分离度 min(AI原文)-H0 = ${Math.min(...ai)} - ${human} = ${sep} ${sepOk ? "≥" : "<"} 要求 ${sepMin}`,
  );
  return { fails, lines };
}

type Opts = {
  rebaseline: string | null;
  lockPath: string;
  sepMin: number;
  usageError: string | null;
};

const USAGE =
  "用法：npx tsx scripts/regression-12samples.ts [--lock <path>] [--sep-min <n>]\n" +
  '     收紧/重建基线：npx tsx scripts/regression-12samples.ts --rebaseline "<为什么这批数字是新常态>"';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    rebaseline: null,
    lockPath: DEFAULT_LOCK_PATH,
    sepMin: SEP_MIN,
    usageError: null,
  };
  const rb = flagValue(argv, "--rebaseline");
  if (argv.includes("--rebaseline")) {
    const reason = (rb ?? "").trim();
    if (!reason || reason.startsWith("--")) {
      opts.usageError =
        "❌ --rebaseline 必须紧跟一条非空原因，说清为什么允许基线移动（防止把今天的输出顺手当新真值）。";
      return opts;
    }
    opts.rebaseline = reason;
  }
  if (argv.includes("--lock")) {
    const lp = (flagValue(argv, "--lock") ?? "").trim();
    if (!lp || lp.startsWith("--")) {
      opts.usageError = "❌ --lock 需要一个路径参数";
      return opts;
    }
    opts.lockPath = path.resolve(lp);
  }

  if (argv.includes("--sep-min")) {
    const n = Number(flagValue(argv, "--sep-min"));
    if (!Number.isFinite(n) || n < 0) {
      opts.usageError = "❌ --sep-min 需要一个非负数字";
      return opts;
    }
    opts.sepMin = n;
  }
  return opts;
}

function writeRebaseline(
  lock: LockV2,
  samples: Sample[],
  driftNow: Record<string, number>,
  e2eNow: Record<string, number>,
  reason: string,
  lockPath: string,
) {
  const changes: string[] = [];
  for (const s of samples) {
    if (s.archivedText != null && s.id in driftNow) {
      const old = lock.drift[s.id]?.score;
      const next = driftNow[s.id];
      if (old !== next) changes.push(`D/${s.id}:${old ?? "∅"}→${next}`);
      lock.drift[s.id] = { want: s.want, score: next };
    }
    if (s.intensity > 0 && s.id in e2eNow) {
      const old = lock.e2e[s.id]?.score;
      const next = e2eNow[s.id];
      if (old !== next) changes.push(`E/${s.id}:${old ?? "∅"}→${next}`);
      lock.e2e[s.id] = { score: next, note: noteFor(s) };
    }
  }
  lock.seed = CI_SEED;
  lock.rebaseLog.push({
    at: new Date().toISOString().slice(0, 10),
    reason,
    changes,
  });
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
  return changes;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const opts = parseArgs(argv);
  if (opts.usageError) {
    console.error(opts.usageError);
    console.error(USAGE);
    return 2;
  }
  const samples = buildSamples();
  const lock = loadLock(opts.lockPath);

  console.log("══════════════════════════════════════════════════════════════");
  console.log(" 趣AI味 · 12 样本回归套件：D 评分器漂移 / E 引擎退化");
  console.log(` 固定 seed=${CI_SEED} · aiScore 纯确定性 ⇒ 棘轮 slack=0`);
  console.log(` 锁文件：${path.relative(process.cwd(), opts.lockPath) || opts.lockPath}`);
  console.log("══════════════════════════════════════════════════════════════");

  // ── D 组：输入冻在仓库里，只有评分器改得动
  const driftNow: Record<string, number> = {};
  const bandRows: Record<string, number> = {};
  const driftRows: Row[] = [];
  for (const s of samples) {
    if (s.archivedText == null) continue;
    const now = aiScore(s.archivedText).score;
    driftNow[s.id] = now;
    if (s.original) bandRows[s.id] = now;
    driftRows.push(ratchet(s, lock.drift[s.id]?.score, now));
  }
  const band = checkBand(bandRows, opts.sepMin);
  const failD = report("D. 评分器漂移（输入冻在仓库里，引擎不参与）", driftRows, band.lines);

  // ── E 组：当前引擎同 seed 产物 → 只降不升棘轮
  const e2eNow: Record<string, number> = {};
  const e2eRows: Row[] = [];
  for (const s of samples) {
    if (s.intensity === 0) continue;
    const out = humanize(s.sourceText, {
      intensity: s.intensity,
      zhuqueMode: s.zhuqueMode,
      seed: CI_SEED,
    });
    const now = aiScore(out).score;
    e2eNow[s.id] = now;
    e2eRows.push(ratchet(s, lock.e2e[s.id]?.score, now));
  }
  const failE = report("E. 引擎退化（sourceText → 当前引擎 → aiScore）", e2eRows);

  // ── 汇总表
  console.log("\n━━━━━━━━━━━━━ 汇总表（D=存档文本 / E=当前引擎产物） ━━━━━━━━━━━━━");
  console.log("| ID | 体裁 | 档位 | 期望 | D当前 | D基线 | D判定 | E当前 | E基线 | E判定 |");
  console.log("|----|------|------|------|-------|-------|-------|-------|-------|-------|");
  for (const s of samples) {
    const d = driftRows.find((r) => r.id === s.id);
    const e = e2eRows.find((r) => r.id === s.id);
    console.log(
      `| ${s.id} | ${s.genre} | ${s.level} | ${s.want === "low" ? "↓" : "↑"} | ${d ? d.now : "—"} | ${d?.base ?? "—"} | ${d ? (d.ok ? "✅" : "❌") : "—"} | ${e ? e.now : "—"} | ${e?.base ?? "—"} | ${e ? (e.ok ? "✅" : "❌") : "—"} |`,
    );
  }

  // ── 棘轮松着的地方：只报不改（CI 里不写文件）
  const tightenable: string[] = [];
  for (const r of driftRows)
    if (r.ok && r.base != null && r.now !== r.base)
      tightenable.push(`D/${r.id} ${r.base}→${r.now}`);
  for (const r of e2eRows)
    if (r.ok && r.base != null && r.now < r.base) tightenable.push(`E/${r.id} ${r.base}→${r.now}`);
  if (tightenable.length) {
    console.log(
      `\n🔧 ${tightenable.length} 条基线已被当前实现追上或甩开，棘轮还松着：\n    ${tightenable.join("、")}\n    要收紧：${USAGE.split("\n")[1].trim()}`,
    );
  }

  const fails = failD + failE + band.fails.length;
  // 「首次建线」和「相对基线退化」是两件事：锁里没记录时全表都是红灯，
  // 那时必须允许 --rebaseline 打第一版基线；一旦有了记录，只认真退化。
  const regressed =
    fails -
    band.fails.length -
    driftRows.filter((r) => r.missing).length -
    e2eRows.filter((r) => r.missing).length;
  console.log("\n══════════════════════════════════════════════════════════════");
  if (band.fails.length) {
    console.log("  ❌ D1 绝对刻度守卫失败：");
    for (const f of band.fails) console.log(`     · ${f}`);
  }
  console.log(
    ` D 组 ${driftRows.length - failD}/${driftRows.length} · E 组 ${e2eRows.length - failE}/${e2eRows.length} · 刻度守卫 ${band.fails.length ? "❌" : "✅"}`,
  );

  if (opts.rebaseline && regressed === 0 && band.fails.length === 0) {
    const changes = writeRebaseline(
      lock,
      samples,
      driftNow,
      e2eNow,
      opts.rebaseline,
      opts.lockPath,
    );
    console.log(
      `\n🗝️  已重写棘轮基线（${changes.length} 条变动），原因与差值记入 rebaseLog：\n    「${opts.rebaseline}」\n    ${changes.join("、") || "（无变动）"}`,
    );
    console.log("══════════════════════════════════════════════════════════════");
    return 0;
  }
  if (opts.rebaseline) {
    console.log(` ❌ 还有 ${fails} 项红灯，拒绝 --rebaseline：先把真实回归查掉，再谈改基线。`);
  }
  console.log(
    ` 总体结果：${fails === 0 ? "✅ 全部及格 ✅" : `❌ ${fails} 项未通过，见上方 ❌ 行 ❌`}`,
  );
  console.log("══════════════════════════════════════════════════════════════");
  return fails === 0 ? 0 : 1;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) process.exit(main());
