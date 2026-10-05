/**
 * build-stamp.mjs —— 构建指纹的「盖章判定」部分（无副作用，可被单测直接导入）
 *
 * ## 为什么要单独拆一个文件（2026-10-05 实测踩出来的）
 *
 * `readGitState` 原本住在 sync-dist.mjs 里。单测要测它就得 `import "./sync-dist.mjs"`，
 * 而那个模块是**顶层即执行**的：复制 dist、注入 CSP、盖指纹章、可能 `process.exit(1)`。
 * 于是「导入来测一个纯函数」变成了「跑一次完整 build 链」——测试要么污染工作区，
 * 要么直接被 exit 掉。这不是测试写法问题，是模块边界没划对：
 * **判定逻辑与执行副作用混在一个文件里，纯的那半就永远没法单独验。**
 *
 * 所以拆开：这里只放纯判定（读 git、算 dirty），sync-dist.mjs 负责「用」它。
 *
 * ## 语义要点：dirty 必须分 null 与 false
 *
 * - `false` = 已确认工作区干净，产物可对应某次提交 → 可以发
 * - `null`  = git 不可用（不是仓库 / 没装 git）→ **不知道**
 *
 * 二者混为一谈是危险的：`null` 若被当成 `false`，就会放行一个来路不明的产物，
 * 而这正是指纹机制要防的那类事故。测试里专门钉了这一条。
 */
import { execSync } from "node:child_process";

/**
 * 读盖章时刻的 git 状态。
 *
 * @typedef {object} GitState
 * @property {string} head 短 sha；git 不可用时是中文占位串
 *   （不是空串——空串会被误读成「已确认干净」）
 * @property {boolean|null} dirty
 *   true = 确认有未提交改动；false = 确认干净；**null = 查不到**。
 *   三态不可压成两态：null 若被当 false，会放行一个来路不明的产物。
 * @property {string[]} files porcelain 清单（已滤掉 .workbuddy/ 噪音），dirty=null 时为空
 *
 * @param {string} root 仓库根目录
 * @returns {GitState}
 */
export function readGitState(root) {
  let head = "(非 git 检出或取不到)";
  try {
    head = execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return { head, dirty: null, files: [] };
  }
  // 只问"进产物的东西脏不脏"。.workbuddy/ 是 WorkBuddy 的工具数据目录：既不进产物、
  // 也不该进提交，但它一出现就让每次打包都盖上 dirty → 「别拿去发布」变成常驻噪音，
  // 而常驻噪音最后一定被人忽略——正是本项目一直在治的那个病。
  // 其余未跟踪/已改动一律照旧算脏：那意味着产物里可能有不属于任何提交的代码。
  let porcelain = [];
  try {
    porcelain = execSync("git status --porcelain", { cwd: root, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.includes(".workbuddy/"));
  } catch {
    /* git 不可用时只靠指纹，不影响盖章 */
  }
  return { head, dirty: porcelain.length > 0, files: porcelain };
}

/**
 * 逃生口判定：只认精确值 "1"。
 *
 * 为什么卡这么死（而不是"非空即放行"）：这个变量一旦写错一次，
 * 就会把「必须提交才能打包」这条唯一的硬约束整个静默关掉。
 * 精确匹配让 typo 退化成"不放行"这个安全侧。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量表（默认 process.env）
 * @returns {boolean}
 */
export function dirtyBuildAllowed(env = process.env) {
  return env.QUAIWEI_ALLOW_DIRTY_BUILD === "1";
}
