# Key 轮换状态备忘（2026-09-05）

## 结论

- 仓库**无远程 remote**（`git remote` 为空）→ 3 个旧 Key 的泄露面 = **仅本机 git 历史**，外泄风险低；
- 3 个 Key 经 `/v1/models` 实测**当前全部有效**；
- Key 已从源码移除（commit 54c12ce），现存放于 `scripts/.sensenova-keys`（gitignore 生效）。

## 建议（按需执行）

1. **低风险可接受**：无远程仓库、单机使用 → 可暂不轮换，继续用现有 Key 文件；
2. **彻底安心**：到 SenseNova 控制台重置 3 个 Key → 更新 `scripts/.sensenova-keys` → 无需改代码；
3. **若未来推送到远程**：必须先轮换 Key，且考虑 `git filter-repo` 清洗历史。

## 轮换操作（将来需要时）

```
1. 控制台重置 Key
2. 编辑 D:\deep\quaiwei\scripts\.sensenova-keys（一行一个新 Key）
3. 验证：npx tsx -e "import {loadPresetKeys} from './src/api/llm-config'; console.log(loadPresetKeys().length)"
```
