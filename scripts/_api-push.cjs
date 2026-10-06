"use strict";
/**
 * _api-push.cjs —— 当 git-over-HTTPS 走不通时，用 **GitHub Git Data API** 完成 push
 *
 * ## 为什么需要它
 *
 * 本机的出站网络有选择性：代理放行 `api.github.com` / `uploads.github.com`，
 * 但对 `github.com:443` 的 CONNECT 返回 **502**（直接以 https-push 方式跑道就断），
 * 而直连 TCP 又超时。于是 `git push` 两条路都是死的，Release 反而发得出去。
 *
 * 结果是很坑的一种状态：**Release 能发、源码推不上去** —— 而 tag 会指向远端的旧 HEAD，
 * 产物里的 `build-info.json` 却盖着本地新 HEAD ⇒ 自相矛盾，必须禁止那样发布。
 *
 * ## 做法
 *
 * 逐个 commit 复刻到远端：`blobs → trees → commits → update-ref`。
 * 关键点：**author / committer 的 name / email / date 与 message 全部照抄**，
 * 这样算出来的 commit sha 与本地**逐位相同**（实测通过），
 * ⇒ 推完 `git ls-remote` 返回的 sha 与 HEAD 一致，本地侧 `git status` 仍是 up-to-date，
 * 不会 divergent（这是"用 API 重放提交"唯一的正确姿势；少复制一个字段就会分叉）。
 *
 * tree 用 `base_tree` 增量构造；文件内容一律走 `git cat-file blob` 取**仓库内的字节**，
 * 不用工作区文件（避免 CRLF 转换让 blob sha 对不上）。
 *
 * ## 用法
 *
 *   export NODE_USE_ENV_PROXY=1          # Node fetch 的代理开关（22.22 起支持，实验性）
 *   node scripts/_api-push.cjs [--dry]
 *
 * `--dry` 只打印将要推送的 commit 与文件，不写远端。
 *
 * ⚠️ 凭据只走内存（`git credential fill` 读 OAuth token），**不落盘、不打印**。
 */
const { execFileSync } = require("child_process");

const REPO = "fengxingxuerong/clear";
const REPO_PATH = "D:/projects/quaiwei";
const BRANCH = "master";
const DRY = process.argv.includes("--dry");

process.env.NODE_USE_ENV_PROXY = "1";

function git(args) {
  return execFileSync("git", ["-C", REPO_PATH, ...args], { encoding: "utf8" }).trim();
}
function gitBlob(args) {
  return execFileSync("git", ["-C", REPO_PATH, ...args], { encoding: "buffer" });
}

/**
 * 取 commit 的 message —— **必须是仓库里的精确字节**。
 *
 * ⚠️ 踩过的坑（正是它导致第一次 API 推送分叉）：用 `git log --format=%B` 再 `trim()`
 * 会吃掉 message 尾部的换行，而 message 是 commit sha 的入参之一 ⇒
 * tree / parents / author / committer 全对了，commit sha 照样对不上。
 * 正确做法是直接读 `git cat-file commit <sha>`，取第一个空行之后的全部字节。
 */
function gitMessage(c) {
  const raw = gitBlob(["cat-file", "commit", c]).toString("utf8");
  const i = raw.indexOf("\n\n");
  if (i < 0) throw new Error(`cat-file commit 结构异常：${c}`);
  return raw.slice(i + 2);
}

async function getToken() {
  const out = execFileSync(
    "git",
    ["credential", "fill"],
    { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" },
  );
  const m = out.match(/password=(.+)/);
  if (!m) throw new Error("credential fill 里没有 password —— 无法调用 API");
  return m[1].trim();
}

async function api(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 300);
    throw new Error(`${method} ${path} → ${res.status} ${t}`);
  }
  return res.status === 204 ? null : res.json();
}

(async () => {
  const token = await getToken();

  const probe = await api(token, "GET", "/");
  if (!probe) throw new Error("连不上 api.github.com");

  const ref = await api(token, "GET", `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const remoteSha = ref.object.sha;

  // --reset <sha>：把远端 ref 强指回某个 commit（清理误推 / 回滚用）
  const ri = process.argv.indexOf("--reset");
  if (ri >= 0) {
    const target = process.argv[ri + 1];
    if (!target) throw new Error("--reset 需要一个 sha");
    await api(token, "PATCH", `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: target, force: true });
    const now = await api(token, "GET", `/repos/${REPO}/git/ref/heads/${BRANCH}`);
    console.log(`远端 ${BRANCH} 已强指到 ${now.object.sha.slice(0, 7)}（目标 ${target.slice(0, 7)}）`);
    return;
  }

  const localHead = git(["rev-parse", "HEAD"]);
  console.log(`远端 ${BRANCH}=${remoteSha.slice(0, 7)}  本地 HEAD=${localHead.slice(0, 7)}`);

  if (remoteSha === localHead) {
    console.log("✅ 远端已是最新，无需推送");
    return;
  }
  if (DRY) console.log("（--dry：以下只预览，不写远端）");

  const alreadyContains = await api(token, "GET", `/repos/${REPO}/commits/${localHead}`)
    .then(() => true)
    .catch(() => false);
  if (alreadyContains) {
    console.log("✅ 远端已包含 HEAD（只是 ref 落后），直接更新 ref");
    if (!DRY) await api(token, "PATCH", `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: localHead });
    return;
  }

  const commits = git(["rev-list", "--reverse", "--topo-order", `${remoteSha}..HEAD`])
    .split("\n")
    .filter(Boolean);
  console.log(`待推送 ${commits.length} 个 commit`);

  for (const c of commits) {
    const meta = git(["log", "-1", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", c]).split("\0");
    const [an, ae, ad, cn, ce, cd] = meta;
    const msg = gitMessage(c);
    const parent = git(["rev-parse", `${c}^`]);
    const baseTree = git(["rev-parse", `${parent}^{tree}`]);
    const subj = msg.split("\n")[0].slice(0, 60);

    const raw = git(["diff", "--name-status", "--no-renames", "-z", parent, c]);
    const entries = raw
      .split("\0")
      .filter(Boolean)
      .reduce((acc, cur, i, arr) => {
        if (i % 2 === 0) acc.push({ status: cur.trim(), path: arr[i + 1] });
        return acc;
      }, []);

    const tree = [];
    for (const e of entries) {
      if (e.status === "D") {
        tree.push({ path: e.path, mode: "100644", type: "blob", sha: null });
        console.log(`   - ${e.path}`);
        continue;
      }
      const mode = git(["ls-tree", c, "--", e.path]).split(/\s+/)[0];
      if (mode !== "100644" && mode !== "100755") {
        throw new Error(`未处理的 mode=${mode}（${e.path}）：符号链接/子模块请先手工处理`);
      }
      const buf = gitBlob(["cat-file", "blob", `${c}:${e.path}`]);
      let blobSha;
      if (!DRY) {
        const bres = await api(token, "POST", `/repos/${REPO}/git/blobs`, {
          content: buf.toString("base64"),
          encoding: "base64",
        });
        blobSha = bres.sha;
      }
      tree.push({ path: e.path, mode, type: "blob", sha: blobSha ?? "(dry)" });
      console.log(`   ${e.status === "A" ? "+" : "M"} ${e.path}  ${(buf.length / 1024).toFixed(1)} KB`);
    }

    console.log(`→ ${subj}`);
    if (DRY) continue;

    const tres = await api(token, "POST", `/repos/${REPO}/git/trees`, { base_tree: baseTree, tree });
    const cres = await api(token, "POST", `/repos/${REPO}/git/commits`, {
      message: msg,
      tree: tres.sha,
      parents: [parent],
      author: { name: an, email: ae, date: ad },
      committer: { name: cn, email: ce, date: cd },
    });
    await api(token, "PATCH", `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: cres.sha });
    if (cres.sha !== c) {
      console.error(
        `✗ commit sha 不一致：本地 ${c.slice(0, 7)} vs 远端 ${cres.sha.slice(0, 7)}\n` +
          `  通常是 author/committer 元数据没抄全，会导致 history divergent —— 已停止推送，请人工处理。`,
      );
      process.exit(1);
    }
    console.log(`   ✅ ${cres.sha.slice(0, 7)}（与本地逐位相同）`);
  }

  const after = await api(token, "GET", `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  console.log(`推送后远端 ${BRANCH}=${after.object.sha.slice(0, 7)}  本地 HEAD=${localHead.slice(0, 7)}`);
  console.log(after.object.sha === localHead ? "✅ 一致" : "❌ 不一致，别发布，先查");
})().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
