官方送检凭证：一次送检的四路互证证据都归档在这里（evidence/zhuque/）。

ledger.jsonl 追加式账本（送检文本/截图字节哈希 + 页面原文 + 手抄值）
<id>.txt 当时粘给朱雀的那段原文（seal 复制进来，哈希指向它）
<id>.png 朱雀页面截图

为什么必须入库：artifacts/ 与 scripts/zhuque-v4-out/ 都被 gitignore，
哈希若指向不入库的文件，克隆后就什么都验不了。

用法：npx tsx scripts/zhuque-evidence.ts seal --help 见 README「官方送检凭证账本」

## 凭证分三级，低级不冒充高级

`ledger.jsonl` 每行的 `proof` 字段写明强度，`audit` 按级区别对待：

| 级别              | 有什么                                                 | 能证明什么                             |
| ----------------- | ------------------------------------------------------ | -------------------------------------- |
| `screenshot`      | 送检原文 + 页面截图 + 逐字原文                         | 官方真给过这个数（唯一算"认证"的一级） |
| `text+transcript` | 送检原文 + 官分的档案出处（`proofSource` = 文件:行号） | 当时贴进去的是什么、数字抄自哪里       |
| `transcript-only` | 只有官分 + 档案出处                                    | 数字不是凭空来的，仅此而已             |

**回填级不算认证**：`scripts/zhuque-retro-backfill.ts` 把 2026-08/09 那 18 个历史点里
现存的东西收回账本（10 个点到 `text+transcript`、8 个点到 `transcript-only`），
但当年没人截图，所以 `audit` 仍把它们全部算作未认证，`check:publish`（`--strict`）照旧红。
想升到 `screenshot` 只有一条路：重新送检（官方 API 见 `scripts/zhuque-api-score.ts`）。

`retro/` 子目录放回填进来的原文；`audit` 每次都会重算这些文件的 sha256 并与账本比对，
所以事后改一个字都会被 `hash-mismatch` 抓到。
