/**
 * _publish-v0.9.18.cjs —— v0.9.18 的一键发布器（临时工具，下划线前缀同 _rotate-* 惯例）
 *
 * 为什么单独写一个：这一版卡在"产物已就绪、网络不通"的中间态——代码已提交、产物已重打校验、
 * zip 已打好，但 github.com 不可达，push 与 Release 都没做成。等网络恢复后不该再靠手敲一连串
 * 命令（手敲最容易漏掉"先 push 再发 Release"这个顺序），所以把整条链路固化下来：
 *   前置自检 → push → 建 Release（幂等）→ 上传 zip → 打印结果
 *
 * 用法：
 *   node scripts/_publish-v0.9.18.cjs --check   # 只做自检与网络探测，不推不发
 *   node scripts/_publish-v0.9.18.cjs           # 全流程
 *
 * 凭据：走本机 Git Credential Manager（`git credential fill`），**只在内存里流转**：
 * 不打印、不落盘。发布完成后本脚本可删除（或按项目惯例归档）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = "fengxingxuerong/clear";
const VERSION = "0.9.18";
const TAG = `v${VERSION}`;
const ROOT = path.join(__dirname, "..");
const ZIP = path.join(ROOT, "electron-dist", `QuAiWei-win32-x64-${TAG}.zip`);
const BUILD_INFO = path.join(ROOT, "electron-app", "build-info.json");

const CHECK_ONLY = process.argv.includes("--check");

const log = (...a) => console.log(...a);
const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const git = (args, opts = {}) =>
  execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf-8", ...opts }).trim();

/* ---------- 1. 前置自检 ---------- */
log("== [1] 前置自检 ==");

const info = JSON.parse(fs.readFileSync(BUILD_INFO, "utf-8"));
const head = git(["rev-parse", "--short", "HEAD"]);
const porcelain = git(["status", "--porcelain"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

log(`  产物章：version=${info.version} head=${info.head} dirty=${info.dirty} 指纹文件=${info.fingerprintFiles}`);
log(`  仓库：branch=${branch} HEAD=${head}`);

if (info.version !== VERSION) die(`产物版本 ${info.version} ≠ 目标 ${VERSION}，先跑 npm run build + repack`);
if (info.head !== head) die(`产物章 head=${info.head} ≠ 当前 HEAD=${head}，产物不是这次提交打的，先 repack`);
if (info.dirty) die("产物章 dirty=true —— 盖章时工作区有未提交改动，这份产物不对应任何提交，别发布");
// 产物章对应 HEAD 之后，只允许非指纹面的改动（文档 / 门禁脚本）。
// src/ 与 electron-app/ 进产物指纹，动了就必须重新 build + repack —— 那种情况下这里的
// head 比对也会先拦下来，但给一条更明确的提示。
if (porcelain) {
  const codeDirty = porcelain
    .split("\n")
    .filter((l) => /^\s*\S+\s+(src\/|electron-app\/)/.test(l));
  if (codeDirty.length) die(`进产物指纹的代码有未提交改动，先提交再 repack：\n${codeDirty.join("\n")}`);
  log(`  工作区另有非指纹面改动 ${porcelain.split("\n").length} 项（docs/README/scripts），不影响产物新鲜度`);
}
if (!fs.existsSync(ZIP)) die(`找不到交付包：${ZIP}`);
const zipMB = (fs.statSync(ZIP).size / 1048576).toFixed(1);
log(`  交付包：${path.basename(ZIP)}  ${zipMB} MB`);
log("  ✅ 自检通过\n");

/* ---------- 2. 网络探测（这版当初就是卡在这里） ---------- */
log("== [2] 网络探测 ==");
const net = require("net");
const probeTcp = (host, port, ms = 8000) =>
  new Promise((resolve) => {
    const s = net.connect(port, host);
    const done = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(ms);
    s.on("connect", () => done("ok"));
    s.on("timeout", () => done("timeout"));
    s.on("error", (e) => done(e.code || "error"));
  });

(async () => {
  const gh = await probeTcp("github.com", 443);
  const api = await probeTcp("api.github.com", 443);
  log(`  github.com:443      ${gh === "ok" ? "✅ 可达" : `❌ ${gh}`}`);
  log(`  api.github.com:443  ${api === "ok" ? "✅ 可达" : `❌ ${api}`}`);
  if (gh !== "ok") {
    log("\n  ⚠️  github.com:443 不可达 —— push 需要这个域，本机当前环境发不了。");
    log("     实测有效的绕过方式（2026-09-27）：代理只放行 api.github.com，github.com 走代理 502、直连超时。");
    log("     若代理恢复正常，可先 `echo $https_proxy` 现看端口再重试；不要盲目循环重试（会挂住）。");
    if (!CHECK_ONLY) die("网络不通，publish 中止（未做任何远端改动）");
  }
  if (CHECK_ONLY) {
    log("\n--check 模式：到此为止，未推未发。");
    return;
  }

  /* ---------- 3. push ---------- */
  log("\n== [3] push master ==");
  try {
    execFileSync("git", ["-C", ROOT, "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=15",
      "push", "origin", branch], { stdio: "inherit" });
  } catch {
    die("push 失败。不要改用上游仓库/协议绕过，先修网络；确认远端成功的可靠通道是 `git ls-remote origin refs/heads/master`");
  }
  const remoteSha = git(["ls-remote", "origin", `refs/heads/${branch}`]).split(/\s/)[0];
  if (!remoteSha.startsWith(head)) die(`推送后远端 sha ${remoteSha.slice(0, 7)} ≠ 本地 HEAD ${head}，别继续发 Release`);
  log(`  ✅ 远端 ${branch} = ${remoteSha.slice(0, 7)}`);

  /* ---------- 4. 取凭据（只在内存） ---------- */
  const cred = execFileSync("git", ["credential", "fill"],
    { input: "protocol=https\nhost=github.com\n\n", encoding: "utf-8" });
  const token = (cred.match(/^password=(.+)$/m) || [])[1];
  if (!token) die("没取到 GitHub 凭据（Git Credential Manager 里没有？）");

  const apiCall = async (method, url, body) => {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "quaiwei-publish",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };

  /* ---------- 5. 建 Release（幂等：已存在就复用） ---------- */
  log(`\n== [4] Release ${TAG} ==`);
  let release;
  try {
    release = await apiCall("GET", `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
    log(`  已存在，复用 id=${release.id}`);
  } catch {
    release = await apiCall("POST", `https://api.github.com/repos/${REPO}/releases`, {
      tag_name: TAG,
      target_commitish: branch,
      name: TAG,
      body: `见 [CHANGELOG.md](https://github.com/${REPO}/blob/${branch}/CHANGELOG.md) 的 v${VERSION} 章节。\n\n` +
        "本版无新功能：结清 v0.9.17 之后的 6 个未发布提交（含 CLI `--base-url` 前缀坑拦截），并修正 README 版本号口径。",
    });
    log(`  已创建 id=${release.id}`);
  }

  /* ---------- 6. 上传 zip ---------- */
  const existing = await apiCall("GET", `https://api.github.com/repos/${REPO}/releases/${release.id}/assets`);
  const name = path.basename(ZIP);
  const dup = existing.find((a) => a.name === name);
  if (dup) {
    log(`\n== [5] 资源 ${name} 已存在（${(dup.size / 1048576).toFixed(1)} MB），跳过上传`);
  } else {
    log(`\n== [5] 上传 ${name}（${zipMB} MB）==`);
    const buf = fs.readFileSync(ZIP); // 实测一次性 Buffer 上传可行
    const upRes = await fetch(
      `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "quaiwei-publish",
          "Content-Type": "application/zip",
        },
        body: buf,
      });
    const upText = await upRes.text();
    if (!upRes.ok) die(`上传失败 → ${upRes.status} ${upText.slice(0, 300)}`);
    log(`  ✅ 上传完成：${JSON.parse(upText).browser_download_url}`);
  }

  log(`\n🎉 ${TAG} 发布完成：https://github.com/${REPO}/releases/tag/${TAG}`);
  log("   收尾：把 README 下载行的 v0.9.17 改成 v0.9.18（发版后才改，否则点进去 404），再提交推送。");
})();
