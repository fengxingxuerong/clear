// 一次性脚本：Key 轮换前置——泄露面现状重扫（输出只含哈希前 12 位与计数，绝无明文）
// 旧 Key 哈希基准来自 docs/key-rotation-status.md（哈希非秘密，可留在文档）
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OLD_HASHES = new Set(["b82265ead297", "e38fb0a1e798", "e1e896e7b77d"]);
const SK = /sk-[A-Za-z0-9]{16,}/g;

function hashOf(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function scanFile(f) {
  if (!fs.existsSync(f)) return console.log(`  [缺失] ${f}`);
  const lines = fs.readFileSync(f, "utf-8").split(/\r?\n/);
  let hits = 0;
  const seen = new Map();
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(SK)) {
      hits++;
      const h = hashOf(m[0]);
      if (!seen.has(h)) seen.set(h, []);
      seen.get(h).push(i + 1);
    }
  });
  if (!hits) return console.log(`  [0 命中] ${f}`);
  const detail = [...seen.entries()]
    .map(([h, lns]) => `${h}${OLD_HASHES.has(h) ? "(旧Key)" : "(⚠️未知)"}@L${lns.join(",L")}`)
    .join("  ");
  console.log(`  [${hits} 处] ${f}\n    ${detail}`);
}

function scanDirGlob(dir, test, label) {
  if (!fs.existsSync(dir)) return console.log(`  [目录缺失] ${dir}`);
  const found = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && test(e.name)) found.push(path.join(dir, e.name));
  }
  console.log(`  ${label}: ${found.length} 个文件`);
  for (const f of found) scanFile(f);
}

console.log("== 1. 三处设计内配置文件 ==");
scanFile("D:/projects/quaiwei/scripts/.sensenova-keys");
scanFile("D:/projects/prompt-master/.env");
scanFile("D:/projects/sqli-scanner/server/.env.ai");

console.log("== 2. prompt-master 的 .env 备份副本（手册 09-19 记录有 3 个 .bak-*，09-25 记录已不存在，以实测为准） ==");
scanDirGlob("D:/projects/prompt-master", (n) => /^\.env/.test(n), ".env* 文件");

console.log("== 3. 审计报告目录 ==");
const auditDir = "D:/deep/agent-audit-reports";
if (fs.existsSync(auditDir)) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(json|html|js|md|txt)$/i.test(e.name)) scanFile(p);
    }
  };
  walk(auditDir);
} else {
  console.log("  [目录缺失] " + auditDir);
}

console.log("== 4. quaiwei 仓库跟踪内容（期望 0 命中） ==");
const { execSync } = require("child_process");
try {
  const out = execSync("git grep -nE 'sk-[A-Za-z0-9]{16,}' -- .", {
    cwd: "D:/projects/quaiwei",
    encoding: "utf-8",
  });
  console.log(out ? `  ⚠️ 命中：\n${out.split("\n").map((l) => l.replace(SK, "<masked>")).join("\n")}` : "  0 命中");
} catch {
  console.log("  0 命中");
}
