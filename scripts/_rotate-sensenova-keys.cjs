// SenseNova Key 轮换批量替换脚本（docs/key-rotation-status.md runbook 第 2 步自动化）
//
// 用法：
//   演练（不写盘）：node scripts/_rotate-sensenova-keys.cjs --new-file <新Key文件>
//   实际执行：      node scripts/_rotate-sensenova-keys.cjs --new-file <新Key文件> --apply
//   报告清洗（runbook 第 5 步，删旧 Key 之后）：node scripts/_rotate-sensenova-keys.cjs --scrub-reports [--apply]
//
// 安全纪律：
//   - 全程不打印任何 Key 明文，只输出 sha256 前 12 位（哈希非秘密，基准在 docs/key-rotation-status.md）
//   - --apply 写前把目标文件备份到 electron-dist/_rotbk/（gitignore 覆盖区域，不新增明文面）
//   - scripts/.sensenova-keys 由用户手动放新 Key，本脚本不碰它
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OLD_HASHES = ["e38fb0a1e798", "b82265ead297", "e1e896e7b77d"]; // 固定映射顺序：旧[i] → 新[i]
const SK = /sk-[A-Za-z0-9]{16,}/g;
const BK = "D:/projects/quaiwei/electron-dist/_rotbk";
const TARGETS = [
  "D:/projects/prompt-master/.env",
  "D:/projects/prompt-master/.env.bak-20260917",
  "D:/projects/prompt-master/.env.bak-20260918",
  "D:/projects/prompt-master/.env.bak-20260918-judges",
  "D:/projects/sqli-scanner/server/.env.ai",
];
const REPORTS = [
  "D:/deep/agent-audit-reports/index.html",
  "D:/deep/agent-audit-reports/data/2026-08-15.json",
  "D:/deep/agent-audit-reports/data/2026-07-08.json",
];
// 报告里已知的凭证哈希（e38f=旧 SenseNova Key；174c/4535=agent 会话正文里的其它凭证，收尾一并抹除）
const REPORT_HASHES = ["e38fb0a1e798", "174c9e2f2a80", "4535b7066bc3"];

const hashOf = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes("--apply");

function loadNewKeys(file) {
  const keys = [...new Set(
    fs.readFileSync(file, "utf-8")
      .split(/[\n,;，；]+/)
      .map((k) => k.trim())
      .filter((k) => /^sk-[A-Za-z0-9]{16,}$/.test(k)),
  )];
  if (keys.length !== 3) {
    console.error(`✗ 新 Key 文件应含 3 条 sk- 形态 Key，实际 ${keys.length} 条（哈希：${keys.map(hashOf).join(" ")}）`);
    process.exit(1);
  }
  return keys;
}

// 收集目标文件里现存的旧 Key 明文（按固定哈希顺序对齐）
function collectOldKeys() {
  const found = new Map(); // hash -> 明文
  for (const f of TARGETS) {
    const text = fs.readFileSync(f, "utf-8");
    for (const m of text.matchAll(SK)) {
      const h = hashOf(m[0]);
      if (OLD_HASHES.includes(h)) found.set(h, m[0]);
    }
  }
  const missing = OLD_HASHES.filter((h) => !found.has(h));
  if (missing.length) {
    console.error(`✗ 目标文件中找不到旧 Key 哈希：${missing.join(" ")}（可能已被换过？先跑扫描确认现状）`);
    process.exit(1);
  }
  return OLD_HASHES.map((h) => found.get(h)); // 明文，按 OLD_HASHES 顺序
}

function rotate(newKeys, oldKeys) {
  const map = new Map(); // 旧明文 → 新明文
  OLD_HASHES.forEach((h, i) => map.set(oldKeys[i], newKeys[i]));
  console.log(`映射（按哈希）：${OLD_HASHES.map((h, i) => `${h}→${hashOf(newKeys[i])}`).join("  ")}`);
  for (const f of TARGETS) {
    const text = fs.readFileSync(f, "utf-8");
    const lines = text.split(/\r?\n/);
    let count = 0;
    const changedLines = [];
    const out = lines.map((ln, i) => {
      let hit = 0;
      const nl = ln.replace(SK, (k) => {
        if (!map.has(k)) return k;
        hit++;
        return map.get(k);
      });
      if (hit) {
        count += hit;
        changedLines.push(i + 1);
      }
      return nl;
    });
    console.log(`${APPLY ? "✎ 替换" : "☞ 计划"} ${f}：${count} 处 @L${changedLines.join(",L")}`);
    if (APPLY && count) {
      fs.mkdirSync(BK, { recursive: true });
      fs.copyFileSync(f, path.join(BK, path.basename(f) + ".pre-rotation"));
      // 保持原文件的换行风格（CRLF 文件统一回 LF 会造成全文件差异）
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      fs.writeFileSync(f, out.join(eol), "utf-8");
    }
  }
}

function verify() {
  console.log("-- 复扫（旧哈希应 0 命中）--");
  let bad = 0;
  for (const f of TARGETS) {
    const text = fs.readFileSync(f, "utf-8");
    const olds = [...text.matchAll(SK)].filter((m) => OLD_HASHES.includes(hashOf(m[0])));
    if (olds.length) {
      bad += olds.length;
      console.log(`  ⚠️ ${f} 仍有 ${olds.length} 处旧 Key`);
    } else {
      console.log(`  ✅ ${f} 0 命中`);
    }
  }
  console.log(bad ? `❌ ${bad} 处未清` : "✅ 全部目标文件旧 Key 清零");
}

function scrubReports() {
  for (const f of REPORTS) {
    const text = fs.readFileSync(f, "utf-8");
    let count = 0;
    const out = text.replace(SK, (k) => {
      if (!REPORT_HASHES.includes(hashOf(k))) return k;
      count++;
      return "***REMOVED***";
    });
    console.log(`${APPLY ? "✎ 抹除" : "☞ 计划"} ${f}：${count} 处`);
    if (APPLY && count) {
      fs.mkdirSync(BK, { recursive: true });
      fs.copyFileSync(f, path.join(BK, path.basename(f) + ".pre-scrub"));
      fs.writeFileSync(f, out, "utf-8");
    }
  }
}

if (process.argv.includes("--scrub-reports")) {
  console.log(`模式：报告凭证清洗（${APPLY ? "APPLY" : "dry-run"}）——抹除哈希 ${REPORT_HASHES.join(" ")}`);
  scrubReports();
} else {
  const nf = arg("--new-file");
  if (!nf) {
    console.error("用法：--new-file <新Key文件> [--apply]  或  --scrub-reports [--apply]");
    process.exit(1);
  }
  const newKeys = loadNewKeys(nf);
  console.log(`模式：Key 批量替换（${APPLY ? "APPLY" : "dry-run"}）；新 Key 哈希：${newKeys.map(hashOf).join(" ")}`);
  const oldKeys = collectOldKeys();
  rotate(newKeys, oldKeys);
  if (APPLY) verify();
  else console.log("(dry-run 未写盘；确认计划无误后加 --apply 执行)");
}
