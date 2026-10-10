# 朱雀官方送检 · 分批执行计划（2026-10-10 立）

> 目的：把 18 个标定点的凭证从「回填级」升到 **api-response 认证级**（`check:publish` 由红转绿），
> 顺带补 8 个 v4 中段点。额度有限（见下），所以必须分批、且按价值排序。

## 0. 现状（2026-10-10 实测）

| 项 | 值 |
| --- | --- |
| 凭证分级 | 认证 **0/18**｜文本+转录 10｜仅转录 8（`npx tsx scripts/zhuque-evidence.ts`） |
| 链路 | ✅ 就绪：`--dry-run`（18 篇）与 `--dry-run --v4`（+8 篇）均跑通，文本与 aiScore 全部算得出 |
| Key | ❌ 未配置 —— `ZHUQUE_API_KEY` 只从环境变量读 |
| 分批能力 | ✅ `scripts/zhuque-official-run.ts --only <id1,id2,…>`（commit `c83b669`） |

## 1. 额度口径（**待首跑实测确认，别照旧记忆规划**）

| 通道 | 项目记载 | 出处 |
| --- | --- | --- |
| 网页版游客档 | 约 **5 次/天** + 滑块 | `scripts/zhuque-evidence.ts:30` |
| 官方 API（EdgeOne Makers `@makers/zhuque-text`） | **50 万 token/月**免费，按 `makers_models_usage.total_tokens` 核算 | `scripts/zhuque-api-score.ts`、`src/api/detector.ts` |

用户 2026-10-10 反馈「朱雀有每天 5 次机会」。若这指的是 **API 档**，说明官方收紧过 ——
首跑输出里会打印每篇扣减的 token 数，**那才是判据**。跑完把口径回写到本文件第 1 节。

## 2. Key（只走环境变量，三种写法都禁止）

- 入口：腾讯云 EdgeOne 控制台 → Makers → Models → API Key
- ❌ 别贴进对话 ❌ 别写进仓库文件 ❌ 别写进命令行（shell history / 进程列表都是明文）
- ✅ `export ZHUQUE_API_KEY=xxx` 后在同一终端跑脚本

## 3. 分批排期（26 篇，每天 ≤5）

排序依据：**先铺四条体裁线的原文/低处理锚点**（拟合线两端最值钱），再补中段与 v4 点。
每天混合体裁，保证任何一天中断后，已有数据都覆盖到全部体裁。

| 天 | `--only` 列表 | 说明 |
| --- | --- | --- |
| D1 | `O1,N1,D0,H0,H1` | 四体裁**原文锚点**：aiScore 43/33/46/7 → 历史 y 85/99/98/15 |
| D2 | `O5,O2v07,N2v2,D2v2,H2v2` | O5 是 v4 的论说原文（aiScore=43），价值等同锚点，故提前 |
| D3 | `O2v3,O3v07,N2v3,D1v3,H2v3` | 0.7 / v3 处理点 |
| D4 | `O3v3,N3v2,D3v2,D2v3` | recheck 18 篇到此收尾 |
| D5 | `O4,N4,D4,D5,H-NEW1` | v4 中段四体裁 + 人写 1 |
| D6 | `H-NEW2,H-NEW3,H-NEW4` | v4 人写收尾 |

命令模板（v4 的点必须带 `--v4`，否则 id 不在 recheck 集合里会被判成未知）：

```bash
export ZHUQUE_API_KEY=<key>
npx tsx scripts/zhuque-official-run.ts --only O1,N1,D0,H0,H1          # D1~D4
npx tsx scripts/zhuque-official-run.ts --v4 --only O4,N4,D4,D5,H-NEW1 # D5~D6
```

幂等：已有 `api-response` 的 id 自动跳过，**重复跑不会重复烧额度**，中断一天无妨。

## 4. 判读口径（跑完看什么）

1. **每篇的 `官方 AI 概率` vs 历史 `y`**：差得多（尤其系统性偏移）= 朱雀模型更新过 → 该重拟合，
   脚本会当场警告，但不拦、audit 不报硬伤。
2. **`npm run check:publish`**：认证点应从 0/18 逐天涨到 26/26。
3. **`npx tsx scripts/zhuque-v4-fit.ts`**（仅 v4 送完后）：看重拟合报告。
4. **`npm run test:calib`**：锚点误差 >8pp 转红是「旧线拟合不了新数据」的**诚实信号**，不是脚本错了。

⚠️ `--v4` 送检时脚本会打印「孤儿凭证」警告 —— 那是本进程内读的是模块加载时的标定数据快照，
无害；新进程（audit/CI）重读 `calibration-data.json` 时 id 已注册。

## 5. 送完要做什么

```bash
git add evidence/ scripts/calibration-data.json   # 凭证与标定数据都要入库，否则克隆后无法复算
npm run check:publish                              # 期望由红转绿
```

重拟合若确实需要，再**人工**同步 `src/engine/zhuque-calib.ts` 与 `calibration-data.json` 的 tracks ——
脚本不自动改运行参数。
