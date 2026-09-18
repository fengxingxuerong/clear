/**
 * 趣AI味 · 多候选择优（bestOf，自 C 盘副本 v0.7.4 吸收）
 *
 * 本地引擎是"随机采样"式的改写：同一个种子出一种写法，换个种子就是另一稿。
 * 评选不能只看分——分低往往是"改得最狠"的那稿，可能已经改坏。四重硬门槛：
 *   1) 忠实度：数字/英文术语被改坏直接淘汰（checkFidelityLocal）
 *   2) 改动幅度：长度比跑出 [0.6, 1.4] 说明改过头或几乎没改
 *   3) 成句：谓语被删成光杆主语的直接淘汰（collapseIssues）——aiScore 对这种塌句给 0 分，
 *      不拦就等于用"目标函数最低"奖励"删得最狠"
 *   4) 高危指纹：一票抓的把柄（套话残留/垫词复读/空格指纹）优先于分数排序
 */

import {
  humanize,
  aiScore,
  checkFidelityLocal,
  collapseIssues,
  fingerprintCheck,
  type ScoreBreakdown,
  type FingerprintReport,
} from "./humanize";
import type { HumanizeOptions } from "./humanize-primitives";

export interface BestOfOptions extends HumanizeOptions {
  /** 候选稿数量（不传则按文本长度自动定 4~10） */
  candidates?: number;
}

export interface BestOfResult {
  text: string;
  before: ScoreBreakdown;
  after: ScoreBreakdown;
  /** 实际生成的候选数 */
  tried: number;
  /** 被三重门槛淘汰的候选数 */
  rejected: number;
  /** 中选稿的种子（可复现） */
  seed: number;
  /** 中选稿的指纹体检 */
  fingerprint: FingerprintReport;
}

export function humanizeBestOf(text: string, opts: BestOfOptions = {}): BestOfResult {
  const before = aiScore(text);
  const base = opts.seed ?? Date.now() & 0xffffffff;
  // 长文本收敛候选数：引擎是纯字符串操作，单候选 O(n)，长文跑太多种子会卡 UI
  const auto = text.length > 4000 ? 4 : text.length > 1500 ? 6 : 10;
  const n = Math.max(1, Math.min(30, Math.round(opts.candidates ?? auto)));
  const srcLen = text.replace(/\s/g, "").length || 1;

  type Cand = {
    text: string;
    after: ScoreBreakdown;
    seed: number;
    fp: FingerprintReport;
    rank: number;
  };
  let best: Cand | null = null;
  let rejected = 0;

  for (let i = 0; i < n; i++) {
    // 质数步长，保证各候选的种子在 mulberry32 空间里足够分散
    const seed = (base + i * 7919) & 0xffffffff;
    const out = humanize(text, { ...opts, seed });
    if (!out.trim()) continue;

    const fid = checkFidelityLocal(text, out);
    const fp = fingerprintCheck(out);
    // D 盘引擎的 FingerprintIssue 全部是硬把柄（无 warn/hint 分级），计数即高危指纹数
    const warns = fp.issues.length;
    const ratio = (out.replace(/\s/g, "").length || 1) / srcLen;
    const collapse = collapseIssues(text, out);
    if (!fid.pass || ratio < 0.6 || ratio > 1.4 || collapse.length) {
      rejected++;
      continue;
    }

    const after = aiScore(out);
    // 排序：高危指纹优先（把柄比分数更要命），其次本地分
    const rank = warns * 1000 + after.score;
    if (!best || rank < best.rank) best = { text: out, after, seed, fp, rank };
  }

  if (!best) {
    // 全部被淘汰：退回单次生成，保证一定有输出（不静默返回空）
    const out = humanize(text, opts);
    return {
      text: out,
      before,
      after: aiScore(out),
      tried: n,
      rejected,
      seed: base,
      fingerprint: fingerprintCheck(out),
    };
  }
  return {
    text: best.text,
    before,
    after: best.after,
    tried: n,
    rejected,
    seed: best.seed,
    fingerprint: best.fp,
  };
}
