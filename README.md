# 趣AI味 · QuAiWei v0.7.0

把 AI 写的文章改得更像人写的。**默认不配置任何 API 也能用**（本地引擎离线运行、零成本），
想更强就接一个 OpenAI 兼容的 LLM（各家通吃，实测支持 OpenRouter / SenseNova / OpenAI）。
定位：中文 AI 文本**去味预处理工具 + 送检前自检清单**——可接入朱雀（网页版半自动 / EdgeOne API 全自动）等真实检测器做闭环验证。

> ⚠️ 诚实声明：本项目**不承诺"通过朱雀检测"**——朱雀官方分尚未标定。
> 本地引擎是"换词不换骨"：能削掉套话/标点/空格指纹，但**不打散段落结构和句序**，而结构规律性恰是朱雀等重点特征；
> 真正的结构级去味须走 LLM 深度模式（打散总分总/句序重排/段落重切）。
> 内置评分（本地代理分与 LLM 评判）均为代理指标，与朱雀官方分无标定关系，请以真实检测器结果为准。

## v0.7.0 更新

- **Bug 修复（数据安全）**：深度模式在"预算耗尽且一轮都未完成"时会把**空串当去味结果**返回
  （用户输出被清空）——现抛错回退本地引擎，与单轮空输出守卫对齐；新增 API 层空输出回归测试
  （fetch 打桩，vitest 用例 16→18）
- **性能**：replaceVocab 单趟扫描收集命中+一次线性拼接、injectDialect 等价简化、4 处正则与
  连接词断句正则模块级预编译、guardBlocks 记忆化；x50（2.85 万字）基准稳定在 25ms
- **结构拆分（兼容桶模式，引用零改动）**：humanize-data.ts（999 行）→ 5 个领域模块；
  llm.ts（838 行）→ 8 个分域模块；App.tsx 抽取 FingerprintPanel/BenchmarkPanel 组件
- **状态优化**：输入/输出判空改 useMemo 派生布尔，消除每次按键的全串 trim 拷贝
- **健壮性/UX**：全局 ErrorBoundary（渲染异常不再白屏）；设置模态支持 Esc 关闭、补 dialog
  语义；温度输入改失焦归一化，修复清空重输时受控回弹跳值
- **安全**：CSP connect-src 收紧（去 http:）；secure-store 写入 Promise 链串行化防并发丢更；
  sync-dist 对源 HTML 已含 CSP 的情况输出告警

## v0.6.1 更新

- **Bug 修复**：修复 LLM 质检 `NOT PASS` 误判为通过、深度模式轮数前端与引擎不一致（"最多3轮"→
  统一为 `DEEP_MAX_ROUNDS=4`，导出常量可配置）、本地引擎缺失 `injectHalfWidth` 调用（半角逗号微混入
  现三处统一生效）
- **LLM 通道反指纹兜底**：新增 `crossChunkCleanup`——单轮 LLM 输出与长文分块拼接后统一过一遍
  全文级限额去重（垫词/破折号/省略号/段首过渡词/套话/空格），避免各块"各出现一次"的垫词在块
  边界累积成新指纹
- **数据词典清理**：删除"唯一替身=原词"的死项（`获得感`、`闭环` 自替身导致强度 1.0 时约 50%
  泄漏，verify-quality 可测出），检测价值转入 `FORMULAIC` 保留评分；修复 `DIALECT_VOCAB` 的 3 个
  替身内部重复（`里面`/`外面`/`思考`）——被新增的数据完整性 vitest 测试自动捕获
- **工程增强**：添加 `.gitignore`、扫描测试失败时 `process.exit(1)` 供 CI 感知（含
  `verify-quality`，其硬性泄漏门禁现真实生效）、`humanize.test.ts` 改为 vitest 真断言、
  启用 `noUnusedLocals`/`noUnusedParameters`、`test:quality`/`bench` 脚本、`.editorconfig`、
  GitHub Actions CI（类型/单测/回归/质量门禁/构建五关）、Electron 单实例锁 + 窗口打开/导航拦截、
  Electron 打包 `dist` 脚本、`vite.config.ts` 条件轮询（仅非 ASCII 路径启用）、`bench.ts` 导入风格统一
- **代码重构**：提取 `sentenceStats`/`computeStats`/`findSplitPoint`/`makeRng`；`SettingsModal`
  独立组件（草稿-提交模式）；`store.ts` 逐字段类型校验；`any` → `unknown` 收窄；`as Score`
  断言消除（统一用 `ScoreBreakdown`）；`CHUNK_THRESHOLD`/`CHUNK_SIZE`/`ZHUQUE_MIN_CHARS` 命名常量；
  删除死导出 `PUNCT_IRREGULARITIES`/`ELLIPSIS_ENDINGS`（早期规划数据，被确定性反指纹规则替代）
- **安全**：Electron 渲染进程 `sandbox: true` + CSP 头注入；`qualityCheck` 精确匹配防误判

## v0.6.0 更新

- **朱雀增强模式**：开启后叠加方言词汇、句中插入语、主观意见短语、括号自语、句式片段等反检测特征
- **v0.5.3/0.5.4 引擎提升**：强化副词+动词搭配修残（"非常提高"→"提高"）、AI 结论收束词替换（"这说明"→"说白了就是"）、让步句重构进入本地引擎、关于X的论述开篇去套话
- **代码结构优化**：数据词典拆分至 `humanize-data.ts`、预排序 VOCAB_ENTRIES、魔法数字→命名常量
- **测试升级**：`tsx` 替代 `--experimental-strip-types`、可选 `vitest`

## 快速开始（小白）

解压后**双击 `一键启动.bat`** 即可：自动检查 Node.js → 首次自动装依赖 → 起服务并打开浏览器。
唯一的环境要求是 [Node.js 18+](https://nodejs.org/)。详见压缩包内《使用说明.txt》。

## 生产部署（重要：LLM 通道的 CORS）

- **`npm run dev`（vite）**：内置 `/sensenova` 同源代理，SenseNova 等 CORS 受限的网关可用；
- **静态托管 dist/**：浏览器直连第三方 API。OpenAI 等 CORS 放行的服务商可直接用；
  SenseNova 这类预检 404 的网关需要自备反向代理（把 `/v1` 转发到 `https://token.sensenova.cn/v1`，
  然后 Base URL 填你的代理地址）；
- **Electron 桌面版**：`electron-app/` 已同步最新 Web 构建（含深度模式）。
  打包：`cd electron-app && npm install && npx electron-packager . QuAiWei --platform=win32 --arch=x64 --out=../electron-dist`。
  注意：桌面版里 LLM 直连同样受 CORS 约束，SenseNova 用户请填 CORS 放行的服务商或本地代理。

## 许可

MIT（见 LICENSE）。

> ⚠️ 关于「朱雀对标」：内置的「AI 味评分」是一个**本地启发式代理分**（看套话密度、句式跳脱度、句长均匀度），
> 不是朱雀官方分数。要真实验证，请把去味结果粘到朱雀检测器里跑一遍。后续可加一个检测器 API 钩子做自动闭环。

## 朱雀实测记录（2026-08-16）

- **最低字数门槛 350 字**：朱雀网页版要求检测文本 ≥350 字，短文本直接报"检测文本长度需大于350字"。
  本工具去味不受影响，但送检前请保证长度；UI 会在文本不足 350 字时给出提示。
- **未登录有次数限制**，且高峰期匿名请求经常「服务超时」/挂起数分钟，建议错峰或登录后使用。
- 匿名会触发滑块拼图验证码（一般自动通过）。
- 本地代理分与官方分的换算尚未标定（本次实测未拿到稳定官方分）。已知定性结论：
  词汇替换类去味对句式骨架无影响，检测模型主要看**结构规律性**（每段开头挂过渡词、
  总-分-总骨架、工整对仗），本地引擎 v0.2 已加入段首过渡词删除等结构级手段。

## SenseNova 网关实测记录（2026-08-16）

用商汤 token.sensenova.cn（OpenAI 兼容）实测 3 Key × 3 模型：

- **三个 Key 均有效**；`sensenova-u1-fast` 在 /models 列表里但 chat 路由 404，**不可用**；
- **`deepseek-v4-flash`：首选**，1.7~2.3s 稳定；`sensenova-6.8-flash-lite`：可用但 2~17s 波动大、偶发空回复；网关另提供 `glm-5.2`、`sensenova-6.7-flash-lite`；
- **CORS 坑**：网关的 OPTIONS 预检返回 404（虽带 Allow-Origin 头），浏览器直连必挂。
  dev 已内置同源代理：设置里 Base URL 填 `/sensenova/v1`（vite.config.ts 里 `/sensenova` → token.sensenova.cn）。
  静态托管/Electron 场景需自备反向代理，或换 CORS 放行的服务商；
- **思考型模型坑**：reasoning 会吃 token 预算，不设 max_tokens 时 content 常返回空。
  llm.ts 已设 max_tokens 并做双保险：评判空 content 回退解析 reasoning 里的数字、去味空输出按失败回退本地引擎；
- 评判波动大（同一文本 20~80），LLM 评判分仅作参考，多测几次取均值更稳。

## 竞品调研与移植（v0.4.0）

调研了英文系商业 humanizer（Undetectable AI / HIX Bypass / Phrasly：改写+内置检测验证闭环、
文风与强度档位是标配）和中文系降 AIGC 工具（PaperPass / 嘎嘎降AI / 腾讯云《5套降AI率润色方法》，
后者实测朱雀通过率接近 100%）。本版移植了其中可确定性落地的部分：

| 移植项 | 说明 |
|---|---|
| 中英数字空格清理 | "共 100 次/AI 写作"→"共100次/AI写作"——AI 训练语料爱留空格，人打字不留，朱雀点名指纹（本地引擎+LLM 提示词+机械层三处生效） |
| 让步句重构 | "虽然A，但是B"→"你可能觉得A？其实B"（竞品实测朱雀重点特征） |
| 总结类过渡词直删 | 综上所述/总而言之直接删（比替换更有效） |
| 半角逗号微混入 | 模拟人类手滑，双重限频（~4% 概率 + 全文 ≤5% 硬上限） |
| 文风预设 | 自然口语 / 平实书面（报告公众号）/ 学术体（论文降AIGC，保术语删套话）——知网 4.0 会抓"拼凑式改写/风格断层"，学术档全文统一处理 |
| 强度滑块作用于 LLM | 轻度保结构只修刺眼痕迹 / 重度允许打散句序段落 |

英文竞品有而我们没有的：**接入真实检测器 API 做闭环验证**（它们买 GPTZero/Turnitin 的检测接口，
我们只有自建 LLM 评判）——等朱雀开放接口或付费检测 API 即可补上，架构已预留（"外部检测器"设置）。

## 深度去味模式（v0.3.2，LLM 通道）

设置里开启「深度模式」后，LLM 通道走闭环（默认开启）：

```
强化提示词改写 → 标点级机械扰动叠加
      ↑                │
   定向修订 ← 痕迹清单 + 交叉集成评分（未达标>10 才继续）   （最多 4 轮，全程保留最低分版本）
```

- **交叉评判（v0.3.2）**：设置里"评判模型"填一个不同家族的模型（SenseNova 网关推荐 `glm-5.2`），
  主模型+交叉模型各一票取均值，消除自评偏差。实测同一去味文本：deepseek 自评 30、glm-5.2 评 4——
  尺子不同结论天差地别，交叉是当前最稳的折中；
- **质检关（v0.4.2）**：每轮改写先过"通顺+忠实"质检（对照原文查数字/事实/逻辑/编造/语病），不过关自动打回修复一次、再不过弃用该轮；全部轮次质检失败则回退本地引擎。best-of 只收质检通过的版本。改写铁律新增"数字/日期/专名原样保留，禁模糊化"（占40%≠占大头，明年3月≠开春）；
- **痕迹评判**：评判员先列出残留 AI 痕迹（含"虚构人物事例""口语化模仿痕迹"这类高级破绽）再打分；
- **定向修订**：下一轮只动痕迹指出的地方，不推倒重来（防"改过头反弹"）；
- **机械扰动 + 反指纹规则层（v0.3.3）**：每轮结果叠加标点扰动，并做确定性限额/去重——
  垫词去重（说真的/讲真/所以说等 16 个只许出现一次）、破折号/省略号整篇限 1、
  句首过渡词去重、句长变异系数过低时安全劈句（带无主句守卫）。
  全部规则零语法风险，回归测试覆盖（`npm run test:regress` 反指纹段 20 种子）；
- **限流自愈**：429/5xx 指数退避重试；单轮失败保留已有最优结果，不丢工作；
- **实测成绩（不同评判宽严差异很大，如实记录）**：
  - 宽松评判（早期提示词）：原文 ~80 → 输出 10~45
  - 严格评判（含口语模仿痕迹检查）：原文 90~95 → 输出 58~78
  - 交叉评判单次抽查最好：输出 4~5（glm-5.2 / 6.7-flash-lite 各自独立给出）
  - **诚实结论：改写质量已到"人读自然"水平，数字高度依赖评判员宽严；权威结论待朱雀实测**
- 耗时：未配交叉评判约 1~3 分钟；配 glm-5.2（单次 15~20s）约 3~6 分钟。

## 引擎质量回归（v0.2）

`npm run test:regress` —— 4 档强度 × 30 种子共 120 次运行，扫描已修复病句签名
（越来越增多 / 急用思考 / 裸"难"接动词 / "但，" / 具有挺 / 名词位补"了" / 双垫词叠罗汉 /
无主句切断 / 替身级联二次替换），要求零命中。

## 特性

- **零依赖本地引擎**：纯 TypeScript，浏览器/webview 内离线运行，不联网、不花钱、不泄露原文。
- **可选 API 增强**：设置里填 `baseUrl / apiKey / model`（OpenAI 兼容），优先走 LLM；调用失败自动回退本地引擎。
- **去味强度可调**：0~100% 滑块，轻度润色到重度改写。
- **前后 AI 味评分对比**：直观看到降幅。
- **对标评分双通道（真实分，非仅本地代理分）**：
  - *LLM 评判*：启用 API 后，用你配的模型当"检测员"给去味后文本打真实 AI 味分（0~100）。
  - *外部检测器*：设置里填一个检测器接口（如朱雀类开放接口），把 `{text}` POST 过去按 JSON 路径取真实 AI 概率。
- **跨端**：Web 版任意设备浏览器打开即用（含手机，已做响应式布局）；桌面版走 Electron（已打包 Windows 安装包），macOS 包可在对应环境构建。

## 目录结构

```
ai-humanizer/
├─ src/
│  ├─ engine/humanize.ts        # 核心：本地去味引擎 + AI味评分（零依赖）
│  ├─ engine/humanize.test.ts   # Node 实跑测试
│  ├─ api/llm.ts                # 可选 OpenAI 兼容适配器 + 统一分发
│  ├─ store.ts                  # localStorage 配置持久化
│  ├─ App.tsx / main.tsx        # React UI（深色科技风）
│  └─ styles.css
├─ electron-app/                # Electron 桌面壳（加载 Web 构建，已打包 Windows）
├─ index.html / vite.config.ts
└─ package.json
```

## 快速开始（Web，含手机浏览器）

```bash
npm install
npm run dev          # 打开 http://localhost:5173
```

手机上直接用浏览器访问同一地址（同一局域网）即可使用；或 `npm run build` 后把 `dist/` 托管到任意静态空间。

## 构建桌面版（Electron，Windows）

桌面版用 Electron 套壳加载 Web 构建，已打包出 Windows 安装包（`electron-dist/QuAiWei-win32-x64`）。

```bash
npm run build:electron   # 一键：tsc -b → vite build → 自动同步 dist/ 到 electron-app/（含 CSP 注入）
cd electron-app && npm install
npm start                  # 本地起 Electron 窗口调试
# 打包（需 electron-packager，已在 electron-app 依赖）
npx electron-packager . QuAiWei --platform=win32 --arch=x64 --out=../electron-dist
```

> `build:electron` 里的同步脚本（`scripts/sync-dist.mjs`）会把最新 Web 构建复制进
> `electron-app/` 并在 `index.html` 注入 CSP，避免改完 Web 代码忘了同步桌面版。

> 🍎 macOS / Linux 包：在对应系统上把 `--platform` 换成 `darwin` / `linux` 即可（Electron 支持本机构建对应平台包）。

## 手机端（Web 版，已做响应式）

没有原生 App。手机直接用浏览器打开 Web 版即可，功能与桌面完全一致：
- 开发态：`npm run dev` 后手机同局域网访问 `http://<你的IP>:5173`
- 发布态：把 `dist/` 托管到任意静态空间（GitHub Pages / Vercel / 对象存储），手机访问该地址

`src/styles.css` 已做窄屏适配（`max-width: 760px` 时双栏自动变单栏），竖屏体验正常。

## 隐私

- 本地引擎：原文只在你设备上处理，绝不上传。
- API 模式：原文会发给你在设置里填的接口（你的 Key、你的服务商），Key 仅存浏览器 `localStorage`，不落盘到本项目、不上传到任何第三方。

## 验证本地引擎

```bash
npm test          # vitest 断言套件（含引擎行为/边界/跨块清理用例）
npm run test:regress   # 病句签名回归扫描（120+ 种子组合）
npm run test:quality   # 词典泄漏质量门禁
npm run bench          # 性能基准（本地引擎 10x 文本约 3~5ms）
```

会打印一段 AI 体样例的去味前后文本与 AI 味评分，典型结果：去味前 ~82 分 → 去味后 ~30 分。


---

## aiScore → 朱雀分初步标定（v0.7.x-dev，样本 n=1）

2026-08 首次真实标定：数字密集型段落（大模型参数/成本/延迟主题），朱雀网页版人工实测。

| 文本 | aiScore（代理分） | 朱雀实测 | 线性映射预测 |
|---|---|---|---|
| 原文 | 33 | 85% | 85.5% |
| 本地引擎 强度0.7 | 10 | 45% | 39.3% |
| 深度闭环（ds-v4-flash × glm-5.2） | 8 | 30% | 35.3% |

**线性映射：朱雀% ≈ 2.0 × aiScore + 19.2**（最小二乘，R²=0.962，最大残差 5.7pp）

经验阈值（由映射反推）：

| 目标朱雀分 | 所需 aiScore |
|---|---|
| ≤50% | ≤15 |
| ≤40% | ≤10 |
| ≤30% | ≤5 |

诚实声明：

- **截距即噪声地板**：19.2% 与朱雀对纯人写中文文本的已知误杀底线（约 15~20%）吻合——意味着即使 aiScore 压到 0，朱雀分也很难低于两成，这不是工具失灵而是检测器本性；
- 斜率 ≈2.0：代理分每降 1 分，朱雀分约降 2 个百分点，说明本地+深度组合对"检测器关心的特征"确实在持续做功；
- **样本仅 1 篇单一体裁，以上全部数值为暂定**。欢迎用不同体裁（叙事文/口语对话/学术段落）回传更多 (aiScore, 朱雀%) 数据点，扩充到 3 篇以上即可给出带置信区间的正式标定。
