/**
 * 趣AI味 · 改写稿质检：LLM 通顺+忠实质检、本地忠实度兜底、候选处理管线
 */

import { checkFidelityLocal, fingerprintCheck } from "../engine/humanize";
import { ApiConfig } from "./llm-config";
import { chat } from "./llm-chat";
import { buildSystemPrompt } from "./llm-humanize";
import { judgeScoreStable } from "./llm-judge";
import { ZHUQUE_DETECT_SYSTEM } from "./zhuque-semantic";

/* ----------------------------- 质检（v0.4.2） ----------------------------- */

export interface QCResult {
  pass: boolean;
  issues: string[];
}

/** 通顺 + 忠实质检：对照原文检查改写稿。
 *  1) 事实/数字/专有名词/逻辑关系被改变、遗漏或编造；2) 语病、不通顺。
 *  去味的前提是不偏义、语句通顺——这是改写工具的生命线。 */
export async function qualityCheck(
  original: string,
  rewritten: string,
  cfg: ApiConfig,
): Promise<QCResult> {
  const { content, reasoning } = await chat(
    cfg,
    [
      {
        role: "system",
        content:
          "你是文本质检员。对比【原文】与【改写】，逐项检查：1）事实、数字、专有名词、逻辑关系是否被改变、遗漏或新增（编造）；2）改写文本是否有明显语病、不通顺或读不懂的地方；3）段落衔接：句子/段落顺序调整后，是否有句子开头的指代或承接词（这/它/其次/另一方面等）在前文找不到落点；4）反检测过度注入（v0.8.6 新增）：是否出现「行业呀」「本质嗯」式书面名词后缀语气词、同一段落 ≥3 处自问自答模板（你可能会问/有人要抬杠了）、刻意的口语对仗（「效率上去，成本下来」式）、或同一语气词在相邻两句复读——这类「过度人味」是改写工具的机器指纹，出现即列 FAIL。第一行只输出 PASS 或 FAIL。若 FAIL，从第二行起逐条列出问题，每条不超过 20 个字，最多 6 条。不要输出其他内容。",
      },
      { role: "user", content: `【原文】\n${original}\n\n【改写】\n${rewritten}` },
    ],
    { temperature: 0, maxTokens: 8000 },
  );
  const body = content || reasoning;
  if (!body) throw new Error("质检失败：模型无输出");
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // 第一行判定必须精确匹配：`includes("PASS")` 会把 "NOT PASS" 误判成通过
  const first = (lines[0] || "")
    .trim()
    .toUpperCase()
    .replace(/[。，,;；:：！!？?\s]+$/, "");
  if (first === "PASS" || first === "通过") return { pass: true, issues: [] };
  const issues = lines
    .slice(1)
    .map((l) => l.replace(/^\d[.、）)]\s*/, "").slice(0, 24))
    .filter((l) => l && !/^(PASS|FAIL|通过|不通过)/i.test(l))
    .slice(0, 6);
  return { pass: false, issues: issues.length ? issues : ["质检未通过（未给出明细）"] };
}

/** 质检打回后的定向修复提示词 */
function buildRepairPrompt(original: string, current: string, issues: string[]): string {
  return `下面这版改写被质检员打回，问题清单：
${issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}

请修复以上全部问题，同时保住已有的"人味"（口语节奏、无 AI 套话、句长起伏）。硬性要求：
- 事实、数字、专有名词、逻辑关系与【原文】完全一致，一个都不能变，不许编造；
- 每句话通顺自然；
- 只输出修复后的全文。

【原文】
${original}

【当前改写】
${current}`;
}

/* ----------------------------- 本地连贯性检查（v0.8.5） -----------------------------
 * 句序重排/段落重切最典型的两类断裂，确定性检查、零成本：
 *  1) 配对衔接词失散：改写稿里有「其次/另一方面/其二」却找不到「首先/一方面/其一」
 *     ——承接句没了被承接对象，读者接不上（引擎会删段首骨架词，删一半留一半时出现）；
 *  2) 开篇孤代词：全文第一句就拿「这/它/他」开头，读者无从知晓指什么。
 * 并入 localHardGate 喂给修复轮定向处理。刻意从窄：只查全文级硬断裂，段内轻度
 * 跳脱不算（真人写作本来就会跳）。 */
const PAIRED_CONNECTIVES: [string, string[]][] = [
  ["其次", ["首先", "再者", "第二", "头一件", "一来"]],
  ["再者", ["首先", "第二", "一来"]],
  ["另一方面", ["一方面"]],
  ["其二", ["其一"]],
  ["其三", ["其一", "其二"]],
];
const INITIAL_PRONOUN_RE = /^(?:这|这些|这种|这样|它|它们|他|她|他们|她们|它们|此)/;

export function coherenceIssues(rewritten: string): string[] {
  const issues: string[] = [];
  for (const [word, partners] of PAIRED_CONNECTIVES) {
    if (rewritten.includes(word) && !partners.some((p) => rewritten.includes(p))) {
      issues.push(`衔接词失散：「${word}」在前文找不到（${partners.join("/")}）`);
    }
  }
  if (INITIAL_PRONOUN_RE.test(rewritten.trimStart())) {
    issues.push("开篇孤代词：第一句以指代词开头，前文没有指代对象");
  }
  return issues;
}

/** 本地零成本硬门槛（v0.8.3）：指纹体检 + 忠实度校验，问题清单直接并入质检打回。
 *  刻意排除两条统计型节奏指纹（句长节奏过平 / 句长标准差落入 AI 特征带）——它们是
 *  趋势信号而非硬错误，门槛里带上会导致 LLM 改写稿被反复打回空烧 API（实测踩到）；
 *  节奏问题交给 mechanicalShuffle 与深度闭环的评分修订去收敛。 */
export function localHardGate(original: string, rewritten: string): string[] {
  const issues: string[] = [];
  const STAT_SOFT = new Set(["句长节奏过平", "句长标准差落入 AI 特征带"]);
  for (const i of fingerprintCheck(rewritten).issues) {
    if (!STAT_SOFT.has(i.name)) issues.push(`指纹：${i.name}`);
  }
  issues.push(...checkFidelityLocal(original, rewritten).problems);
  issues.push(...coherenceIssues(rewritten)); // v0.8.5：重排后的衔接断裂
  return issues;
}

/** 处理一个改写候选：质检（LLM+本地硬门槛，含一次修复重试）→ 交叉评分。
 *  v0.5.1 抽出为独立步骤，供主循环与"双改写器竞争"共用。
 *  v0.8.3：① 评分改走朱雀检测员提示词（ZHUQUE_DETECT_SYSTEM）——深度闭环的收敛目标
 *  与朱雀语义层对齐，评判痕迹也是篇章层，修订轮定向更准；② 质检通过后叠加本地
 *  硬门槛（指纹体检 + 忠实度），零成本拦住"LLM 质检放行但指纹明显"的漏网稿。
 *  v0.8.6 LLM 主导：**不再对 LLM 稿跑本地机械扰动**（旧实现叠 shuffle 0.3 会把方言
 *  替身/极短锚/碎片再注入 LLM 稿，污染语义级改写并制造新指纹）。节奏与反指纹由
 *  提示词（19 条战术）+ 修订轮负责，本地只做确定性守门与评分。 */
export async function processCandidate(
  original: string,
  content: string,
  cfg: ApiConfig,
  intensity: number,
): Promise<{ shuffled: string; qc: QCResult; score: number | null; critique: string[] }> {
  const draft = content; // LLM 主导：改写稿即正文（shuffled 字段名保留以兼容调用面）
  let qc: QCResult;
  try {
    qc = await qualityCheck(original, draft, cfg);
    // 本地硬门槛兜底：指纹/数字/英文术语问题，LLM 质检放行也打回
    if (qc.pass) {
      const gate = localHardGate(original, draft);
      if (gate.length) qc = { pass: false, issues: gate.slice(0, 6) };
    }
    if (!qc.pass) {
      const rep = await chat(
        cfg,
        [
          { role: "system", content: buildSystemPrompt(cfg, intensity) },
          { role: "user", content: buildRepairPrompt(original, content, qc.issues) },
        ],
        { temperature: 0.4, maxTokens: 8000 },
      );
      if (rep.content) {
        qc = await qualityCheck(original, rep.content, cfg);
        if (qc.pass) {
          const gate = localHardGate(original, rep.content);
          if (gate.length) qc = { pass: false, issues: gate.slice(0, 6) };
        }
      }
    }
  } catch {
    // 质检通道故障不能让整个流程停摆：放行并记为通过（靠提示词铁律兜底）
    qc = { pass: true, issues: [] };
  }
  if (!qc.pass) return { shuffled: draft, qc, score: null, critique: qc.issues };
  try {
    const judged = await judgeScoreStable(draft, cfg, 3, ZHUQUE_DETECT_SYSTEM);
    return { shuffled: draft, qc, score: judged.score, critique: judged.critique };
  } catch {
    return { shuffled: draft, qc, score: null, critique: [] };
  }
}
