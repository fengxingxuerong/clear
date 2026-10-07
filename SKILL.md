---
name: qu-ai-wei
description: 去 AI 味（简体中文）——调用本仓库自带的本地离线引擎（零成本、不联网）或可选 LLM 深度闭环，把 AI 写的中文改得更像人写的，并输出前后 AI 味评分与逐条痕迹报告。当用户要求「降 AI 率 / 去 AI 味 / 去 AIGC 痕迹 / 让这段更像人写的 / 自检朱雀类检测」时使用。
license: MIT
metadata:
  version: 0.9.25
  repo: https://github.com/fengxingxuerong/clear
---

# 去 AI 味 · QuAiWei

薄壳 skill：**规则与引擎都在仓库里**，这里只负责告诉 agent「怎么调、什么别做」。
与"一份提示词清单"型 skill 的区别是——本仓库跑的是有回归测试锁死的 TypeScript 引擎，
不是让模型自由发挥。

## 什么时候用

- 用户要「降 AI 率 / 去 AI 味 / 去 AIGC 痕迹 / 改得像人写的」，且**文本是简体中文**；
- 用户要「自检一下会不会被判成 AI」——注意本 skill 只给**代理分**，不是任何检测器的官方分；
- 批量处理目录里的一批 `.txt` / `.md` / `.docx`。

英文文本、或要求「对某个检测器打包票」的场景，**不要**用本 skill（见下方边界）。

## 怎么跑

```bash
# 本地引擎：零成本、离线、不联网（默认推荐）
npx tsx scripts/humanize-cli.ts ./in --out ./out --intensity 0.9 --zhuque

# 想更强：走 LLM 深度闭环（Key 走环境变量，别写进命令行历史）
QUAIWEI_API_KEY=sk-xxx npx tsx scripts/humanize-cli.ts ./in --out ./out --api \
  --base-url https://token.sensenova.cn/v1 --model deepseek-v4-flash --judge-model glm-5.2
```

- 输入可以是文件或目录；输出扩展名默认跟随输入（`.docx` 进 `.docx` 出）。
- 需要留证据时加 `--report out.json`：每篇的耗时/字数/引擎/轮次分/降级原因都会落进去。

## 参数（与 `scripts/humanize-cli.ts` 一一对应）

| 参数 | 取值 | 说明 |
|---|---|---|
| `--out <dir>` | 目录 | 输出目录（不给则写到输入旁） |
| `--intensity <0~1>` | 默认 0.9 | 去味强度滑块 |
| `--zhuque` | 开关 | 朱雀增强（反指纹特征注入） |
| `--style` | `casual` \| `plain` \| `academic` | 文风；**论文/公文必须给 `academic` 或 `plain`** |
| `--seed <n>` | 默认 20260905 | 本地引擎种子，给定即可复现 |
| `--suffix <s>` | 默认 `.humanized` | 输出文件后缀 |
| `--out-format` | `follow` \| `txt` \| `docx` | 强制输出格式 |
| `--report <file>` | JSON 路径 | 逐篇运行报告 |
| `--api` | 开关 | 走 LLM 深度闭环（否则纯本地引擎） |
| `--base-url <url>` | 绝对地址 | 网关地址；**不要**填 UI 里的 `/sensenova/v1` 相对路径 |
| `--model` / `--judge-model` / `--alt-model` | 模型名 | 主改写 / 交叉评判 / 备选改写 |
| `--api-key <key>` | — | 优先级低于环境变量 `QUAIWEI_API_KEY` |
| `--no-deep` | 开关 | 单轮改写，不开深度闭环 |
| `--contest <n>` | ≥1 | 首轮多候选择优（调用数 ×n） |
| `--max-calls <n>` / `--max-wait <sec>` | 预算 | 整篇调用预算 / 轮间最长等待 |
| `--strict` | 开关 | 严格保真：发现编造事实即拒绝交付并回退 |
| `--persona` | `default` \| `netgen` \| `classic` | 人味人格分档 |

## 边界（**不要越界承诺**）

1. **不承诺通过任何检测器**。内置评分是本地启发式**代理分**，与朱雀等官方分**无标定关系**；
   aiScore→官方分的换算线当前 18 个标定点里有 6 个漂移、且凭证认证率为 0/18。
2. **不要用"去味前后的分数差"判断安不安全**：本地检测器与去味引擎共用一套词表，
   分数必然变好看——这是同源指标，不是外部真值。要真值只能拿真实检测器跑。
3. **本地引擎是"换词不换骨"**：不打散段落结构与句序，而结构规律性恰是检测器重点；
   需要结构级去味必须给 `--api`。
4. **人写稿别去味**：纯人写文本越去味，实测官方分反而略升——先看分再决定要不要跑。
5. 需要 100% 过检、或要求保留精确格式（表格/公式/加粗）的，**转人工处理**，别硬跑。

## 交付前自查

- 中英空格、数字、专名是否被改动（引擎有术语保护，但批量文本仍建议抽样 diff）；
- `--report` 里有没有 `降级` / `编造否决` 字样，有就说明该篇走了回退路径，需人工复看；
- 输出是否还含「综上所述 / 值得注意的是 / 深度融合」这类套话（`--intensity` 太低时会残留）。
