/**
 * build-stamp.d.mts —— build-stamp.mjs 的类型声明
 *
 * ## 为什么要单独一个声明文件（而不是开 allowJs）
 *
 * 试过两条路，都不行：
 *  - **开 `allowJs`**：会把整个 `scripts/` 下的 `.mjs` 一并纳入类型检查。
 *    scripts 里有一堆历史脚本（humanize-cli 之类），它们从没被类型检查过，
 *    一开就是几十个新错误——为了一个新模块的 3 个导出，把整个目录的债都翻出来，
 *    代价与收益完全不成比例。
 *  - **改用 `.mts` 扩展名**：`npx tsc` 认，但 `node scripts/sync-dist.mjs` 不认
 *    （ERR_MODULE_NOT_FOUND）——纯 Node 的 ESM 解析器没有 `.mts` 这条规则，
 *    而 sync-dist.mjs 是被 `npm run build` 直接用 node 跑的，不能走编译。
 *
 * 所以选第三条：运行时保持 `.mjs`（Node 能跑），类型侧补一个同名 `.d.mts`
 * （TS 解析 `./build-stamp.mjs` 时会去找 `build-stamp.d.mts`）。
 *
 * 类型以 `build-stamp.mjs` 里的 JSDoc 为准，改实现时**两处要一起改**——
 * 这里没法自动同步，所以下方的测试里有一条断言专门盯它们的一致性。
 */

/** 盖章时刻的仓库状态 */
export interface GitState {
  /**
   * 短 sha；git 不可用时是中文占位串（不是空串——空串会被误读成「已确认干净」）
   */
  head: string;
  /**
   * true = 确认有未提交改动；false = 确认干净；**null = 查不到**。
   * 三态不可压成两态：null 若被当 false，会放行一个来路不明的产物。
   */
  dirty: boolean | null;
  /** porcelain 清单（已滤掉 .workbuddy/ 噪音），dirty=null 时为空 */
  files: string[];
}

/**
 * 读盖章时刻的 git 状态。
 * @param root 仓库根目录
 */
export function readGitState(root: string): Promise<GitState>;

/**
 * 逃生口判定：只认精确值 "1"（typo 一律退化成「不放行」这个安全侧）。
 * @param env 环境变量表（默认 process.env）
 */
export function dirtyBuildAllowed(env?: NodeJS.ProcessEnv): boolean;
