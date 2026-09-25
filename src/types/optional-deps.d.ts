/**
 * optional 依赖的类型兜底（v0.9.16）。
 *
 * @huggingface/transformers 在 package.json 的 optionalDependencies 里：
 * `npm ci --omit=optional`（CI 省流）或安装失败时，包与类型声明都不存在，
 * ppl-worker.ts 的 import 会报 TS2307 硬错。这里给 ambient 兜底让构建通过——
 * PPL 功能本身有运行时守卫（isPplReady/pplStatus），缺包时功能优雅降级。
 *
 * 代价说明：本地正常装包时此声明可能让该模块类型提示降级为 any（编译不受影响），
 * 换取"任意安装形态下 tsc 全绿"，值得。
 */
declare module "@huggingface/transformers";
