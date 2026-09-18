# Key 轮换状态备忘（2026-09-05）

## 结论

- 仓库**无远程 remote**（`git remote` 为空）→ 3 个旧 Key 的泄露面 = **仅本机 git 历史**，外泄风险低；
- 3 个 Key 经 `/v1/models` 实测**当前全部有效**；
- ~~Key 已从源码移除~~ → **本条曾被推翻**：54c12ce 把 Key 从 `llm-config.ts` 移出后，
  34792ea（v0.9.5 第九批）归档临时探针 `scripts/archive/gateway-probe.mjs` 时又把
  **3 条可用 Key 硬编码回去并被 git 跟踪**。2026-09-19 哈希比对确认与当前在用 Key 完全相同。
  现已改为只读 `SENSENOVA_KEYS` / `scripts/.sensenova-keys`，跟踪内容中已无明文密钥。
- **但历史提交里的明文洗不掉**：从 34792ea 起的每个 commit 都含那 3 条 Key。只要仓库
  被推出去、打包分享、或连同 `.git` 一起备份到别处，即等同泄露 → **发布前必须轮换**。

## 建议（按需执行）

1. ~~低风险可接受~~ **不再成立**：既然明文在历史里且 Key 仍有效，凡是"会把 `.git` 交出去"
   的动作（push / 发 Release / 打包源码 / 交给其他 agent 或人）之前，都必须先轮换。
2. **彻底安心**：到 SenseNova 控制台重置 3 个 Key → 更新 `scripts/.sensenova-keys` → 无需改代码；
   如要连历史一起清干净，用 `git filter-repo` 重写（注意会改变所有 commit hash）。
3. **复发防护**：`.githooks/pre-commit` 已加密钥形态拦截（只扫暂存的新增行，命中即阻止提交，
   且输出截断隐去，不把密钥打进日志）。归档临时脚本时尤其要留意——这次就是这么漏的。

## 轮换操作（将来需要时）

```
1. 控制台重置 Key
2. 编辑 D:\projects\quaiwei\scripts\.sensenova-keys（一行一个新 Key）
3. 验证：npx tsx -e "import {loadPresetKeys} from './src/api/llm-config'; console.log(loadPresetKeys().length)"
```
