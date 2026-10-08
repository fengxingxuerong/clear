/**
 * _publish.cjs —— 一键发布器（通用版：版本号从 package.json 现读，不再每次复制改号）
 *
 * 用法：
 *   node scripts/_publish.cjs --check   # 只自检 + 网络探测，不推不发
 *   node scripts/_publish.cjs           # 全流程：自检 → push → 建 Release（幂等）→ 上传 zip
 *
 * 顺序为什么是 push 在前：Release 的 tag 必须指向**已推送的** commit，
 * 先发 Release 会得到一个指向旧 master 的 tag（假发）。
 *
 * 凭据：走本机 Git Credential Manager（`git credential fill`），只在内存流转：
 * 不打印、不落盘。发布完成后本脚本可归档（scripts/archive/）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const REPO = "fengxingxuerong/clear";
const ROOT = path.join(__dirname, "..");
const { version: VERSION } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const TAG = `v${VERSION}`;
const ZIP = path.join(ROOT, "electron-dist", `QuAiWei-win32-x64-${TAG}.zip`);
const BUILD_INFO = path.join(ROOT, "electron-app", "build-info.json");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");

/** Node 的 fetch **不读** http_proxy；Node 22.22 起可用这个开关让它走环境代理。
 *  本机网络需要它才能碰到 api.github.com。显式开着，免得哪次又连不上。 */
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || "1";

const CHECK_ONLY = process.argv.includes("--check");

const log = (...a) => console.log(...a);
const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
/**
 * 跑一条 git 命令（异步）。
 *
 * ⚠️ 为什么不用 `execFileSync`（2026-10-09 改的）：本机把 Node 的**同步**子进程派生整体挡下，
 * `spawnSync git` 一律返回 `EBUSY`（git / node / cmd.exe 全灭），而异步 `spawn` 完全正常。
 * 发布器之前直接在第一句 `git rev-parse` 上炸退——连自检都跑不到，于是"网络问题/产物过期/
 * 环境限制"三种情况的输出长得一模一样。派生失败必须能被**区分**：这里用非 0 退出码 + stderr 报出真实原因。
 *
 * @param {string[]} args
 * @param {{input?: string, inherit?: boolean, env?: NodeJS.ProcessEnv}} [opts]
 *   input = 写进 stdin（credential fill 用）；inherit = 直接把 stdio 接到本进程（push 的进度要看见）
 * @returns {Promise<string>} trim 过的 stdout
 */
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const stdio = [
      opts.input === undefined ? "ignore" : "pipe",
      opts.inherit ? "inherit" : "pipe",
      opts.inherit ? "inherit" : "pipe",
    ];
    let out = "";
    let err = "";
    const child = spawn("git", ["-C", ROOT, ...args], { stdio, env: opts.env });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    if (child.stdout) {
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (d) => {
        out += d;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (d) => {
        err += d;
      });
    }
    child.on("error", (e) => reject(new Error(`派生 git 失败：${e.code || e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args.join(" ")} → 退出码 ${code}\n${err.trim()}`));
    });
  });
}

/** 从 CHANGELOG 抽出本版章节正文（GitHub 支持 markdown，直接当 release notes） */
function changelogBody(tag) {
  const md = fs.readFileSync(CHANGELOG, "utf-8");
  const start = md.indexOf(`## ${tag} 更新`);
  if (start < 0) return null;
  const next = md.indexOf("\n## ", start + 4);
  const body = md.slice(start, next < 0 ? undefined : next);
  const trimmed =
    body.length > 6000 ? body.slice(0, 6000) + "\n\n…（完整内容见仓库 CHANGELOG.md）" : body;
  return (
    trimmed +
    `\n\n---\n\n完整历史见 [CHANGELOG.md](https://github.com/${REPO}/blob/master/CHANGELOG.md)。`
  );
}

/* ---------- 1. 前置自检（异步：要在 async 上下文里取 git 状态） ---------- */
// CJS 没有顶层 await，所以自检整段包成一个 async 函数，由下面的 IIFE 第一步调用。
let head;
let branch;
let body;
let zipMB;

async function precheck() {
  log(`== [1] 前置自检（目标 ${TAG}） ==`);

  const info = JSON.parse(fs.readFileSync(BUILD_INFO, "utf-8"));
  head = await git(["rev-parse", "--short", "HEAD"]);
  branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = await git(["status", "--porcelain"]);

  log(
    `  产物章：version=${info.version} head=${info.head} dirty=${info.dirty} 指纹文件=${info.fingerprintFiles}`,
  );
  log(`  仓库：branch=${branch} HEAD=${head}`);

  if (info.version !== VERSION)
    die(`产物版本 ${info.version} ≠ package.json 的 ${VERSION}，先跑 npm run build + repack`);
  if (info.head !== head)
    die(`产物章 head=${info.head} ≠ 当前 HEAD=${head}，产物不是这次提交打的，先 repack`);
  if (info.dirty)
    die("产物章 dirty=true —— 盖章时工作区有未提交改动，这份产物不对应任何提交，别发布");

  if (porcelain) {
    const codeDirty = porcelain
      .split("\n")
      .filter((l) => /^\s*\S+\s+(src\/|electron-app\/)/.test(l));
    if (codeDirty.length)
      die(`进产物指纹的代码有未提交改动，先提交再 repack：\n${codeDirty.join("\n")}`);
    log(
      `  工作区另有非指纹面改动 ${porcelain.split("\n").length} 项（docs/README/scripts），不影响产物新鲜度`,
    );
  }

  body = changelogBody(TAG);
  if (!body) die(`CHANGELOG.md 里找不到「## ${TAG} 更新」章节 —— 发版前先写更新日志`);
  log(`  Release 说明：取自 CHANGELOG ${TAG} 章节（${body.length} 字）`);

  if (!fs.existsSync(ZIP)) die(`找不到交付包：${ZIP}\n  先打：node artifacts/_make-zip.cjs`);
  zipMB = (fs.statSync(ZIP).size / 1048576).toFixed(1);
  log(`  交付包：${path.basename(ZIP)}  ${zipMB} MB`);
  log("  ✅ 自检通过\n");
}

/* ---------- 2. 网络探测 ---------- */
log("== [2] 网络探测 ==");
const probeTcp = (host, port, ms = 8000) =>
  new Promise((resolve) => {
    const s = net.connect(port, host);
    const done = (r) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(ms);
    s.on("connect", () => done("ok"));
    s.on("timeout", () => done("timeout"));
    s.on("error", (e) => done(e.code || "error"));
  });

(async () => {
  await precheck();

  const gh = await probeTcp("github.com", 443);
  const api = await probeTcp("api.github.com", 443);
  log(`  github.com:443      ${gh === "ok" ? "✅ 可达" : `❌ ${gh}`}`);
  log(`  api.github.com:443  ${api === "ok" ? "✅ 可达" : `❌ ${api}`}`);
  if (gh !== "ok") {
    log(
      "\n  ⚠️  github.com:443 不可达 —— **git push** 需要这个域（TCP 可达也不代表 TLS/握得成）。",
    );
    log("     本机实测过：代理放行 api.github.com、对 github.com 返回 502、直连超时。");
    log("     ⇒ 此时先 `node scripts/_api-push.cjs`（走 Git Data API 推提交），");
    log("       远端同步后再回来发版。别盲目循环重试 push（会挂住十几分钟）。");
  }
  if (CHECK_ONLY) {
    log("\n--check 模式：到此为止，未推未发。");
    return;
  }

  /* ---------- 3. 取凭据（只在内存）——提前：核对远端不再依赖 git ls-remote ---------- */
  const cred = await git(["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n" });
  const token = (cred.match(/^password=(.+)$/m) || [])[1];
  if (!token) die("没取到 GitHub 凭据（Git Credential Manager 里没有？）");

  const apiCall = async (method, url, payload) => {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "quaiwei-publish",
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };

  /* ---------- 4. push（远端已同步则跳过） ---------- */
  log(`\n== [3] push ${branch} ==`);
  const localHead = await git(["rev-parse", "HEAD"]);
  const remoteRef = async () =>
    (await apiCall("GET", `https://api.github.com/repos/${REPO}/git/ref/heads/${branch}`)).object
      .sha;
  const remoteBefore = await remoteRef();
  if (remoteBefore === localHead) {
    log("  远端已是最新，跳过 push");
  } else {
    // 本机环境实测（2026-09-27）：代理对 github.com 返回 502、直连反而正常。
    // 但环境会变，所以两条路都试：先清掉代理环境变量直连，失败再交给 git 自己读环境里的代理。
    const noProxyEnv = { ...process.env };
    for (const k of [
      "https_proxy",
      "HTTPS_PROXY",
      "http_proxy",
      "HTTP_PROXY",
      "all_proxy",
      "ALL_PROXY",
    ])
      delete noProxyEnv[k];
    // git() 自己会带 -C ROOT，这里只需要额外参数
    const common = [
      "-c",
      "http.lowSpeedLimit=1000",
      "-c",
      "http.lowSpeedTime=15",
      "push",
      "origin",
      branch,
    ];
    let ok = false;
    for (const [label, env, extra] of [
      ["直连（已清代理变量）", noProxyEnv, ["-c", "http.proxy=", "-c", "https.proxy="]],
      ["走环境代理", process.env, []],
    ]) {
      if (ok) break;
      log(`  尝试 ${label}…`);
      try {
        // stdio 接出来，push 的百分比进度要看得见（等待时不知道是在传还是在挂）
        await git([...extra, ...common], { env, inherit: true });
        ok = true;
      } catch (e) {
        log(`  ✗ ${label} 失败：${String(e.message).split("\n")[0]}`);
      }
    }
    if (!ok)
      die(
        "push 失败。可改用 `node scripts/_api-push.cjs`（Git Data API）推完再回来发版；不要改用其它协议/上游绕过",
      );
  }
  const remoteSha = await remoteRef();
  if (remoteSha !== localHead)
    die(
      `推送后远端 ${remoteSha.slice(0, 7)} ≠ 本地 HEAD ${localHead.slice(0, 7)}，别继续发 Release`,
    );
  log(`  ✅ 远端 ${branch} = ${remoteSha.slice(0, 7)}（经 API 核对，不依赖 git ls-remote）`);

  /* ---------- 5. 建 Release（幂等） ---------- */
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
      body,
    });
    log(`  已创建 id=${release.id}`);
  }

  /* ---------- 6. 上传 zip ---------- */
  const name = path.basename(ZIP);
  const assets = await apiCall(
    "GET",
    `https://api.github.com/repos/${REPO}/releases/${release.id}/assets`,
  );
  const dup = assets.find((a) => a.name === name);
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
      },
    );
    const upText = await upRes.text();
    if (!upRes.ok) die(`上传失败 → ${upRes.status} ${upText.slice(0, 300)}`);
    log(`  ✅ 上传完成：${JSON.parse(upText).browser_download_url}`);
  }

  log(`\n🎉 ${TAG} 发布完成：https://github.com/${REPO}/releases/tag/${TAG}`);
  log(`   收尾：把 README 下载行的版本号改成 ${VERSION}，再提交推送。`);
})();
