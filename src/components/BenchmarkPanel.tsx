/**
 * 趣AI味 · 对标评分面板：深度轮次分、LLM 评判、外部检测器、朱雀送检回填、
 * 以及本地代理分 → 官方朱雀分的标定预测（v3 四体裁分层制 18 点 OLS，
 * 见 docs/fingerprint-and-zhuque-calibration.md §3 + scripts/zhuque-calibration-v3.txt）。
 *
 * v3 更新（2026-08-26）：
 *  · 样本数从 v2 的 12 点 → v3 18 点（送官网新检 6 点 + v2 归档 12 点）
 *  · 各体裁 R² 普遍提升：论说 0.962→0.98（n=3→5）/ 叙事 0.998→0.99 / 对话 0.998→1.00（n=3→5）/ 人写 0.75→0.77
 *  · 论说过人线仍为 aiScore ≤ 10.4；叙事放宽至 12.6；对话保持 ≈ 20.5；人写负斜率天然过人
 */
import { useState, useMemo, useEffect } from "react";
import { DEEP_TARGET_SCORE, type ApiConfig } from "../api/llm";
import type { DetectorConfig } from "../api/detector";
import type { ScoreBreakdown } from "../engine/humanize";
import {
  classifyGenre,
  GENRE_ZH,
  type AutoGenre,
  type GenreResult,
} from "../engine/classify-genre.ts";
import { CALIB, TRACK_ORDER, type CalibTrack, type CalibEntry } from "../engine/zhuque-calib";

/** v3 徽章 & 建议（docs §3.7 规则 + 体裁联动 x40 提示 · v3 18 点 OLS 版） */
function predictAdvice(
  predPct: number,
  score: number | undefined,
  cur: Pick<CalibEntry, "satX" | "x40" | "x40Tag" | "humanWarn" | "advanced" | "label">,
) {
  const saturated =
    !cur.humanWarn && typeof score === "number" && cur.satX < 1e9 && score >= cur.satX;
  const pct = Math.max(0, Math.min(100, predPct));
  /** v3 2026-08-26：离过人线（≤40%）还差 X pp / 已经领先 X pp
   *  —— 正数 = 还差，越大约危险；0 或负数 = 已过（绝对值 = 缓冲安全边际）
   */
  const gapToPass = pct - 40;

  // 进度条：从 0%(深绿) → 40%(过人线白红分界) → 100%(深红)
  // 建议行动卡
  let recAction: string;
  if (cur.humanWarn) {
    recAction =
      "纯人写稿 → 关闭朱雀增强、强度拉到 ≤0.48，仅做轻微 shuffle，禁止注入错别字/自问自答/第一人称锚";
  } else if (pct <= 20) {
    recAction =
      "已稳过。如果还想更稳：跑一轮 intensity 0.9 + 朱雀增强，再补 5pp 边际；或切换叙事/对话体裁公式放宽阈值。";
  } else if (pct <= 40) {
    recAction =
      "已过但离过线近。建议：① 强度调到 0.9+ 开朱雀增强（补 -7~-12pp）② 切换到叙事/对话体裁下拉看放宽后的值 ③ 再跑 1 轮深度闭环；";
  } else if (pct <= 60) {
    recAction =
      "压线 5pp 以上！核心瓶颈是结构（三部曲/编号列举/段首雷同）：① 开朱雀增强 + 强度 0.95 ② 若是论说文，P3 会自动注入第一人称经验锚 + 倒序拆解 ③ 换叙事视角改写";
  } else if (pct <= 80) {
    recAction =
      '高危！词级已基本干净，请重点处理结构：① 把"总分总"的开头和结尾打散 ② "首先/其次/最后"三部曲改插叙颠倒 ③ "1./2./3."编号改反问/括号/补充';
  } else {
    recAction =
      "接近饱和！先用 humanize-vocab 清套话连接词（套话命中 -8 个以上 ≈ -48pp），再走结构级拆解最后再跑 LLM 深度重写。";
  }

  let icon = "🔴";
  let tip = "严重 AI 味（几乎必中官方检测）";
  let tint = "rgba(255,93,108,0.12)";
  let border = "rgba(255,93,108,0.35)";
  let fg = "#ff5d6c";

  if (saturated || pct >= 98) {
    icon = "🔴";
    tip = saturated
      ? `预测已饱和到 98~99% 区（aiScore≥${cur.satX.toFixed(0)} 进入饱和），官方基本必判 AI`
      : "严重 AI 味（几乎必中官方检测）";
  } else if (pct <= 20) {
    icon = "✅";
    tip = `过人区间（${cur.x40 < 0 ? cur.x40Tag : "已过 " + cur.x40Tag}）`;
    tint = "rgba(34,197,94,0.14)";
    border = "rgba(34,197,94,0.4)";
    fg = "#22c55e";
  } else if (pct <= 40) {
    icon = "🟢";
    tip =
      cur.x40 >= 0
        ? `已过 ${cur.x40Tag}；如需更稳，再跑一轮 0.9 朱雀档`
        : `低风险（${cur.x40Tag} 天然过线）`;
    tint = "rgba(61,220,151,0.12)";
    border = "rgba(61,220,151,0.35)";
    fg = "#3ddc97";
  } else if (pct <= 60) {
    icon = "🟡";
    tip =
      cur.x40 >= 0
        ? `中风险：建议压到 ${cur.x40Tag}（强度≥0.9+朱雀增强）`
        : "中风险（对话/叙事体裁放宽阈值）";
    tint = "rgba(250,204,21,0.12)";
    border = "rgba(250,204,21,0.35)";
    fg = "#facc15";
  } else if (pct <= 80) {
    icon = "🟠";
    tip = "高风险；加深 1~2 档；必要时改写成叙事/对话体裁（阈值更宽松）";
    tint = "rgba(249,115,22,0.12)";
    border = "rgba(249,115,22,0.35)";
    fg = "#fb923c";
  }

  // 副线/人写线：顶部打横幅提示
  const banner: string | null = cur.humanWarn
    ? "🚩 若确认是 100% 纯人写原稿：请不要跑去味！H0 实测不去味=15%，跑去味反而升到 17~19%（越跑越像 AI）。docs §3.5.3"
    : cur.advanced
      ? "⚠️ 副线仅存档" + cur.label + "的拼接送检流程，显示的预测值不能用于交付件阈值判断"
      : null;

  // 2026-08-26 v3："还差 X pp / 领先 Y pp"
  const gapAbs = Math.abs(gapToPass).toFixed(1);
  const badge = {
    text:
      gapToPass > 0
        ? `⚠️ 离过人线还差 ${gapAbs} pp`
        : gapToPass === 0
          ? "🤏 刚好过人线"
          : `✅ 领先过人线 ${gapAbs} pp 边际`,
    color:
      gapToPass <= 0
        ? "#22c55e"
        : gapToPass <= 5
          ? "#facc15"
          : gapToPass <= 20
            ? "#fb923c"
            : "#ff5d6c",
  };

  // 进度条刻度：0 |-- 绿 --| 40(过人线白红分界) |-- 黄/橙/红 --| 100
  const passRatio = 0.4; // 40%
  const ratio = pct / 100;
  const progressBg: React.CSSProperties = {
    position: "relative",
    width: "100%",
    height: 10,
    borderRadius: 999,
    background:
      "linear-gradient(90deg, #0b5e2f 0%, #22c55e 28%, #3ddc97 40%, #facc15 52%, #fb923c 75%, #ff5d6c 100%)",
    overflow: "hidden",
    marginTop: 4,
    marginBottom: 4,
  };
  const progressCursor: React.CSSProperties = {
    position: "absolute",
    top: -3,
    left: `calc(${ratio * 100}% - 7px)`,
    width: 14,
    height: 16,
    background: fg,
    border: "2px solid #fff",
    borderRadius: 4,
    transform: "rotate(45deg)",
    boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
  };
  const passTick: React.CSSProperties = {
    position: "absolute",
    top: -4,
    left: `calc(${passRatio * 100}% - 1px)`,
    width: 2,
    height: 18,
    background: "#ffffff",
    boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
  };

  return {
    icon,
    tip,
    tint,
    border,
    fg,
    banner,
    saturated,
    pct,
    gapToPass,
    badge,
    progressBg,
    progressCursor,
    passTick,
    recAction,
  };
}

interface BenchmarkPanelProps {
  output: string;
  after: ScoreBreakdown | null;
  roundScores: number[];
  judging: boolean;
  detecting: boolean;
  api: ApiConfig;
  detector: DetectorConfig;
  judgeScore: number | null;
  judgeCritique: string[];
  detectorScore: number | null;
  zhuqueManualScore: string;
  onJudge: () => void;
  onDetect: () => void;
  onManualScore: (v: string) => void;
  /** 用户手动切换体裁轨道时上抛；null = 回到自动识别 */
  onGenreChange?: (g: "main" | "narrative" | "dialogue" | "humanHand" | null) => void;
  onNote: (v: string) => void;
}

export function BenchmarkPanel({
  output,
  after,
  roundScores,
  judging,
  detecting,
  api,
  detector,
  judgeScore,
  judgeCritique,
  detectorScore,
  zhuqueManualScore,
  onJudge,
  onDetect,
  onManualScore,
  onGenreChange,
  onNote,
}: BenchmarkPanelProps) {
  const [track, setTrack] = useState<CalibTrack>("main");
  // 用户手动切过下拉 → 自动识别不再覆盖；点击「回到自动」按钮重置为 false
  const [trackOverrideByUser, setTrackOverrideByUser] = useState(false);

  // P6-C 自动体裁识别（memo：output 引用变化才重算）
  const auto: GenreResult | null = useMemo(() => {
    if (!output) return null;
    return classifyGenre(output);
  }, [output]);

  // 自动识别完成后，如果用户未手动 override，把轨道同步为识别结果
  useEffect(() => {
    if (!auto || trackOverrideByUser) return;
    const mapped = auto.genre as AutoGenre;
    setTrack((prev) => (prev === mapped ? prev : mapped));
  }, [auto, trackOverrideByUser]);

  // Hooks 规则：提前 return 必须放在所有 hook 之后，
  // 否则 output 从空变非空时 hook 数量变化会直接崩掉整棵树
  if (!output) return null;

  // 用户手动切换下拉 → 标记 override
  function onTrackChange(next: CalibTrack) {
    setTrack(next);
    // P7 引擎联动：把用户选的体裁上抛给 App → runHumanize，让引擎 knobs 真正跟随界面
    if (onGenreChange) {
      if (next === "human") onGenreChange("humanHand");
      else if (next === "main" || next === "narrative" || next === "dialogue") onGenreChange(next);
      else onGenreChange(null); // concat 副线不指定引擎体裁，走自动识别
    }
    // 仅当用户选的值和 auto 不一样才算 override；如果用户手动选的恰好等于 auto 就保持自动模式
    if (auto && next !== auto.genre) setTrackOverrideByUser(true);
    else if (auto && next === auto.genre) setTrackOverrideByUser(false);
    // 选副线 concat 或 human 时也标记 override（自动识别永远不会选这两条）
    if (next === "human" || next === "concat") setTrackOverrideByUser(true);
  }
  // 「回到自动识别」按钮：清 override 标记，并立即按当前 auto 重切轨道
  function resetToAuto() {
    setTrackOverrideByUser(false);
    if (auto) setTrack(auto.genre as AutoGenre);
    // 回到自动 → 清除引擎级 genre 强制，交还 classifyGenre 自动判定
    onGenreChange?.(null);
  }

  const score = after?.score;
  const cur = CALIB[track];
  let predPct: number | null = null;
  let adv: ReturnType<typeof predictAdvice> | null = null;
  if (typeof score === "number" && !Number.isNaN(score)) {
    predPct = cur.a * score + cur.b;
    adv = predictAdvice(predPct, score, cur);
  }

  return (
    <div className="bench">
      <div className="bench-head">对标评分（真实通道，非本地代理分）</div>
      {roundScores.length > 0 && (
        <div className="bench-row">
          <span>
            深度去味各轮 LLM 评分：
            <b>{roundScores.map((s) => (s < 0 ? "失败" : s)).join(" → ")}</b>（目标 ≤
            {DEEP_TARGET_SCORE}）
          </span>
        </div>
      )}
      <div className="bench-row">
        <span>
          本地代理分（去味后）：<b>{after?.score}</b>
        </span>
        <button
          className="ghost sm"
          onClick={onJudge}
          disabled={!api.enabled || !api.apiKey || judging}
        >
          {judging ? "评判中…" : "用 LLM 评判"}
        </button>
        {judgeScore !== null && <span className="tag">LLM 评判：{judgeScore}</span>}
      </div>
      {judgeScore !== null && judgeCritique.length > 0 && (
        <div className="bench-row" style={{ flexWrap: "wrap" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            残留痕迹：{judgeCritique.join("；")}
          </span>
        </div>
      )}
      <div className="bench-row">
        <button
          className="ghost sm"
          onClick={onDetect}
          disabled={!detector.enabled || !detector.url || detecting}
        >
          {detecting ? "检测中…" : "用外部检测器"}
        </button>
        {detectorScore !== null && <span className="tag">检测器：{detectorScore}</span>}
      </div>

      {/* ========= v3 四体裁分层 · 官方朱雀%预测（18 点 OLS） ========= */}
      {predPct !== null && adv && (
        <div
          className="bench-row"
          style={{
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
            background: adv.tint,
            border: `1px solid ${adv.border}`,
            borderRadius: 10,
            padding: "8px 10px",
          }}
        >
          {adv.banner && (
            <div
              style={{
                width: "100%",
                fontSize: 12,
                fontWeight: 600,
                padding: "4px 6px",
                borderRadius: 6,
                marginBottom: 2,
                background: adv.banner.startsWith("🚩")
                  ? "rgba(251,146,60,0.12)"
                  : "rgba(148,163,184,0.12)",
                color: adv.banner.startsWith("🚩") ? "#fb923c" : "var(--muted)",
                border: adv.banner.startsWith("🚩")
                  ? "1px solid rgba(251,146,60,0.35)"
                  : "1px solid var(--border)",
              }}
            >
              {adv.banner}
            </div>
          )}
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            官方朱雀%预测（v3 四体裁分层 18 点 OLS）：
          </span>
          <b style={{ color: adv.fg }}>
            {adv.icon} {adv.pct.toFixed(1)}%
          </b>
          {/* 2026-08-26 v3：「离过人线还差 X pp」进度徽章 */}
          <span
            className="tag"
            style={{
              color: adv.badge.color,
              background: adv.badge.color + "20",
              border: `1px solid ${adv.badge.color}70`,
              fontSize: 12,
              fontWeight: 700,
              padding: "3px 8px",
              borderRadius: 999,
              whiteSpace: "nowrap",
            }}
          >
            {adv.badge.text}
          </span>
          <span style={{ fontSize: 12, color: adv.fg }}>{adv.tip}</span>
          {/* P6-C 自动识别徽章（放在下拉前，marginLeft:auto 推送到最右和下拉并排）*/}
          {auto && (
            <span
              className="tag"
              title={`自动识别详情 · 规则 R${auto.ruleHit}：对话dQ=${auto.features.dlgQuoteRatio.toFixed(3)}/dC=${auto.features.dlgColonRatio.toFixed(2)} · 论说分=${auto.features.expoScore.toFixed(2)} · 叙事past=${auto.features.narPastRatio.toFixed(3)}/scene=${auto.features.narSceneRatio.toFixed(3)} · 短句占比=${(auto.features.dlgShortTurn * 100).toFixed(0)}%`}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                border: trackOverrideByUser
                  ? "1px solid rgba(250,204,21,0.55)"
                  : `1px solid ${auto.confidence >= 0.7 ? "rgba(34,197,94,0.5)" : "rgba(148,163,184,0.5)"}`,
                background: trackOverrideByUser
                  ? "rgba(250,204,21,0.1)"
                  : auto.confidence >= 0.7
                    ? "rgba(34,197,94,0.09)"
                    : "rgba(148,163,184,0.08)",
                color: trackOverrideByUser
                  ? "#facc15"
                  : auto.confidence >= 0.7
                    ? "#3ddc97"
                    : "var(--muted)",
                whiteSpace: "nowrap",
                marginLeft: 6,
              }}
            >
              {trackOverrideByUser ? "⚙️ 手动轨道" : "🤖 自动识别"}
              {!trackOverrideByUser &&
                `：${GENRE_ZH[auto.genre]} ${(auto.confidence * 100).toFixed(0)}%`}
              {trackOverrideByUser && auto && (
                <button
                  className="ghost sm"
                  onClick={resetToAuto}
                  title="根据当前文本，按自动识别结果切回轨道（v3 18点 OLS 公式）"
                  style={{
                    marginLeft: 6,
                    padding: "1px 8px",
                    fontSize: 11,
                    color: "#facc15",
                    border: "1px solid rgba(250,204,21,0.45)",
                    background: "rgba(250,204,21,0.08)",
                    borderRadius: 999,
                  }}
                >
                  回到自动
                </button>
              )}
            </span>
          )}
          <select
            value={track}
            onChange={(e) => onTrackChange(e.target.value as CalibTrack)}
            title="体裁切换：按当前文本实际体裁选对应的分层公式（docs §3.3 四体裁分线）。系统默认自动选择，手动切换后显示「手动轨道」可按按钮回到自动。"
            style={{
              marginLeft: 8,
              fontSize: 12,
              background: "rgba(8,12,22,0.6)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "4px 6px",
              outline: "none",
            }}
          >
            <optgroup label="体裁（v3 四分层 · 18 点 OLS · 2026-08-26）">
              {TRACK_ORDER.filter((k) => CALIB[k].group === "体裁(v3)").map((k) => (
                <option key={k} value={k}>
                  {CALIB[k].label}
                </option>
              ))}
            </optgroup>
            <optgroup label="高级（副线/存档）">
              {TRACK_ORDER.filter((k) => CALIB[k].group === "高级(副线)").map((k) => (
                <option key={k} value={k}>
                  {CALIB[k].label}
                </option>
              ))}
            </optgroup>
          </select>

          {/* 2026-08-26 v3：过人线进度条（0→深绿，40%白红分界）*/}
          <div style={{ width: "100%" }}>
            <div style={adv.progressBg}>
              <div style={adv.passTick} title="过人线 = 40%" />
              <div style={adv.progressCursor} title={`当前预测朱雀 ${adv.pct.toFixed(1)}%`} />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 10,
                color: "var(--muted)",
                marginTop: 2,
              }}
            >
              <span>0% (深绿)</span>
              <span style={{ color: "#ffffff" }}>▌过人线 40%</span>
              <span>100% (深红)</span>
            </div>
          </div>

          {/* 2026-08-26 v3：建议行动卡片 */}
          <div
            style={{
              width: "100%",
              fontSize: 12,
              color: "var(--text)",
              padding: "6px 10px",
              background: "rgba(15, 23, 42, 0.45)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              lineHeight: 1.55,
            }}
          >
            <span style={{ color: "var(--muted)", fontSize: 11 }}>
              💡 建议行动 · 基于当前预测分 {adv.pct.toFixed(1)}% 的下一次操作：
            </span>
            <div style={{ marginTop: 3 }}>{adv.recAction}</div>
          </div>

          <div
            style={{
              width: "100%",
              fontSize: 11,
              color: "var(--muted)",
              marginTop: 2,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>
              公式：朱雀% ≈ clamp({cur.a.toFixed(3)} × aiScore + {cur.b.toFixed(2)}, 0, 100)
              &nbsp;·&nbsp;
              {cur.x40 >= 0 ? `${cur.x40Tag}` : cur.x40Tag}
              &nbsp;·&nbsp;
              {cur.note}
            </span>
            {/* P6-C 快捷：当系统判断像「纯人写稿（past 极高+论说分低+无对话特征）」时提示一键切 human 负斜率轨道 */}
            {auto &&
              auto.features.narPastRatio >= 0.04 &&
              auto.features.expoScore < 0.35 &&
              auto.features.dlgColonRatio < 0.03 &&
              auto.genre === "narrative" &&
              track !== "human" && (
                <button
                  className="ghost sm"
                  onClick={() => onTrackChange("human")}
                  title="系统检测到极多过去时(口述回忆) + 低论说分 + 无对话，疑似纯人写原稿 → 切换到负斜率轨道 (朱雀%不随去味下降，H0=15% 天然过人)"
                  style={{
                    fontSize: 11,
                    padding: "2px 10px",
                    color: "#fb923c",
                    border: "1px solid rgba(251,146,60,0.5)",
                    background: "rgba(251,146,60,0.1)",
                    borderRadius: 999,
                  }}
                >
                  🚩 疑似纯人写原稿 → 切负斜率轨道(H0 官=15%)
                </button>
              )}
            {auto && track === "human" && (
              <button
                className="ghost sm"
                onClick={resetToAuto}
                style={{
                  fontSize: 11,
                  padding: "2px 10px",
                  color: "#3ddc97",
                  border: "1px solid rgba(61,220,151,0.5)",
                  background: "rgba(61,220,151,0.1)",
                  borderRadius: 999,
                }}
              >
                ↩️ 已确认有 AI 参与生成 → 回到三分自动识别
              </button>
            )}
          </div>
        </div>
      )}

      {/* 朱雀免费版：半自动送检——复制文本 + 打开网页，用户手动检测后回填分 */}
      <div className="bench-row">
        <button
          className="ghost sm"
          onClick={() => {
            if (!output) return;
            navigator.clipboard?.writeText(output);
            window.open("https://matrix.tencent.com/ai-detect/ai_gen_txt/", "_blank");
            onNote("已复制去味文本并打开朱雀检测页——粘贴检测后，在下方填入朱雀分");
          }}
          disabled={!output}
        >
          🔍 朱雀送检（免费网页版）
        </button>
        <input
          type="number"
          min={0}
          max={100}
          value={zhuqueManualScore}
          onChange={(e) => onManualScore(e.target.value)}
          placeholder="朱雀分"
          style={{
            width: 80,
            background: "rgba(8,12,22,0.7)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 8px",
            outline: "none",
          }}
        />
        {zhuqueManualScore && (
          <span
            className="tag"
            style={{
              color: Number(zhuqueManualScore) < 30 ? "#3ddc97" : "#ff5d6c",
              borderColor:
                Number(zhuqueManualScore) < 30 ? "rgba(61,220,151,0.3)" : "rgba(255,93,108,0.3)",
              background:
                Number(zhuqueManualScore) < 30 ? "rgba(61,220,151,0.1)" : "rgba(255,93,108,0.1)",
            }}
          >
            朱雀：{zhuqueManualScore} {Number(zhuqueManualScore) < 30 ? "✅" : "❌"}
          </span>
        )}
      </div>
      {!api.enabled && !detector.enabled && (
        <div className="bench-tip">
          对标检测两条路径：<b>① 免费</b>
          ——点上方「朱雀送检」自动复制文本并打开朱雀网页，手动检测后回填分数；
          <b>② 自动</b>——在「设置」里点「填入朱雀默认值」并勾启用：朱雀官方 API 已于 2026-09
          开放（EdgeOne Makers <code>@makers/zhuque-text</code>，每月 50 万 token 免费，只需一个 API
          Key），去味后自动送检。
          <br />
          显示的「官方朱雀%预测」仅为本地代理分对标估算，真实结果以官方网页或 API 直接返回为准。
          <br />
          📌 <b>v3 新（2026-08-26 · 18 点 OLS）</b>：按文本实际体裁切换下拉（论说默认 / 叙事 / 对话
          / 纯人写），阈值会联动重算。本轮 6 点新检最大预测误差仅 +1.8pp。
        </div>
      )}
    </div>
  );
}
