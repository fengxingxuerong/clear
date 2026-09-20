/**
 * build-fingerprint.cjs —— 给"打进产物的那部分源码"算指纹，用来证明产物来自当前代码树
 *
 * 为什么需要它（2026-09-20 实测到的洞）：verify-pruned 原来只比 `package.json` 版本号，
 * 而版本号要等发版才动。结果是桌面产物已经落后 7 个提交、里面**还带着刚修掉的两个病句
 * 和「检测器故障被读成 0 分=完全人类」那个 bug**，自检却全绿——因为它查的恰好是不变的那部分。
 *
 * 语义要点：**指纹必须在 `npm run build` 那一刻盖章**，不能等到 repack 时再算。
 * 否则"只 repack 不 build"会把**新**源码指纹配着**旧** bundle 记进产物，检查直接失效。
 * 所以盖章动作放在 scripts/sync-dist.mjs（build 链的最后一环）里，
 * rebuild-app 只负责把 electron-app/build-info.json 原样搬进 resources/app。
 *
 * 覆盖范围刻意只包含"真的会进产物"的东西：
 *   src/ 与前端入口、Electron 主进程脚本、随包文档、构建同步脚本本身。
 * scripts/ 下的门禁、docs/、evidence/ 不进产物，改了不该判产物过期——
 * 一个天天误报的检查，最后一定被人 --no-verify 掉。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** 分组定义：group 名 → 该组要覆盖的仓库内相对路径（目录会递归） */
const GROUPS = {
  src: ["src"],
  "web-entry": ["index.html", "vite.config.ts", "package.json", "package-lock.json", "tsconfig.json"],
  "electron-main": [
    "electron-app/main.js",
    "electron-app/preload.js",
    "electron-app/ppl-engine.cjs",
    "electron-app/package.json",
    "electron-app/使用说明.txt",
  ],
  "build-step": ["scripts/sync-dist.mjs"],
};

/** 与产物无关、但可能混进目录的噪声 */
const SKIP_RE = /(node_modules|(^|[\\/])\.DS_Store$|[~]$)/;

function walk(abs, base, out) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return out;
  }
  if (st.isFile()) {
    if (!SKIP_RE.test(abs)) out.push(path.relative(base, abs).split(path.sep).join("/"));
    return out;
  }
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    walk(path.join(abs, e.name), base, out);
  }
  return out;
}

const sha256file = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/**
 * @param {string} repoRoot 仓库根目录绝对路径
 * @returns {{combined:string, groups:Record<string,string>, files:number, builtAt?:string}}
 */
function fingerprint(repoRoot) {
  const groups = {};
  let files = 0;
  for (const [name, entries] of Object.entries(GROUPS)) {
    const rows = [];
    for (const rel of entries) {
      const abs = path.join(repoRoot, rel);
      const found = fs.existsSync(abs) ? walk(abs, repoRoot, []) : null;
      if (!found || found.length === 0) {
        rows.push(`${rel}!<缺失>`);
        continue;
      }
      for (const r of found.sort()) {
        rows.push(`${r}=${sha256file(path.join(repoRoot, r))}`);
        files++;
      }
    }
    groups[name] = crypto.createHash("sha256").update(rows.join("\n")).digest("hex");
  }
  const combined = crypto
    .createHash("sha256")
    .update(Object.keys(groups).sort().map((k) => `${k}=${groups[k]}`).join("\n"))
    .digest("hex");
  return { combined, groups, files };
}

/** 比对两份指纹，返回**变了哪几组**（给报错用，别只说"不一致"） */
function diffGroups(recorded, current) {
  const changed = [];
  for (const name of Object.keys(GROUPS)) {
    const a = (recorded.groups || {})[name];
    const b = current.groups[name];
    if (a !== b) changed.push(a === undefined ? `${name}(产物里没记)` : name);
  }
  return changed;
}

module.exports = { fingerprint, diffGroups, GROUPS };
