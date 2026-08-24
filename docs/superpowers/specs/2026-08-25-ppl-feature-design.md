# 本地 ONNX 困惑度特征（指纹体检第 8 项）设计规格

日期：2026-08-25
状态：设计已经用户确认，随实现提交归档

> **实现演进勘误（随实现归档时注明）**：transformers.js v4 实测不提供 offset_mapping 也未暴露词表，
> 选点已改为「免对齐方案」（token 位置 + 原词 id 直接取自 ids 序列，跳过特殊 token 与 UNK）；
> 打分采用分组掩码（MASK_GROUPS = 5）而非全文同时掩码，理由与细节见
> docs/fingerprint-and-zhuque-calibration.md §5。本文其余设计决策（方案 A 双宿主、模型、滑窗、独立第 8 项）均照常落地。

## 1. 目标与动机

朱雀官方科普点名两大核心指标：困惑度（Perplexity）与突发性（Burstiness）。
突发性已通过句长 CV/标准差双通道落地（commit 371f767），困惑度此前如实标注为缺口。
本特性用本地 ONNX 小模型近似困惑度打分，补上最后一块短板。

## 2. 方案选型（已定：方案 A）

- **A. transformers.js 双宿主（选定）**：`@huggingface/transformers`。
  Electron 主进程走 onnxruntime-node 原生 CPU 推理（快），Web 版走 Web Worker + WASM。
  共享同一评分内核。模型 bert-base-chinese int8 量化 ≈103MB。
- B. 仅桌面版原生推理：Web 版功能残缺，放弃。
- C. 统计 n-gram 近似：零依赖但上限低，与"补短板"目标不符，放弃。

## 3. 产品决策

- 困惑度特征作为**指纹体检第 8 项独立检查**（不并入 aiScore，不动已发布标定映射）。
- 模型分发采用**首次使用时一键下载**：安装包不膨胀；模型落 Electron `userData/models/`，
  Web 版落浏览器 OPFS/缓存；默认源 hf-mirror.com（国内可达），设置可改。
- 设置中提供开关（默认开）；关闭或推理失败时静默降级为仅 7 项检查，绝不阻塞既有功能。

## 4. 架构

```
App.handleFingerprint
 ├─ fingerprintCheck(text)          ← 现有 7 项，同步秒出
 └─ pplFeature.enabled?
      ├─ ensurePplReady()           ← 加载模型；未下载则触发下载（进度回调）
      └─ scoreText(text)            ← 双宿主选择：
           ├─ Electron: IPC → main.js node-host（onnxruntime-node）
           └─ Web:     new Worker(ppl-worker)（WASM）
                └─ scorer-core.ts（纯内核：滑窗 512 / 双通道掩码 / NLL 聚合）
                     → PplFeature { meanNll, winStd, windows }
                          ↓ 注入
       humanize-metrics.ts :: pplIssues(feature, thresholds)  ← 第 8 项纯函数判定
```

分层纪律：
- `humanize-metrics.ts` 保持零第三方依赖；只新增纯函数 `pplIssues` 与阈值常量；
  评分器由调用方注入，metrics 层不知道 transformers.js 的存在。
- `src/ppl/scorer-core.ts` 纯函数、确定性，vitest 直接覆盖。

## 5. 判定逻辑（第 8 项，初版阈值待标定）

- **均值通道**：全文字级平均 NLL 过低（文本"过于可预测"的生成特征）→ 报
  「困惑度异常低（AI 特征）」。
- **平坦通道**：逐窗口 NLL 标准差过小（全程高置信、缺乏人类写作的起伏）→ 报
  「困惑度曲线过平（生成式特征）」。
- 阈值不拍脑袋：配套 `scripts/ppl-calibrate.ts` 对仓库内 AI 样本与人写样本输出分布统计，
  得出建议阈值写入文档；后续可与用户朱雀回传数据对接修正。

## 6. UI 与降级

- 「指纹体检」点击后：7 项结果立即显示；模型就绪则追加第 8 项（先显"困惑度分析中…"）；
  模型缺失则面板内提供"首次使用需下载模型（约 103MB）"+ 进度条按钮。
- 推理失败静默降级为仅 7 项 + 提示文案。

## 7. 错误处理与测试

- 下载不做断点续传（YAGNI），失败可重试。
- 超长文本按 512 字滑窗分块聚合。
- 测试：scorer-core 与 pplIssues 用 stub 评分器进 vitest；
  真实模型推理只在标定脚本中运行，不进 CI；
  回归网 120 种子必须保持全绿（引擎本体不动）。

## 8. 文档

`docs/fingerprint-and-zhuque-calibration.md` 新增第 8 项规则条目与 §5 困惑度特征章节
（架构、阈值标定法、官方困惑度缺口收敛声明）。

## 9. 已知风险（诚实声明）

1. 初版阈值基于小样本自标定，绝对精度有限——框架先行，阈值随数据迭代。
2. bert-base-chinese 社区 ONNX 导出仓可用性需开工首日核实；失效则用 optimum 转换脚本自行导出。
3. 安装包从 ~215MB 增至 ~330MB（onnxruntime-node win-x64 二进制）。
