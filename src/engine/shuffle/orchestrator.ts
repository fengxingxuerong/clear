/**
 * 机械扰动层 · 公共 API 编排（crossChunkCleanup / mechanicalShuffle，
 * 自 humanize-shuffle.ts 拆出，逐字搬移）。导入面兼容由 ../humanize-shuffle.ts 门面统一 re-export。
 */
import { makeRng, MIN_BURSTINESS_CV, HumanizeOptions, isSceneBlockLine } from "../humanize-data.ts";
import { classifyGenre } from "../classify-genre.ts";
import {
  relaxEmDash,
  relaxDunhao,
  relaxColon,
  relaxQuotes,
  splitOnConnectors,
  dedupePadWords,
  dedupeStarters,
  limitPunctuation,
  varyParagraphs,
  reframeConcessives,
  injectHalfWidth,
  stripAICliches,
  stripLeadingConnectivesHard,
  stripCJKEdgeSpaces,
} from "./primitives.ts";
import { boostBurstiness, boostBurstinessIfLow } from "./burstiness.ts";
import {
  structuralShuffleParagraph,
  resegmentParagraphsAggressive,
  enforceParagraphLeadSentVariance,
  ensureEmDashCountHardCap,
  injectFirstPersonAnchorPoints,
} from "./structure.ts";
import { injectHumanTypos } from "./typos.ts";
import { preDetectHumanFingerprint, classifyExpositionScore } from "./fingerprint.ts";

export function crossChunkCleanup(text: string, stripCJKSpaces = false): string {
  let out = text;
  out = dedupePadWords(out);
  out = dedupeStarters(out);
  out = limitPunctuation(out, "——", 1, "，");
  out = limitPunctuation(out, "……", 1, "。");
  out = stripLeadingConnectivesHard(out);
  out = stripAICliches(out);
  out = stripCJKEdgeSpaces(out, stripCJKSpaces);
  return out;
}

export function mechanicalShuffle(text: string, opts: HumanizeOptions = {}): string {
  const style = opts.style ?? "plain";
  if (!text || !text.trim()) return "";

  // P7-extra 引擎级体裁联动（与 humanize() 同一套旋钮语义，独立调用入口也生效）：
  //  · humanHand → 强度钳制 ≤0.48、关错别字/第一人称锚点、跳过场景块自问自答
  //  · main + 强度≥0.75 → expoForceP3 强制开 P3（覆盖 expoScore 略低于 0.55 的边缘论说文）
  //  · dialogue → 剧本【场景/人物/背景】块跳过自问自答
  const genreKnob = opts.genre ?? classifyGenre(text).genre;
  const isHumanHandGenre = genreKnob === "humanHand";
  const isDialogueGenre = genreKnob === "dialogue";

  // 2026-08-26 v2：真人指纹预检。命中 → 降级，修复"H0→H1/H2越去味越差"
  const zhuqueBoost = (opts.zhuqueMode ?? false) && !isHumanHandGenre;
  const finger = preDetectHumanFingerprint(text);
  const baseIntensity = Math.max(0, Math.min(1, opts.intensity ?? 0.3));
  let intensity = baseIntensity;
  let disableTypos = false;
  let disableFirstPerson = false;
  if (finger.isHumanHand || isHumanHandGenre) {
    intensity = Math.min(intensity, 0.48);
    disableTypos = true;
    disableFirstPerson = true;
  }
  const rng = makeRng(opts.seed);
  // 2026-08-26 v2 P3：体裁预检（论说文才上 P3-1~P3-4）
  //   P7-B：显式 genre==main 且强度≥0.75 时放宽到 expoScore≥0.35（强制覆盖边缘论说文）
  const textExpoScore = classifyExpositionScore(text);
  const applyExpoP3 =
    zhuqueBoost &&
    (genreKnob === "main" && intensity >= 0.75 ? textExpoScore >= 0.35 : textExpoScore >= 0.55);
  // zhuqueBoost → 论说锚点(P3-4)、段首方差(P3-3)要求强度≥0.85，把用户传 0.7 自动升档到 0.9
  const effAnchorIntensity = applyExpoP3 ? Math.max(intensity, 0.9) : intensity;

  // P8 场景块全格式保真：relax 段按行护盾——relaxColon 会把【场景：…】改成【场景，…】
  const relaxLine = (ln: string): string => {
    if (isSceneBlockLine(ln)) return ln;
    let w = relaxEmDash(ln, rng, 0.4 * intensity);
    w = relaxDunhao(w, rng, 0.4 * intensity);
    w = relaxColon(w, rng, 0.3 * intensity);
    w = relaxQuotes(w, rng, 0.25 * intensity);
    w = splitOnConnectors(w, rng, 0.25 * intensity);
    return w;
  };
  let working = text.split("\n").map(relaxLine).join("\n");
  if (intensity >= 0.5) {
    working = working
      .split(/\n\n+/)
      .map((p) => {
        const s = structuralShuffleParagraph(p, rng, intensity, {
          zhuqueMode: zhuqueBoost,
          // P7-B/P7-E：体裁联动参数透传给结构层
          expoForceP3: applyExpoP3,
          skipSceneInject: isDialogueGenre,
          // v0.9 专家修复 P5：文风透传（academic 禁口语承接头/自问自答）
          style,
        });
        // P3-3 段首句长硬方差（仅论说文，避免对话体/叙事文体被硬切段首 → AI 特征反涨）
        if (applyExpoP3) return enforceParagraphLeadSentVariance(s, rng, intensity);
        return s;
      })
      .join("\n\n");
  }
  working = dedupePadWords(working);
  working = dedupeStarters(working);
  working = limitPunctuation(working, "——", 1, "，");
  working = limitPunctuation(working, "……", 1, "。");
  working = boostBurstiness(working, rng, 0.6 * intensity, style);
  working = varyParagraphs(working, rng, 0.5 * intensity);
  working = resegmentParagraphsAggressive(working, rng, intensity);
  // v2 P3-3：段首句长硬方差（跨段全局二次，激进版）→ 仅论说文
  if (applyExpoP3) {
    working = enforceParagraphLeadSentVariance(working, rng, intensity);
  }
  working = stripLeadingConnectivesHard(working);
  working = stripAICliches(working);
  working = stripCJKEdgeSpaces(working, opts.stripCJKSpaces ?? false);
  working = reframeConcessives(working, rng, Math.min(1, 0.5 + 0.5 * intensity));
  working = injectHalfWidth(working, rng, 0.04 * intensity);
  // v2 P3-4：第一人称经验锚点（真人原稿禁用 + 只限论说文，避免叙事/对话再塞第一人称变成重复 → aiScore 反涨）
  if (!disableFirstPerson && applyExpoP3) {
    working = injectFirstPersonAnchorPoints(working, rng, effAnchorIntensity);
  }
  // v3 P4-B：burstiness<目标值时，针对最长句在逗号中点处切段、注入"不过话说/讲真…"类超短句锚，快速拉 CV 到目标档
  //        （对叙事/对话档特别有用，N2=0.53、D2=0.49 均低于阈值）
  //   P7-C：按体裁分档 burst 目标（论说0.63 / 叙事0.59 / 对话0.57 / 人写0.50），人写档最松防负斜率反噬
  if (intensity >= 0.4) {
    const burstTarget =
      genreKnob === "main" ? 0.63 : genreKnob === "narrative" ? 0.59 : isDialogueGenre ? 0.57 : 0.5;
    working = boostBurstinessIfLow(
      working,
      rng,
      Math.max(MIN_BURSTINESS_CV, burstTarget),
      4,
      style,
    );
  }
  // v3 P4-A + 二次标点保险：最终清尾确保整篇「——」≤1、「……」≤1，解决 N2/D2 指纹检测红项
  working = limitPunctuation(working, "——", 1, "，");
  working = limitPunctuation(working, "……", 1, "。");
  working = ensureEmDashCountHardCap(working, 1);
  // v0.8 P2-1：错别字（真人原稿禁用）
  if (!disableTypos) {
    working = injectHumanTypos(working, rng, intensity);
  }
  return working
    .replace(/—{3,}/g, "——")
    .replace(/——(?=[。！？!?])/g, "")
    .replace(/(^|\n)\s*[。，、；：]+/g, "$1")
    .replace(/但，/g, "但")
    .replace(/([，、])\1+/g, "$1")
    .replace(/，。/g, "。")
    .replace(/。，/g, "。")
    .trim();
}
