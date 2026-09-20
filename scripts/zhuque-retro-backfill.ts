/**
 * scripts/zhuque-retro-backfill.ts —— 把 18 个历史标定点的**现存**凭证收回账本
 *
 * 背景：`calibration-data.json` 里 18 个点全带官方百分比，但账本 `evidence/zhuque/ledger.jsonl`
 * 一条都没有——数字只活在档案正文和口头记忆里。本脚本做两级回收：
 *   L1 送检文本：从 scripts/archive/ 的送检档案里按 id 抠出当时贴进朱雀的原文，
 *      并用档案里同时记录的「字数」逐点核对（对不上就是抄漏/改写，不收）。
 *   L2 官分出处：记下这个数字抄自哪份档案的哪一行，写成 "文件:行号"。
 *
 * **它补不出 L3（页面截图）**——当年没人截图，现在也伪造不出来。
 * 所以跑完之后 `audit` 仍然把这 18 个点算作未认证，`check:publish`（--strict）照旧红。
 * 唯一能升到认证的路是重新送检（官方 API 已可用，见 scripts/zhuque-api-score.ts）。
 *
 * 用法：npx tsx scripts/zhuque-retro-backfill.ts [--dry-run]
 * 幂等：账本里已有记录的 id 直接跳过（账本 append-only，重复跑不会造出第二条）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countChars, readLedger, sealRetro, DEFAULT_STORE, type Store } from "./zhuque-evidence.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rd = (p: string) => fs.readFileSync(p, "utf8");

const cal = JSON.parse(rd(path.join(__dirname, "calibration-data.json")));
const points: Array<{ id: string; x: number; y: number; source: string }> = cal.points;

/* ---------- v2 批次：档案裸 id → 正本带版本 id ---------- */
const V2_MAP: Record<string, string> = {
  N1: "N1",
  N2: "N2v2",
  N3: "N3v2",
  D1: "D0", // 档案里 D1 是"对话体原文"，正本用 D0
  D2: "D2v2",
  D3: "D3v2",
  H0: "H0",
  H1: "H1",
  H2: "H2v2",
};
const HDR = /【\s*\d+\s*·\s*id=([A-Za-z0-9._-]+)\s*】\s*(.+?)\s+aiScore=(\d+)\s+字数=(\d+)/;
const V2_FILE = "scripts/archive/zhuque-manual-inputs-v2-genres.txt";
const V2_RET_FILE = "scripts/archive/zhuque-calibration-v2.txt";

function parseV2(): Map<string, { text: string; pct: number; src: string; charsOk: boolean }> {
  const fileAbs = path.join(__dirname, "..", V2_FILE);
  const lines = fs.readFileSync(fileAbs, "utf8").split(/\r?\n/);
  const out = new Map<string, { text: string; pct: number; src: string; charsOk: boolean }>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HDR);
    if (!m) continue;
    const id = V2_MAP[m[1]] ?? m[1];
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (HDR.test(lines[j])) break;
      if (/^[━─=]+$/.test(lines[j].trim())) continue;
      body.push(lines[j]);
    }
    const text = body.join("\n").trim();
    out.set(id, {
      text,
      pct: NaN,
      src: `${V2_FILE}:${i + 1}`,
      charsOk: countChars(text) === Number(m[4]),
    });
  }
  // 官分：回传值那一行
  const retAbs = path.join(__dirname, "..", V2_RET_FILE);
  const retLines = fs.readFileSync(retAbs, "utf8").split(/\r?\n/);
  for (let i = 0; i < retLines.length; i++) {
    if (!retLines[i].includes("回传值")) continue;
    for (const m of retLines[i].matchAll(/([A-Za-z][A-Za-z0-9._-]*)\s*=\s*(\d+)/g)) {
      const id = V2_MAP[m[1]] ?? m[1];
      const rec = out.get(id);
      if (rec) {
        rec.pct = Number(m[2]);
        rec.src = `${V2_RET_FILE}:${i + 1}`;
      }
    }
  }
  return out;
}

/* ---------- v3 批次：TSV 有官分与文件名，但文本文件已不在仓库 ---------- */
const V3_MAP: Record<string, string> = {
  O2: "O2v3",
  O3: "O3v3",
  N2: "N2v3",
  D1: "D1v3",
  D2: "D2v3",
  H2: "H2v3",
};
const V3_FILE = "scripts/archive/calibration-input-v3.tsv";
function parseV3(): Map<string, { pct: number; src: string; missingFile: string }> {
  const abs = path.join(__dirname, "..", V3_FILE);
  const lines = fs.readFileSync(abs, "utf8").trim().split(/\r?\n/);
  const h = lines[0].split("\t");
  const fi = h.indexOf("file");
  const pi = h.indexOf("zhuqueOfficialPct");
  const out = new Map<string, { pct: number; src: string; missingFile: string }>();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    const id = V3_MAP[c[0]] ?? c[0];
    out.set(id, {
      pct: Number(c[pi]),
      src: `${V3_FILE}:${i + 1}`,
      missingFile: c[fi],
    });
  }
  return out;
}

/* ---------- v0.7 批次：O 系列，官分写在档案正文的对照行里 ---------- */
const V07_FILE = "scripts/archive/zhuque-calibration.txt";
function parseV07(): Map<string, { pct: number; src: string; text?: string }> {
  const abs = path.join(__dirname, "..", V07_FILE);
  const raw = fs.readFileSync(abs, "utf8");
  const lines = raw.split(/\r?\n/);
  const out = new Map<string, { pct: number; src: string; text?: string }>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\b(O[123])\s*\(x=\s*[\d.]+\s*官=(\d+)\)/);
    if (!m) continue;
    const id = m[1] === "O1" ? "O1" : m[1] === "O2" ? "O2v07" : "O3v07";
    out.set(id, { pct: Number(m[2]), src: `${V07_FILE}:${i + 1}` });
  }
  // O1 的原文单独存过档，能捞回来；O2/O3 是旧引擎产物，引擎早已不是当时那台，捞不回来
  const expo = path.join(__dirname, "archive", "EXPO_O1_RAW.txt");
  if (out.has("O1") && fs.existsSync(expo)) out.get("O1")!.text = fs.readFileSync(expo, "utf8");
  return out;
}

export function build(store: Store = DEFAULT_STORE, dry = false): number {
  const v2 = parseV2();
  const v3 = parseV3();
  const v07 = parseV07();
  const have = new Set(readLedger(store).map((r) => r.id));
  const rows: string[] = [];
  let sealed = 0;
  let skipped = 0;
  let bad = 0;

  for (const p of points) {
    const b = v2.get(p.id);
    const t3 = v3.get(p.id);
    const o = v07.get(p.id);
    let text: string | undefined;
    let pct: number;
    let src: string;
    if (b) {
      if (!b.charsOk) {
        rows.push(
          `❌ ${p.id}: 档案正文抽出 ${countChars(b.text)} 字与档案记录字数不符——不收，先查是谁抄漏了`,
        );
        bad++;
        continue;
      }
      text = b.text;
      pct = b.pct;
      src = b.src;
    } else if (o) {
      text = o.text;
      pct = o.pct;
      src = o.src;
    } else if (t3) {
      text = undefined;
      pct = t3.pct;
      src = t3.src;
    } else {
      rows.push(`❌ ${p.id}: 三处档案里都没有这个点的官分出处`);
      bad++;
      continue;
    }
    if (pct !== p.y) {
      rows.push(`❌ ${p.id}: 档案官分 ${pct} 与正本 y=${p.y} 不符——不收，两处必须一致`);
      bad++;
      continue;
    }
    if (have.has(p.id)) {
      rows.push(`⏭️  ${p.id}: 账本已有记录，跳过（append-only，不重复追加）`);
      skipped++;
      continue;
    }
    if (dry) {
      rows.push(
        `🔎 ${p.id}: 将回填 ${text ? "L1+L2（文本+转录）" : "L2（仅转录数字）"} 官分 ${pct}% 出处 ${src}`,
      );
      sealed++;
      continue;
    }
    const { rec, warnings } = sealRetro({ id: p.id, text, pct, proofSource: src }, store);
    rows.push(
      `✅ ${p.id}: ${rec.proof}  官分 ${rec.officialPct}%  ${rec.submitChars || 0} 字  出处 ${rec.proofSource}` +
        (warnings.length ? `  ⚠️ ${warnings.join("；")}` : ""),
    );
    sealed++;
  }
  for (const r of rows) console.log(r);
  console.log(
    `\n合计 ${points.length} 点：回填 ${sealed}${dry ? "（dry-run，未落盘）" : ""}、跳过 ${skipped}、拒收 ${bad}`,
  );
  if (!dry)
    console.log(
      "注意：回填只补到 L1/L2，**没有一张截图**，audit 仍把这批算作未认证、check:publish 照旧红。\n" +
        "      要升到认证只能重新送检：ZHUQUE_API_KEY=… npx tsx scripts/zhuque-api-score.ts <文本>",
    );
  return bad ? 1 : 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url)
  process.exit(build(DEFAULT_STORE, process.argv.includes("--dry-run")));
