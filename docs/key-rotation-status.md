# Key 轮换状态备忘（2026-09-05｜泄露面复测更新 2026-09-19）

## 结论

- ~~仓库**无远程 remote**（`git remote` 为空）→ 3 个旧 Key 的泄露面 = **仅本机 git 历史**，外泄风险低~~
  **这条"风险低"的判断已被 2026-09-19 的复测推翻**，见下面【泄露面实测】。
- 3 个 Key 经 `/v1/models` 实测**当前全部有效**（该实测日期为 2026-09-05；轮换前先确认仍然有效）。
- ~~Key 已从源码移除~~ → **本条曾被推翻**：54c12ce 把 Key 从 `llm-config.ts` 移出后，
  34792ea（v0.9.5 第九批）归档临时探针 `scripts/archive/gateway-probe.mjs` 时又把
  **3 条可用 Key 硬编码回去并被 git 跟踪**。2026-09-19 哈希比对确认与当前在用 Key 完全相同。
  现已改为只读 `SENSENOVA_KEYS` / `scripts/.sensenova-keys`，跟踪内容中已无明文密钥。
- **但历史提交里的明文洗不掉**：从 34792ea 起的每个 commit 都含那 3 条 Key。只要仓库
  被推出去、打包分享、或连同 `.git` 一起备份到别处，即等同泄露 → **发布前必须轮换**。

## 泄露面实测（2026-09-19，全部只比对 sha256 前 12 位，任何输出都不落明文）

**git 历史侧（结论确定）**：扫 `git rev-list --all`（145 个 ref 头 / 91 个提交）的全部 blob，
`sk-[A-Za-z0-9]{16,}` 形态**只有 3 条 distinct**，与 `scripts/.sensenova-keys` 里的 3 条**逐哈希相等**。
含义有两面：① 该换的就这 3 条，历史里没有"已经不用但仍有效"的孤儿 Key；② 这 3 条也确实全在历史里。
泄露路径三处：`scripts/archive/gateway-probe.mjs`、`scripts/gateway-probe.mjs`、`src/api/llm-config.ts`。

**本机其它位置（这才是"风险低"被推翻的原因）**：同样这 3 条 Key 还明文活在**另外两个项目**和
**一份审计报告的交付物**里：

| 位置 | 内容 | 轮换后的影响 |
|---|---|---|
| `D:\projects\quaiwei\scripts\.sensenova-keys` | 3 条全在 | 唯一"设计如此"的存放点，换新 Key 后即正确 |
| `D:\projects\prompt-master\.env` | 3 条全在（另有 3 个 `.env.bak-*` 副本 + 交付归档里的 `pool_probe.sh`） | **该项目的评委/仲裁跑批立刻 401/403**，要同步改 |
| `D:\projects\sqli-scanner\server\.env.ai` | 3 条全在 | 该项目的 AI 通道立刻失效，要同步改 |
| `D:\deep\agent-audit-reports\`（`index.html` / `static/app.js` / `data/*.json` 共 5+ 文件） | Key 出现在**渲染出来的报告页面**与会话正文里 | 报告不具备"只在本机"的性质：凡是转发过、在浏览器里打开过、或截过图，Key 就已外泄 |

> 也就是说真实泄露面 = 3 个项目的明文配置文件 + 一个仓库的 git 历史 + 一份可分享的 HTML 报告，
> 不是"仅本机 git 历史"。**这反而让轮换更该做，而不是更可缓。**

⚠️ 盘点时另见 2 条长度形态相同（35 / 51 字符）的其它凭证散在上述位置，
**没有**出现在 quaiwei 的 git 历史里，因此不属于"本仓库要求轮换"的范围；
但到控制台时可以顺手确认其中是否有一条也是 SenseNova 的 Key（若是，一起换掉更干净）。

## ⚠️ 一条自我记录：本次复核过程中我自己的脱敏不彻底

用 `grep -oE '.{45}sk-[A-Za-z0-9]{28,}…'` 取上下文时，右侧窗口 `.{15}` 把**下一条**较短的 Key
带了进来，而脱敏用的 `{28,}` 正则没覆盖它 → 终端上露出了某条非 SenseNova 凭证的前 12 个字符。
**教训**：脱敏要在**输出边界**上做（先整体匹配所有凭证形态再统一替换），不能只替换"我预期长这样的那一个"。
该凭证既非本项目 Key、也未进入任何提交/文档，但它现在存在于本会话记录里，按"已部分暴露"对待。

## 建议（按需执行）

1. ~~低风险可接受~~ **不再成立**：明文不但在 git 历史里，还在另外 2 个项目的 `.env` 和一份
   可分享的 HTML 审计报告里，且 Key 仍然有效 → 凡是"会把 `.git` 或那份报告交出去"的动作
   （push / 发 Release / 打包源码 / 转交他人或其它 agent）之前，都必须先轮换。
2. **彻底安心**：到 SenseNova 控制台重置 3 个 Key → 更新 3 处 `.env`（见下方 runbook）→ 无需改代码；
   如要连历史一起清干净，用 `git filter-repo` 重写（注意会改变所有 commit hash，会让本仓库
   与裸镜像备份、`.git-restored*` 快照全部失配，属独立决定）。
3. **复发防护**：`.githooks/pre-commit` 已加密钥形态拦截（只扫暂存的新增行，命中即阻止提交，
   且输出截断隐去，不把密钥打进日志）。归档临时脚本时尤其要留意——这次就是这么漏的。
   ⚠️ 但这条 hook **护不住上面那 3 处 `.env`**：它们都在别的仓库或未被跟踪的目录里。

## 轮换 runbook（按顺序做，别先点重置）

**为什么顺序重要**：SenseNova 的新 Key 通常只显示一次；而重置瞬间旧 Key 立刻全死，
另外两个项目的跑批会在你还没来得及填新值的时候开始报 401/403。

1. **先在控制台"新建"3 条 Key，暂时不要删旧的**（如果控制台支持并存多个 Key）。
   这样旧 Key 在你填新值的几分钟里仍然可用，两个项目的跑批不会被打断。
2. ⚠️ **不要把新 Key 贴进对话/终端历史/聊天记录**。会话记录会以明文 JSONL 落盘，
   那正是本次要消除的同一类问题（本轮复核时我就制造过一次这种记录）。
   新 Key 请**直接**写进目标文件，或先存进一个不进任何仓库的临时文件。
3. 更新三处存放点（三个项目的调用代码都不用改）：
   - `D:\projects\quaiwei\scripts\.sensenova-keys` —— 一行一个新 Key
   - `D:\projects\prompt-master\.env` —— 以及它的 3 个 `.env.bak-*` 副本和交付归档里的 `pool_probe.sh`，
     这些备份是本次扫出来的额外明文面，顺手一起清掉最省事
   - `D:\projects\sqli-scanner\server\.env.ai`
4. 确认新 Key 生效、条数正确（**只打印条数，不打印内容**）：
   ```bash
   cd /d/projects/quaiwei
   npx tsx -e "import {loadPresetKeys} from './src/api/llm-config'; console.log(loadPresetKeys().length)"   # 期望 3
   ```
5. 确认旧 Key 已全部失效：在控制台删除/禁用旧 Key，或看两个项目是否还在报 401/403。
   跑一次 QuAiWei 深度模式（1 篇即可）确认新 Key 可用。
6. 用哈希确认"新值真的不是旧值"、且跟踪内容里没有明文（**全程只算哈希，不把任何 Key 写进任何文件**）。
   旧 Key 的 sha256 前 12 位是 `b82265ead297` / `e38fb0a1e798` / `e1e896e7b77d`（哈希不是秘密，可以留在文档里当核对基准）：
   ```bash
   cd /d/projects/quaiwei
   OUT=$(grep -oE 'sk-[A-Za-z0-9]{16,}' scripts/.sensenova-keys | sort -u | while read -r k; do
     h=$(printf '%s' "$k" | sha256sum | cut -c1-12)
     case "$h" in b82265ead297|e38fb0a1e798|e1e896e7b77d) echo "仍是旧 Key: $h";; *) echo "新: $h";; esac
   done)
   printf '%s\n' "$OUT"
   if printf '%s' "$OUT" | grep -q '仍是旧 Key'; then echo "❌ 仍有旧 Key 未替换"; else echo "OK: $(printf '%s\n' "$OUT" | grep -c '^新:') 条全新"; fi
   # 跟踪内容里不该有任何明文 Key 形态（期望：无输出）
   git grep -nE 'sk-[A-Za-z0-9]{16,}' -- .
   ```
   全程只经过变量，不落任何临时文件（哈希也不写盘）。
7. `D:\deep\agent-audit-reports\` 里那几份报告是**渲染出来的交付物**（`index.html`、`static/app.js`、
   `data/*.json`），Key 出现在会话正文里。旧 Key 失效后它们不再泄露可用凭证，但如果那些报告还要
   再发出去，应当先把里面的 Key 文本抹掉——否则收件人会看到一个"曾经存在过的凭证"。
