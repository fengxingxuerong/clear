/**
 * 趣AI味 · 改写稿质检：LLM 通顺+忠实质检、本地忠实度兜底、候选处理管线
 */

import { checkFidelityLocal, fingerprintCheck } from "../engine/humanize";
import { restoreMixedSpacing } from "../engine/humanize-shuffle.ts";
import { ApiConfig } from "./llm-config";
import { chat } from "./llm-chat";
import { buildSystemPrompt } from "./llm-humanize";
import { judgeScoreStable } from "./llm-judge";
import { ZHUQUE_DETECT_SYSTEM } from "./zhuque-semantic";
import { judgeByPanel, type JudgeSeat } from "./judge-panel";

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
          "你是文本质检员。对比【原文】与【改写】，逐项检查：" +
          "1）事实、数字、专有名词、逻辑关系是否被改变或遗漏；" +
          // v0.8.9：编造检查单列为独立项并显式枚举。原第 1 条虽写了"新增（编造）"，
          // 但描述过笼统，质检模型只比对数字与术语，抓不住"我舅去年体检""邻居家孩子"这类——
          // 实测里这类"为接地气而现编"的人物/经历/故事是最高频的硬伤，却几乎全被漏判。
          "2）【重点·编造检查】改写里是否出现了原文没有的人物、亲属、同事、朋友、个人经历、" +
          "见闻轶事、具体场景、机构名、城市、工资、年份、百分比等细节。原文没有的一律算编造，" +
          "哪怕读起来很自然。必须逐句比对原文确认，不能只扫数字和术语；" +
          "3）改写文本是否有明显语病、不通顺或读不懂的地方；" +
          "4）段落衔接：句子/段落顺序调整后，是否有句子开头的指代或承接词（这/它/其次/另一方面等）在前文找不到落点；" +
          "5）反检测过度注入（v0.8.6 新增）：是否出现「行业呀」「本质嗯」式书面名词后缀语气词、同一段落 ≥3 处自问自答模板（你可能会问/有人要抬杠了）、刻意的口语对仗（「效率上去，成本下来」式）、或同一语气词在相邻两句复读——这类「过度人味」是改写工具的机器指纹，出现即列 FAIL。" +
          "第一行只输出 PASS 或 FAIL。若 FAIL，从第二行起逐条列出问题，每条不超过 20 个字，最多 6 条。不要输出其他内容。",
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
- 属"新增/编造"的问题：把原文没有的那部分整段删掉，不要试图改写得自圆其说，
  也不要用另一个编造的细节去替换它；
- 属"遗漏"的问题：从【原文】找回对应内容补回去；
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
/**
 * v0.8.9 编造信号词：改写稿凭空出现的第一人称经历/亲属/同事类表述。
 *
 * 背景：实测 LLM 改写为求"接地气"，会现编「我舅去年体检查出结节」「邻居家孩子三个月提分」
 * 「我们公司招了三个数据标注的」这类内容。LLM 质检对人物/故事类编造漏判严重
 * （只抓得住数字与术语），这里用零成本的本地比对兜底。
 *
 * 判定口径刻意从窄：只有「原文完全没有该表述，改写稿却出现」才算编造——
 * 真人原稿本来就写"我朋友"时不会误伤。
 */
const FABRICATION_SIGNALS = [
  "我朋友",
  "我同事",
  "我邻居",
  "我同学",
  "我师傅",
  "我领导",
  "我表哥",
  "我表弟",
  "我舅",
  "我叔",
  "我姨",
  "我妈",
  "我爸",
  "我哥",
  "我姐",
  "我弟",
  "我妹",
  "我们公司",
  "我们厂",
  "我们学校",
  "我们单位",
  "我们小区",
  "有一次我",
  "有一回我",
  "去年我",
  "前年我",
  "那天我",
  "当时我",
  "上回我",
  // v0.9.4 P1：经验句式——实测（2026-09-12 s1 议论文）改写稿现编「我见过不少例子」
  // 这类第一人称见闻，首轮 LLM 质检漏判、词表也没接住，带病交付到最终稿。
  // 判定机制不变：原文完全没有该表述时改写稿出现才报，真人原稿本就带的不误伤。
  "我见过",
  "我遇到过",
  "我碰到过",
  "我曾经",
  "我听人说",
  "我身边的",
];
export function fabricationIssues(original: string, rewritten: string): string[] {
  const hits = FABRICATION_SIGNALS.filter((s) => rewritten.includes(s) && !original.includes(s));
  if (!hits.length) return [];
  return [`疑似编造：改写稿新增了原文没有的表述（${hits.slice(0, 3).join("、")}）`];
}

/** v0.9.4 P0 完结性守卫：截断稿 / 严重缩水稿不得混过质检成为最优底稿。
 *
 * 背景：2026-09-12 深度模式实测，s3 技术科普最终交付了 21 字截断稿
 * （"……大语言模型这两年挺火，但不是没毛病。训练费"）——R3 模型输出被
 * token 上限截断，49 分优于前两轮 90/92，主循环按"评分最低"把它当最优保留。
 * LLM 质检与忠实度检查都拦不住：截断稿"说出来的都对"，只是没说完。
 *
 * 判定口径（刻意只抓硬信号，宁放不误杀）：
 * ① 末句无句读收尾 = 输出截断的确定性信号（正常完整稿必有句读）；
 * ② 去空白后长度 < 原文 40% = 严重缩水。正常 LLM 改写压缩带 25~44%
 *   （实测底稿 55%+），40% 留足安全边际，与"信息增殖型"改写区分开。
 * 命中后由 processCandidate 的既有链路接管：触发修复重试 → 仍不过则弃用本轮、
 * 把问题喂给下一轮修订 → bestText 保持上一轮合格版本（回退语义零成本达成）。 */
const TRUNCATION_TAIL = /[。！？；…)…"'’"』】》.!?]$/;
const SEVERE_SHRINK_RATIO = 0.4;
export function truncationIssues(original: string, rewritten: string): string[] {
  const issues: string[] = [];
  const t = rewritten.trim();
  if (!t) {
    issues.push("候选稿为空");
    return issues;
  }
  if (!TRUNCATION_TAIL.test(t)) {
    issues.push(`末句未完结：疑似输出截断（结尾「…${t.slice(-8)}」无句读）`);
  }
  const chars = (s: string) => s.replace(/\s+/g, "").length;
  const o = chars(original);
  const r = chars(t);
  if (o > 0 && r < o * SEVERE_SHRINK_RATIO) {
    issues.push(
      `严重缩水：候选稿 ${r} 字 < 原文 ${o} 字的 ${Math.round(SEVERE_SHRINK_RATIO * 100)}%，信息大量丢失`,
    );
  }
  return issues;
}

/** v0.9.4 P1.5 编造专项复核（fabrication-checker）：
 *
 * 补偿轮只能修"已报出的未修复项"，抓不住"最后一轮 LLM 质检漏判"的编造——
 * 实测 s5 长文分块输出 7 处第一人称经验编造（"我踩过不少坑，花了好几周研究模板"）
 * 全部漏网交付。根因：改写模型的编造与质检员的漏判是同源风险，复核必须换一双眼睛。
 *
 * 设计：用交叉评判模型（与改写模型不同家族，消除自评偏差）对【原文 vs 最终稿】
 * 做独立事实核查，只抓事实性新增（经历/案例/数字/时间线/人物细节/概率变绝对），
 * 不评风格不评 AI 味。temperature=0 保证审查口径稳定。 */
const FAB_REVIEW_SYSTEM = `你是事实核查员。对比【原文】与【改写稿】，只做一件事：找出改写稿中"原文没有的事实性新增"。包括：
1. 凭空出现的具体经历、案例、数字、时间线（如原文没提时长，改写稿却写"喊了好几年""花了好几周"）；
2. 原文没有的人物、地点、机构、职能细节（如原文泛指"管理者"，改写稿具体化出"中层""老板"）；
3. 把原文的概率表述改成绝对断言（原文"往往"，改写稿写"一定""确实"）；
4. 第一人称经验：原文没有"我"的经历，改写稿出现"我见过/我踩过坑/我试过/我原来总觉得"。
不评风格、不评 AI 味、不管通顺，只抓事实性编造。每条给出改写稿中的证据片段加简短说明。
只输出 JSON，格式：{"fabrications": ["证据片段：说明", "……"]}。无编造输出 {"fabrications": []}。`;

/** 从 LLM 输出中提取第一个平衡的 {...} 块（容忍模型在 JSON 前后加说明文字，
 *  字符串内的花括号与引号转义用状态机处理，避免被内容里的 { 截断） */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const v: unknown = JSON.parse(raw.slice(start, i + 1));
          if (typeof v === "object" && v !== null && !Array.isArray(v)) {
            return v as Record<string, unknown>;
          }
          return null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 编造专项复核：独立事实核查，返回编造项清单（含证据片段）。通道异常向上抛，
 *  由调用方决定降级策略（深度闭环里为跳过复核不阻断交付）。 */
export async function fabricationReview(
  original: string,
  finalText: string,
  cfg: ApiConfig,
): Promise<string[]> {
  const r = await chat(
    cfg,
    [
      { role: "system", content: FAB_REVIEW_SYSTEM },
      { role: "user", content: `【原文】\n${original}\n\n【改写稿】\n${finalText}` },
    ],
    { temperature: 0, maxTokens: 8000, model: cfg.judgeModel.trim() || undefined },
  );
  const obj = extractJsonObject(r.content);
  if (!obj) throw new Error("编造复核：模型未返回有效 JSON");
  const fabs = obj.fabrications;
  if (!Array.isArray(fabs)) return [];
  return fabs.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

export function localHardGate(original: string, rewritten: string): string[] {
  const issues: string[] = [];
  const STAT_SOFT = new Set(["句长节奏过平", "句长标准差落入 AI 特征带"]);
  for (const i of fingerprintCheck(rewritten).issues) {
    if (!STAT_SOFT.has(i.name)) issues.push(`指纹：${i.name}`);
  }
  issues.push(...checkFidelityLocal(original, rewritten).problems);
  issues.push(...coherenceIssues(rewritten)); // v0.8.5：重排后的衔接断裂
  issues.push(...fabricationIssues(original, rewritten)); // v0.8.9：编造兜底
  issues.push(...truncationIssues(original, rewritten)); // v0.9.4：截断/严重缩水守卫（P0）
  return issues;
}

/** 处理一个改写候选：质检（LLM+本地硬门槛，含一次修复重试）→ 交叉评分。
 *  v0.5.1 抽出为独立步骤，供主循环与"双改写器竞争"共用。
 *  v0.8.3：① 评分改走朱雀检测员提示词（ZHUQUE_DETECT_SYSTEM）——深度闭环的收敛目标
 *  与朱雀语义层对齐，评判痕迹也是篇章层，修订轮定向更准；② 质检通过后叠加本地
 *  硬门槛（指纹体检 + 忠实度），零成本拦住"LLM 质检放行但指纹明显"的漏网稿。
 *  v0.8.6 LLM 主导：**不再对 LLM 稿跑本地机械扰动**（旧实现叠 shuffle 0.3 会把方言
 *  替身/极短锚/碎片再注入 LLM 稿，污染语义级改写并制造新指纹）。节奏与反指纹由
 *  提示词（19 条战术）+ 修订轮负责，本地只做确定性守门与评分。
 *  v0.9.3：panelSeats 返回合议庭各席明细（可见化：哪席打了多少分）。 */
export async function processCandidate(
  original: string,
  content: string,
  cfg: ApiConfig,
  intensity: number,
): Promise<{
  shuffled: string;
  qc: QCResult;
  score: number | null;
  critique: string[];
  panelSeats?: { id: string; score: number | null; critique: string[]; error?: string }[];
}> {
  // v0.8.9：回填被 LLM 压掉的中英/中数空格（铁律里写了模型仍照删，改确定性后处理）
  const draft = restoreMixedSpacing(original, content); // shuffled 字段名保留以兼容调用面
  let qc: QCResult;
  try {
    qc = await qualityCheck(original, draft, cfg);
    // 本地硬门槛兜底：指纹/数字/英文术语问题，LLM 质检放行也打回
    if (qc.pass) {
      const gate = localHardGate(original, draft);
      if (gate.length) qc = { pass: false, issues: gate.slice(0, 6) };
    }
    // v0.9.5 P1 编造复核前移：strictFidelity 时每候选过完硬门槛就做独立事实核查——
    // 编造稿不进评分环节（旧方案只在收稿前终审，审出编造再修复再复审 = 3 次调用
    // 且修复链脱离既有质检管线）。审出走下方既有修复链，修复稿同样再过复核。
    if (qc.pass && cfg.strictFidelity) {
      const fabs = await fabricationReview(original, draft, cfg);
      if (fabs.length) {
        qc = { pass: false, issues: fabs.map((f) => `编造复核：${f}`).slice(0, 6) };
      }
    }
    if (!qc.pass) {
      const rep = await chat(
        cfg,
        [
          { role: "system", content: buildSystemPrompt(cfg, intensity, original) },
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
        // v0.9.5 P1：修复稿同样过编造复核（编造项已喂给修复 prompt，此处确认修掉）
        if (qc.pass && cfg.strictFidelity) {
          const fabs2 = await fabricationReview(original, rep.content, cfg);
          if (fabs2.length) {
            qc = { pass: false, issues: fabs2.map((f) => `编造复核：${f}`).slice(0, 6) };
          }
        }
      }
    }
  } catch {
    // 质检通道故障不能让整个流程停摆：放行并记为通过（靠提示词铁律兜底）。
    // v0.8.6 可见化：放行原因写入 issues——qcPassed 数组下游只看 pass 布尔，
    // 若不落痕迹，API 不稳时质检形同虚设且用户毫无感知
    qc = { pass: true, issues: ["质检通道异常，本轮放行（未实际质检）"] };
  }
  if (!qc.pass) return { shuffled: draft, qc, score: null, critique: qc.issues };
  // v0.9.3 合议庭评判：配置了 ≥2 席时走多网关痕迹交叉（≥2 票定罪 + 加权中位分）。
  // 合议庭全挂/未配置时回退单裁判（流程不停摆）。
  try {
    const seats = getJudgeSeats();
    if (seats.length >= 2) {
      try {
        const panel = await judgeByPanel(draft, seats, ZHUQUE_DETECT_SYSTEM);
        return {
          shuffled: draft,
          qc,
          score: panel.score,
          critique: panel.critique,
          panelSeats: panel.seats,
        };
      } catch {
        // 合议庭全席失败：回退单裁判
      }
    }
    const judged = await judgeScoreStable(draft, cfg, 3, ZHUQUE_DETECT_SYSTEM);
    return { shuffled: draft, qc, score: judged.score, critique: judged.critique };
  } catch {
    return { shuffled: draft, qc, score: null, critique: [] };
  }
}

/** 合议庭席位注入点：由外部（scripts/UI）在进程启动时注入；浏览器构建无 fs，
 *  默认空数组 = 不启用合议庭（行为与 v0.9.2 完全一致）。 */
let judgeSeatOverride: JudgeSeat[] = [];
export function setJudgeSeats(seats: JudgeSeat[]): void {
  judgeSeatOverride = seats;
}
export function getJudgeSeats(): JudgeSeat[] {
  return judgeSeatOverride;
}
