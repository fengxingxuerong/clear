/**
 * 朱雀官方送检通道 + 本地/官方校准
 *
 * 朱雀（matrix.tencent.com/ai-detect）目前**没有公开 API**，官方能力只能走网页：
 *   - 文本检测：粘贴或上传 txt/docx，最低 350 字，单次建议 ≤2000 汉字；
 *   - 输出：AI 生成概率（百分比）+ 三档标签 + 红色高亮可疑片段。
 * 因此本模块做三件事：
 *   1. 生成可直接粘进官方页面的送检文本（按句子边界截断，不切碎句子）；
 *   2. 打开官方页面；
 *   3. 把官方回来的一串结果文本解析成 {probability, label}，作为校准点存本地，
 *      让本地近似分逐步贴近官方分（见 engine/zhuque.ts 的 fitCalibration）。
 */

import {
  ZHUQUE_MIN_CHARS,
  ZHUQUE_SUGGEST_MAX,
  ZHUQUE_URL,
  type CalibPoint,
  type Calibration,
  type ZhuqueLabel,
  fitCalibration,
} from "../engine/zhuque.ts";
import { collectPoints, clearOfficialResults } from "./calib-lab.ts";

const K_CALIB = "quaiwei.zhuque.calib";

/* ----------------------------- 送检 ----------------------------- */

/** 构造送检文本：按句子边界截断到 limit 字，不切碎句子 */
export function buildSubmission(raw: string, limit = ZHUQUE_SUGGEST_MAX): {
  text: string;
  truncated: boolean;
  chars: number;
} {
  const text = (raw || "").trim();
  const chars = text.replace(/\s/g, "").length;
  if (chars <= limit) return { text, truncated: false, chars };

  // 按句末标点切，尽量不破坏句子完整
  const re = /[。！？!?；;]/g;
  let last = 0;
  let budget = limit;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const segLen = text.slice(last, m.index + 1).replace(/\s/g, "").length;
    if (budget - segLen < 0) break;
    budget -= segLen;
    last = m.index + 1;
  }
  const cut = last > 0 ? text.slice(0, last) : text.slice(0, limit);
  return { text: cut.trim(), truncated: true, chars };
}

/** 在新标签页打开朱雀官方检测页（Electron/浏览器均可用；被拦截时返回 false） */
export function openOfficial(): boolean {
  const w = window.open(ZHUQUE_URL, "_blank", "noopener,noreferrer");
  return !!w;
}

/** 复制到剪贴板（带降级：非安全上下文/无 API 时走 textarea + execCommand） */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级到 textarea */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ----------------------------- 官方结果回填解析 ----------------------------- */

export interface OfficialResult {
  ok: boolean;
  /** AI 概率 0~100，两位小数 */
  probability: number | null;
  label: ZhuqueLabel | null;
  labelText: string;
  /** 解析不出来时给的人话提示 */
  note: string;
}

const LABELED: Array<{ re: RegExp; label: ZhuqueLabel; text: string }> = [
  { re: /(AI\s*生成|AI\s*特征)/, label: "ai", text: "AI生成/AI特征" },
  { re: /(疑似\s*AI\s*辅助|疑似\s*AI)/, label: "suspected", text: "疑似AI辅助" },
  { re: /(人工特征|人工\s*撰写)/, label: "human", text: "人工特征" },
];

/**
 * 解析官方结果文本。容错目标（都是实测中常见的粘贴形态）：
 *   "AI生成 99.99%" / "AI 生成概率：98.47%" / "疑似AI辅助 62.3%" /
 *   "人工特征" / "99.99%" / "AI特征占比 62%"
 */
export function parseOfficialResult(raw: string): OfficialResult {
  const s = (raw || "").replace(/\s+/g, " ").trim();
  if (!s) return { ok: false, probability: null, label: null, labelText: "", note: "粘贴内容为空" };

  // 1. 档位：优先按官方三档词命中（顺序即优先级）
  let label: ZhuqueLabel | null = null;
  let labelText = "";
  for (const L of LABELED) {
    if (L.re.test(s)) { label = L.label; labelText = L.text; break; }
  }

  // 2. 概率：优先取"档位词附近"的百分比（如"AI生成 99.99%"），否则取第一个百分比
  let probability: number | null = null;
  const near: RegExp[] = [
    /(AI\s*生成|AI\s*特征|疑似\s*AI|人工特征)[^\d%]{0,12}(\d+(?:\.\d+)?)\s*%/,
  ];
  for (const re of near) {
    const m = s.match(re);
    if (m) { probability = clampPct(parseFloat(m[2])); break; }
  }
  if (probability === null) {
    const all = s.match(/(\d+(?:\.\d+)?)\s*%/g);
    if (all && all.length) probability = clampPct(parseFloat(all[0]));
  }

  if (probability === null && label === null) {
    return {
      ok: false,
      probability: null,
      label: null,
      labelText: "",
      note: "没解析出百分比或档位，直接粘官方那行结果即可（如「AI生成 99.99%」）",
    };
  }

  // 3. 二者互证：只有档位没有分数时给一个档位中值；只有分数没有档位时按官方口径定档
  if (probability !== null && label === null) {
    if (probability >= 60) { label = "ai"; labelText = "AI生成"; }
    else if (probability >= 30) { label = "suspected"; labelText = "疑似AI辅助"; }
    else { label = "human"; labelText = "人工特征"; }
  }
  if (probability === null && label !== null) {
    probability = label === "ai" ? 90 : label === "suspected" ? 50 : 10;
  }

  return {
    ok: true,
    probability,
    label,
    labelText,
    note:
      probability !== null && label !== null
        ? `已识别：${labelText} ${probability}%`
        : "已识别部分字段",
  };
}

function clampPct(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.round(Math.max(0, Math.min(100, n)) * 100) / 100;
}

/* ----------------------------- 校准存储 ----------------------------- */

/** 旧版手动校准点（主面板「记为校准点」写入这里；实验室回填走样本库） */
function readLegacyPoints(): CalibPoint[] {
  try {
    const raw = localStorage.getItem(K_CALIB);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => p && isFinite(Number(p.local)) && isFinite(Number(p.official)))
      .map((p) => ({ local: Number(p.local), official: Number(p.official), ts: Number(p.ts) || Date.now() }))
      .slice(-50);
  } catch {
    return [];
  }
}

export function loadCalibPoints(): CalibPoint[] {
  // v0.7.4 起校准点以样本库为主存储（实验室回填写入 quaiwei.zhuque.samples），
  // 这里合并"样本库派生 + 旧版手动点"并去重，主面板与实验室看到同一份数据
  return collectPoints();
}

export function saveCalibPoints(points: CalibPoint[]): void {
  try {
    localStorage.setItem(K_CALIB, JSON.stringify(points.slice(-50)));
  } catch {
    /* 存储不可用则忽略 */
  }
}

/** 追加一个校准点（本地综合分 ↔ 官方分）。只写旧版 key，
 *  样本库派生的点由 collectPoints 合并，避免把样本库数据复制一份进 legacy。 */
export function addCalibPoint(local: number, official: number): Calibration {
  saveCalibPoints([...readLegacyPoints(), { local, official, ts: Date.now() }]);
  return fitCalibration(loadCalibPoints());
}

/** 清空全部校准数据：旧版手动点 + 样本库的官方回填字段（样本文本保留，可重新回填） */
export function clearAllCalibration(): void {
  try {
    localStorage.removeItem(K_CALIB);
  } catch {
    /* noop */
  }
  clearOfficialResults();
}

export function clearCalibPoints(): void {
  try {
    localStorage.removeItem(K_CALIB);
  } catch {
    /* noop */
  }
}

export function loadCalibration(): Calibration {
  return fitCalibration(loadCalibPoints());
}

/* ----------------------------- 门检提示 ----------------------------- */

/** 送检前的人话提示：字数不达标/超长时说明后果 */
export function submissionAdvice(chars: number): string {
  if (chars === 0) return "没有可送检的内容";
  if (chars < ZHUQUE_MIN_CHARS) {
    return `仅 ${chars} 字，低于官方 ${ZHUQUE_MIN_CHARS} 字门槛，官方页面大概率不给结果`;
  }
  if (chars > ZHUQUE_SUGGEST_MAX) {
    return `${chars} 字，超过建议的 ${ZHUQUE_SUGGEST_MAX} 字，已按句子边界截取前 ${ZHUQUE_SUGGEST_MAX} 字送检`;
  }
  return `${chars} 字，符合官方送检区间（${ZHUQUE_MIN_CHARS}~${ZHUQUE_SUGGEST_MAX}）`;
}
