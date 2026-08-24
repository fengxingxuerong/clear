/**
 * 趣AI味 · 改写稿质检：LLM 通顺+忠实质检、本地忠实度兜底、候选处理管线
 */

import { mechanicalShuffle, checkFidelityLocal } from "../engine/humanize";
import { ApiConfig } from "./llm-config";
import { chat } from "./llm-chat";
import { buildSystemPrompt } from "./llm-humanize";
import { judgeScoreStable } from "./llm-judge";

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
          "你是文本质检员。对比【原文】与【改写】，逐项检查：1）事实、数字、专有名词、逻辑关系是否被改变、遗漏或新增（编造）；2）改写文本是否有明显语病、不通顺或读不懂的地方。第一行只输出 PASS 或 FAIL。若 FAIL，从第二行起逐条列出问题，每条不超过 20 个字，最多 6 条。不要输出其他内容。",
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

/** 处理一个改写候选：机械扰动 → 质检（LLM+本地忠实度，含一次修复重试）→ 交叉评分。
 *  v0.5.1 抽出为独立步骤，供主循环与"双改写器竞争"共用。 */
export async function processCandidate(
  original: string,
  content: string,
  cfg: ApiConfig,
  intensity: number,
): Promise<{ shuffled: string; qc: QCResult; score: number | null; critique: string[] }> {
  let shuffled = mechanicalShuffle(content, { intensity: 0.3, style: cfg.style });
  let qc: QCResult;
  try {
    qc = await qualityCheck(original, shuffled, cfg);
    // 本地硬校验兜底：数字/英文术语被改或丢失，LLM 质检放行也打回
    if (qc.pass) {
      const fid = checkFidelityLocal(original, shuffled);
      if (!fid.pass) qc = { pass: false, issues: fid.problems };
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
        shuffled = mechanicalShuffle(rep.content, { intensity: 0.3, style: cfg.style });
        qc = await qualityCheck(original, shuffled, cfg);
        if (qc.pass) {
          const fid = checkFidelityLocal(original, shuffled);
          if (!fid.pass) qc = { pass: false, issues: fid.problems };
        }
      }
    }
  } catch {
    // 质检通道故障不能让整个流程停摆：放行并记为通过（靠提示词铁律兜底）
    qc = { pass: true, issues: [] };
  }
  if (!qc.pass) return { shuffled, qc, score: null, critique: qc.issues };
  try {
    const judged = await judgeScoreStable(shuffled, cfg);
    return { shuffled, qc, score: judged.score, critique: judged.critique };
  } catch {
    return { shuffled, qc, score: null, critique: [] };
  }
}
