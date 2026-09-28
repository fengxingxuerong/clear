/**
 * 机械扰动层 · P0/P1/P3 结构级去味族（自 humanize-shuffle.ts 拆出，逐字搬移）。
 * 导入面兼容由 ../humanize-shuffle.ts 门面统一 re-export。
 */
import {
  splitSentences,
  sentenceStats,
  findGuardedCutNear,
  RewriteStyle,
  pick,
} from "../humanize-data.ts";
import { fragmentCanStand } from "../humanize-vocab.ts";
import { classifyExpositionScore } from "./fingerprint.ts";

/** 承接词黑名单：以这些词开头的句子「必须」等在前句之后，不能参与重排（否则出病句） */
const SEQUENCE_HEAD_RE =
  // v0.8.9 P0 补充：序号锚词（一是/二是/第一/第二）与因果锚词（因为/由于）原本不在黑名单，
  // 实测工作周报的「一是把接口迁到新网关上了，比预想的麻烦」被拆句后互换，
  // 结果句跑到原因句之前，因果链断裂——这类句子一律不参与重排。
  /^(?:其次|最后|另一方面|另外|此外|而且|更重要的是|因此|于是|这样一来|所以|但是|但|不过|然而|总之|总的来看|归根结底|说白了|也就是说|换句话说|话又说回来|不仅如此|进一步说|再者|再看|反过来看|客观来讲|严格来说|真要说起来|往深了说|往实了说|值得注意的是|值得一提的是|尤为关键的是|尤为重要的是|不容忽视的是|因为|由于|之所以|一是|二是|三是|四是|其一|其二|其三|第一|第二|第三|首先|末了|到头来)/;

/** 总结句尾签名：全文/全段最后一句常以这些短语收束 = 典型「总-分-总」的「尾总」骨架 */
const SUMMARY_TAIL_SIGS = [
  "综上所述",
  "总而言之",
  "总的来说",
  "总的来看",
  "说到底",
  "归根结底",
  "一句话",
  "简而言之",
  "由此可见",
  "这么看",
  "照这么说",
  "本质上",
  "根子上",
  "从根本上",
  "展望未来",
  "面向未来",
  "未来可期",
  "任重而道远",
];

/** 自问自答问句头签名（与 injectSelfQA 模板池对齐） */
const QA_QUESTION_HEAD_RE =
  /^(?:为啥这么说|真的假的|你可能会问|不信|例子呢|有人要抬杠了|这话是不是太绝对|凭什么这么说|听着有点绕|这有什么要紧的|为什么呢|这么说有依据吗|是不是只有这一种解释|这意味着什么|这个判断可靠吗|有没有反例)/;
/** v0.9 专家修复 P4 长尾：答案句同样锁定——QA 对被拆到两段（问句留原位、
 *  答案句被换走）等于注入了一个悬空的半截对话，比不复读更刺眼 */
const QA_ANSWER_HEAD_RE =
  /^(?:因为事实就摆在眼前|这事儿还真不是我瞎编|其实不然|那你自己试试就知道了|我随便举一个你就懂了|别急，我慢慢跟你捋|要紧的在后头|往下看就明白了|换个说法就清楚了|原因其实不复杂|有，而且不难验证|未必，但这一种最直接|至少目前的数据支持它|有，但不足以推翻大方向)/;

/** 判断某一句能否自由移动（不承载序列/因果/承接依赖） */
function sentenceIsFreestanding(s: string): boolean {
  if (SEQUENCE_HEAD_RE.test(s)) return false;
  // v0.9 专家修复 P4 长尾：QA 问句与其答案拆散后各自漂移
  //（「例子呢？」留在原位而「我随便举一个你就懂了。」被换走）——
  // QA 问句头与答案头一律视为非自由句，保持问答绑定
  if (QA_QUESTION_HEAD_RE.test(s) || QA_ANSWER_HEAD_RE.test(s)) return false;
  const plain = s.replace(/^[，。！？!?；；\s]+/, "");
  if (/^(：|——)/.test(plain)) return false;
  return true;
}

/* ---------------- P0-1：段内句序安全重排 ---------------- */
export function shuffleSentencesSafe(
  sentences: string[],
  rng: () => number,
  intensity: number,
): string[] {
  if (intensity < 0.55) return sentences;
  if (sentences.length < 4) return sentences;
  const out = sentences.slice();
  // v0.9 专家修复 P1（句序）：原实现允许任意两个"自由句"远距离互换，
  // 实测把「28nm 背景→7nm 转折→3nm 引入」的因果链打乱成不可读乱序。
  // 自由句判定（无承接词头）挡不住"语义依赖但形式自由"的句子。
  // 现改为只允许「相邻句互换」：足以打破句长均匀指纹，论述顺序基本保持。
  const swapBudget = Math.max(1, Math.floor(out.length * 0.2 * intensity));
  let done = 0;
  for (let attempt = 0; attempt < swapBudget * 4 && done < swapBudget; attempt++) {
    const i = 1 + Math.floor(rng() * (out.length - 1));
    const j = rng() < 0.5 ? i - 1 : i + 1;
    if (j < 0 || j >= out.length) continue;
    if (!sentenceIsFreestanding(out[i]) || !sentenceIsFreestanding(out[j])) continue;
    if (rng() < 0.5) continue;
    [out[i], out[j]] = [out[j], out[i]];
    done++;
  }
  return out;
}

/* ---------------- P0-2：列举结构打散 ---------------- */
export function breakEnumerationStructure(
  sentences: string[],
  rng: () => number,
  intensity: number,
  style: RewriteStyle = "casual",
): string[] {
  if (sentences.length < 2) return sentences;
  if (intensity < 0.5) return sentences;
  const enumStart =
    /^(?:首先|第一[点条个]?|一方面|头一件|一来|先说|头一个|一上来|头一条)(?:[，、]|$)/;
  const startIdx = sentences.findIndex((s) => enumStart.test(s));
  if (startIdx === -1) return sentences;
  const memberRe =
    /^(?:其次|再者|此外|另外|而且|并且|最后|末了|收个尾|最后说一句|二来|再说|接着|第二[点条个]?|第三[点条个]?|另一方面|再一头|那头|从另一头|还有)(?:[，、]|$)/;
  const members: number[] = [startIdx];
  for (let i = startIdx + 1; i < sentences.length; i++) {
    if (memberRe.test(sentences[i])) members.push(i);
    else if (sentences[i].trim().length < 3) continue;
    else break;
  }
  if (members.length < 2) return sentences;
  const out = sentences.slice();
  // (a) 去序列标记：显式切片 + 换为非序列承接头
  // v0.9 专家修复 P5：academic 文风禁用口语承接头（哦对了/然后呢），用书面过渡词
  const HEADS_BY_STYLE: Record<RewriteStyle, string[]> = {
    casual: [
      "再说，",
      "还有，",
      "然后呢，",
      "顺带一提，",
      "哦对了，",
      "再补一句，",
      "换个角度，",
      "",
    ],
    plain: ["再者，", "同时，", "此外，", "从另一个角度看，", ""],
    academic: ["此外，", "在此基础上，", "进一步看，", "另一层面，", ""],
  };
  for (const mi of members) {
    for (const pat of [enumStart, memberRe]) {
      const m = out[mi].match(pat);
      if (m && m.index === 0) {
        const cut = m[0].length;
        const rest = out[mi].slice(cut).replace(/^[，、]/, "");
        if (rng() < 0.4 + 0.3 * intensity) {
          const head = pick(rng, HEADS_BY_STYLE[style]);
          out[mi] = head + rest;
        } else {
          out[mi] = rest;
        }
        break;
      }
    }
  }
  // v0.9 专家修复 P1：删除高强度「乱序成员数组」步骤——列举项之间的
  // 顺序承载内容逻辑（如"首先成本、其次良率"），乱序后语义颠倒。
  // 序列标记清除本身已打散"首先/其次/最后"骨架指纹，顺序保持原文。
  return out;
}

/* ---------------- P0-3：总分总骨架拆解 ---------------- */
export function breakSummaryTail(
  sentences: string[],
  rng: () => number,
  intensity: number,
): { sentences: string[]; splitAfter?: number } {
  if (sentences.length < 4) return { sentences };
  if (intensity < 0.5) return { sentences };
  const last = sentences[sentences.length - 1];
  const hasSummarySig = SUMMARY_TAIL_SIGS.some((sig) => last.includes(sig));
  if (!hasSummarySig) return { sentences };
  const out = sentences.slice();
  const summarySentence = out.pop()!;
  const freeSpots: number[] = [];
  for (let i = 1; i < out.length - 1; i++) {
    if (sentenceIsFreestanding(out[i])) freeSpots.push(i);
  }
  if (freeSpots.length === 0) {
    const mid = Math.max(1, Math.floor(out.length * (0.3 + rng() * 0.3)));
    out.splice(mid, 0, summarySentence);
  } else {
    const spot = freeSpots[Math.floor(rng() * freeSpots.length)];
    out.splice(spot + 1, 0, summarySentence);
  }
  if (intensity >= 0.75 && out.length >= 5) {
    const splitAfter = Math.floor(out.length * (0.55 + rng() * 0.2));
    return { sentences: out, splitAfter };
  }
  return { sentences: out };
}

/* ---------------- P0-4：段落重切激进版 ---------------- */
export function resegmentParagraphsAggressive(
  text: string,
  rng: () => number,
  intensity: number,
): string {
  if (intensity < 0.55) return text;
  const raw = text.split(/\n{2,}/).filter((s) => s.trim());
  if (raw.length < 2) return text;
  const statsFn = (p: string) => {
    const s = splitSentences(p);
    return { sentences: s.length, chars: p.replace(/\s/g, "").length };
  };
  const paraStats = raw.map(statsFn);
  const lens = paraStats.map((s) => s.chars);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const std = Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length);
  const cv = avg > 0 ? std / avg : 1;
  const needForce = cv < 0.45; // 段长 CV 严重均匀（人类通常 >0.6） → 强制至少一刀
  const out: string[] = [];
  let i = 0;
  let forceOneDone = false;
  while (i < raw.length) {
    const cur = raw[i];
    const ps = paraStats[i];
    const next = raw[i + 1];
    const ns = paraStats[i + 1];
    // (a) 相邻两段都 AI 典型 → 合并（概率 + 碎碎念桥接）
    if (
      next !== undefined &&
      ps.sentences >= 2 &&
      ps.sentences <= 4 &&
      ps.chars >= 50 &&
      ps.chars <= 180 &&
      ns.sentences >= 2 &&
      ns.sentences <= 4 &&
      ns.chars >= 50 &&
      ns.chars <= 180 &&
      (needForce ? !forceOneDone && rng() < 0.85 : rng() < 0.35 + 0.35 * intensity)
    ) {
      let merged = cur + "\n\n" + next;
      if (rng() < 0.55 + 0.25 * intensity) {
        const bridge = pick(rng, [
          "是这个理。",
          "嗯，对。",
          "你别说。",
          "哈哈。",
          "懂吧。",
          "",
          "",
          "",
        ]);
        if (bridge) merged = cur + "\n\n" + bridge + "\n\n" + next;
      }
      out.push(merged);
      i += 2;
      if (needForce) forceOneDone = true;
      continue;
    }
    // (b) 当前段 AI 典型 → 拆两段
    if (
      ps.chars >= 80 &&
      ps.chars <= 220 &&
      ps.sentences >= 3 &&
      (needForce ? !forceOneDone && rng() < 0.85 : rng() < 0.3 + 0.35 * intensity)
    ) {
      const sents = splitSentences(cur);
      const splitIdx = Math.max(
        1,
        Math.min(sents.length - 2, Math.ceil(sents.length * (0.35 + rng() * 0.3))),
      );
      const first = sents.slice(0, splitIdx).join("");
      const second = sents.slice(splitIdx).join("");
      if (first.trim() && second.trim()) {
        out.push(first, second);
        i++;
        if (needForce) forceOneDone = true;
        continue;
      }
    }
    out.push(cur);
    i++;
  }
  return out.join("\n\n");
}

/* =========================================================
   P1 句式级优化（排比对仗破坏 + 自问自答注入）
   ========================================================= */

/* ---------------- P1-1：排比/对仗结构破坏 ---------------- */
export function deParallelizeStructure(
  sentences: string[],
  rng: () => number,
  intensity: number,
): string[] {
  if (sentences.length < 3) return sentences;
  if (intensity < 0.55) return sentences;
  // 找连续 3+ 句共同开头签名：前 2~5 个 CJK/ASCII 字重复
  const headKey = (s: string) => {
    const clean = s.replace(/^[，。！？!?；;\s]+/, "");
    const m = clean.match(/^[\u4e00-\u9fa5A-Za-z]{2,5}/);
    return m ? m[0] : "";
  };
  const out: string[] = [];
  let runSents: string[] = [];
  let curHead = "";
  for (let idx = 0; idx < sentences.length; idx++) {
    const s = sentences[idx];
    const h = headKey(s);
    if (h && h === curHead) {
      runSents.push(s);
      continue;
    }
    if (runSents.length >= 3) fixParallelRun(out, runSents, rng, intensity);
    else runSents.forEach((rs) => out.push(rs));
    runSents = h ? [s] : [];
    curHead = h;
    if (!h) out.push(s);
  }
  if (runSents.length >= 3) fixParallelRun(out, runSents, rng, intensity);
  else runSents.forEach((rs) => out.push(rs));
  return out;
}

function fixParallelRun(
  out: string[],
  runSents: string[],
  rng: () => number,
  intensity: number,
): void {
  const modified = runSents.slice();
  const changeCount = Math.max(
    1,
    Math.min(2, Math.ceil(modified.length * (0.35 + 0.25 * intensity))),
  );
  const changed = new Set<number>();
  for (let c = 0; c < changeCount; c++) {
    let pickIdx = Math.floor(rng() * modified.length);
    let guard = 0;
    while (changed.has(pickIdx) && guard++ < 5) {
      pickIdx = Math.floor(rng() * modified.length);
    }
    if (changed.has(pickIdx)) continue;
    changed.add(pickIdx);
    const roll = rng();
    // 破坏 1：前加自问自答
    if (roll < 0.3 && intensity >= 0.65) {
      const q = pick(rng, ["为什么这么说？", "真的吗？", "有啥道理？", "这是为啥？", "能信？"]);
      modified[pickIdx] = q + modified[pickIdx];
    } else if (roll < 0.65) {
      // 破坏 2：把该句改成反问句（能安全改的句式）或前插不一致开头
      const s = modified[pickIdx];
      const canFlip = /^(?:能|可以|能够|应该|应当|需要|要|会|将|得)[^。！？!?]{4,30}[。]$/.test(s);
      if (canFlip) {
        modified[pickIdx] = s.slice(0, -1) + pick(rng, ["吗？", "吧？", "不成？"]);
      } else {
        modified[pickIdx] =
          pick(rng, ["哦对了，", "再说，", "你想想，", "等一下，", "我是说，", ""]) + s;
      }
    } else {
      // 破坏 3：前插碎碎念短语
      modified[pickIdx] =
        pick(rng, ["是吧，", "哦对，", "等一下，", "我是说，", "哦不对，", ""]) + modified[pickIdx];
    }
  }
  modified.forEach((m) => out.push(m));
}

/* ---------------- P1-2：自问自答注入（AI 极少写） ---------------- */
export function injectSelfQA(
  sentences: string[],
  rng: () => number,
  intensity: number,
  style: RewriteStyle = "casual",
): string[] {
  if (intensity < 0.65) return sentences;
  if (sentences.length < 5) return sentences;
  // v0.9 专家修复 P4：模板池从 6 条扩到 10 条——池子过小导致同模板跨文本复读，
  // "不信？""例子呢？我随便举一个你就懂了"成了 QuAiWei 的出厂指纹。
  // v0.9 专家修复 P5：plain 用克制型（无表演性碎句），academic 由调用方禁用（本函数兜底也拦）。
  const POOLS: Record<RewriteStyle, [string, string][]> = {
    casual: [
      ["为啥这么说？", "因为事实就摆在眼前。"],
      // v0.9.5 修：原为「这事儿还真不是我瞎编。」——对"自身真实性"做断言，
      // 在技术文档里等于凭空声明可信度（读者会问：你为什么要强调自己没编？），
      // 且与本工具的「严禁编造」定位冲突。改为描述读者感受，不做事实主张。
      ["真的假的？", "我知道这听着反常识。"],
      ["你可能会问——", "这不是理所当然的吗？其实不然。"],
      ["不信？", "那你自己试试就知道了。"],
      ["例子呢？", "我随便举一个你就懂了。"],
      ["有人要抬杠了——", "别急，我慢慢跟你捋。"],
      ["这话是不是太绝对？", "细想一下还真不是。"],
      ["凭什么这么说？", "往下看就明白了。"],
      ["听着有点绕？", "换个说法就清楚了。"],
      ["这有什么要紧的？", "要紧的在后头。"],
    ],
    plain: [
      ["为什么呢？", "原因其实不复杂。"],
      ["这么说有依据吗？", "有，而且不难验证。"],
      ["是不是只有这一种解释？", "未必，但这一种最直接。"],
      ["这意味着什么？", "往下看会更清楚。"],
      ["这个判断可靠吗？", "至少目前的数据支持它。"],
      ["有没有反例？", "有，但不足以推翻大方向。"],
    ],
    academic: [],
  };
  const pool = POOLS[style];
  if (pool.length === 0) return sentences;
  // v0.9 专家修复 P4：0.85+ 档注入 2 次改为全文 1 次——两处自问自答
  // 在短文本里已是"连珠炮"，真人频率远低于此。
  const budget = 1;
  const out = sentences.slice();
  let done = 0;
  for (let attempt = 0; attempt < 6 && done < budget; attempt++) {
    const pos = 1 + Math.floor(rng() * (out.length - 2));
    if (!sentenceIsFreestanding(out[pos])) continue;
    const qa = pick(rng, pool);
    out.splice(pos + 1, 0, qa[0] + qa[1]);
    done++;
  }
  return out;
}

/* =========================================================
   结构级段落主入口（被主引擎 + mechanicalShuffle 调用）
   ========================================================= */

/** P7-E：段落内任一行含剧本【场景/人物/背景】块头即视为场景块段落 */
function paraHasSceneBlock(paragraph: string): boolean {
  return paragraph
    .split(/\n/)
    .some((ln) => /【[^】]{0,80}(?:场景|人物|角色|地点|时间|背景|旁白|简介)[^】]{0,80}】/.test(ln));
}
export function structuralShuffleParagraph(
  paragraph: string,
  rng: () => number,
  intensity: number,
  opts: {
    zhuqueMode?: boolean;
    expoForceP3?: boolean;
    skipSceneInject?: boolean;
    skipSelfQA?: boolean; // v0.9.1：narrative/humanHead 跳过全部自问自答
    style?: RewriteStyle;
  } = {},
): string {
  if (intensity < 0.5) return paragraph;
  const sents = splitSentences(paragraph);
  if (sents.length < 3) return paragraph;
  const style = opts.style ?? "plain";
  let working = sents;
  working = breakEnumerationStructure(working, rng, intensity, style);
  const { sentences: afterSummary, splitAfter } = breakSummaryTail(working, rng, intensity);
  working = deParallelizeStructure(afterSummary, rng, intensity);
  // 2026-08-26 v2 P3-1/P3-2：论说结构语义级拆毁（插叙/颠倒顺序/拆编号）
  // P7-B 体裁门控：(zhuqueMode AND expoScore≥0.55) OR (zhuqueMode AND expoForceP3)
  //           → 当 genre==main 且强度≥0.75 时，即使 expo 分略低于 0.55 也拆（覆盖边缘论说文）
  const zhuqueBoost = opts.zhuqueMode ?? false;
  const expoScore = classifyExpositionScore(paragraph);
  const runP3 =
    zhuqueBoost && (expoScore >= 0.55 || (opts.expoForceP3 === true && expoScore >= 0.35));
  if (runP3) {
    working = dismantleExpositionTrilogy(working, rng, intensity);
    working = hardNumberedEnumerationShuffle(working, rng, intensity);
    // P3-3/P3-4 接收的是整段文本（非句数组），需先 join 再继续
    const joined = working.join("");
    const afterVariance = enforceParagraphLeadSentVariance(joined, rng, intensity);
    working = splitSentences(injectFirstPersonAnchorPoints(afterVariance, rng, intensity));
  }
  working = shuffleSentencesSafe(working, rng, intensity);
  // P7-E：剧本【场景/人物/背景】段落跳过自问自答注入 + 错别字注入（由调用者外层也过滤 injectHumanTypos）
  // 按行扫描判定：前置注入可能把多行折叠成单段并污染段首，^ 锚定的整段匹配会失配击穿保护
  // v0.9 专家修复 P5：academic 文风禁用自问自答（「不信？」「例子呢？」是纯口语装置，
  // academic 承诺仅消结构规律与套话，不得引入口语注入）
  // v0.9.1：narrative/humanHand 体裁级跳过全部自问自答（"例子呢？"不属于叙事/人写原稿）
  const sceneBlockPara = (opts.skipSceneInject ?? false) && paraHasSceneBlock(paragraph);
  if (!sceneBlockPara && style !== "academic" && !(opts.skipSelfQA ?? false)) {
    working = injectSelfQA(working, rng, intensity, style);
  }
  if (splitAfter !== undefined && splitAfter > 0 && splitAfter < working.length - 1) {
    const a = working.slice(0, splitAfter + 1).join("");
    const b = working.slice(splitAfter + 1).join("");
    return a + "\n\n" + b;
  }
  return working.join("");
}

/* =========================================================
   v2 P3 论说结构指纹拆毁 & 真人预检（2026-08-26）
   针对：O2(论说0.7) 本地 aiScore=0 但官方=45% → 词级/句长级已"满分像人"，
   但朱雀仍看到「论述三部曲、硬编号列举、段首雷同、冰冷无个人锚点」这些
   本地 breakdown 没有建模的语义结构。
   ========================================================= */

/** P3-1 论述三部曲拆毁：不仅删"首先/其次/最后"字面词，更打乱顺序、
 *  随机挑 1 条改成"第一人称经验插叙"、1 条改成"反事实假设/半否定"、
 *  1 条保留——语义布局从 AI 严格 1→2→3 变为真人跳跃式推演。 */
export function dismantleExpositionTrilogy(
  sentences: string[],
  rng: () => number,
  intensity: number,
): string[] {
  if (intensity < 0.7 || sentences.length < 3) return sentences;
  const TRIGGER =
    /^(?:首先|其次|再次|最后|末了|第一[点条个方面]?|第二[点条个方面]?|第三[点条个方面]?|一方面|另一方面|据此|综上|综上所述|基于此|由此可见|紧接着|接下来|随后|再者|而且|同时|与此同时|进一步)(?:[，、是说]\s*)?/;
  const triggerIdxs: number[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (TRIGGER.test(sentences[i].trim()) && triggerIdxs.length < 5) triggerIdxs.push(i);
  }
  if (triggerIdxs.length < 3) return sentences;

  const out = sentences.slice();
  const picks = triggerIdxs.slice(0, 3);
  const [a, b, c] = picks;
  // v0.9 专家修复 P1（句序）：删除「打乱 3 句顺序」步骤。实测乱序把
  // 论述链（背景→转折→引入）颠倒成不可读文本；套话清除 + 头部改写本身
  // 已足够破坏"首先/其次/最后"的严格三部曲指纹，顺序保持原文。
  const trio = [out[a], out[b], out[c]];
  // (2) 第 1 条：改第一人称经验插叙
  const firstPersonHeads = [
    "其实我自己之前就碰到过类似的情况——",
    "我之前在项目里做过类似的测算，结论是——",
    "我去年还在老东家做过这个行业的调研，大致是——",
    "哦对，我自己读下来觉得——",
    "我身边也有人做过差不多的事情，他们的感受是：",
    "我之前查过一份内部的报告，里面其实也提到——",
  ];
  trio[0] = pick(rng, firstPersonHeads) + trio[0].replace(TRIGGER, "");
  // (3) 第 2 条：改反事实假设 / 半否定开头
  const hedgeHeads = [
    "不过话说回来，其实不一定非要",
    "说真的，不见得必须",
    "老实讲，也未必需要",
    "反过来想，其实没必要",
    "如果换个角度呢？不一定非得",
  ];
  trio[1] = pick(rng, hedgeHeads) + trio[1].replace(TRIGGER, "");
  // (4) 第 3 条：保留内容，加一个"人读累了的过渡短语"在句尾
  const tailPhrases = [
    "，至少我是这么看的。",
    "——起码目前是这样。",
    "，谁知道以后呢。",
    "，大概就是这么个理儿。",
    "，我说的也不一定对哈。",
  ];
  let s3 = trio[2].replace(TRIGGER, "");
  if (/[。！？!?]$/.test(s3) && rng() < 0.8) {
    s3 = s3.slice(0, -1) + pick(rng, tailPhrases);
  }
  out[a] = trio[0];
  out[b] = trio[1];
  out[c] = s3;
  // v0.9 专家修复 P1：删除 0.9+ 档「与句组外自由句互换位置」——
  // 跨句组换位实测造成段内因果链断裂，收益（指纹扰动）远小于代价。
  return out;
}

/** P3-2 硬编号列举 2.0：检测 "1. xxx / (2) xxx / 第三：xxx / ① xxx" 等编号列举，
 *  第 1 条 → 插叙括号化（挪到相邻句尾括号里），第 2 条 → 改反问句，
 *  第 3 条 → 挪到段尾加"补充说明"头，彻底毁掉"条目罗列"的语义视觉布局。 */
export function hardNumberedEnumerationShuffle(
  sentences: string[],
  rng: () => number,
  intensity: number,
): string[] {
  if (intensity < 0.7 || sentences.length < 2) return sentences;
  // v0.9.16 修复（编号格式偏差）：旧正则 `\d+` 分支不带标点后缀，「1.」replace 残留
  // 「. xxx」、「第三：」的「第」不在前缀白名单、「① 」圈号后要求标点——三处都不吃干净。
  // 现统一为四分支：阿拉伯数字+标点 / 圈号（允许空格）/ 「第」+中文数字+标点 / 中文数字+标点。
  const NUM =
    /^[\s(（]*\s*(?:\d+[.、:：)）]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*|第?[一二三四五六七八九十]+[.、:：)）]\s*)/;
  const hits: number[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (NUM.test(sentences[i].trim())) hits.push(i);
  }
  if (hits.length < 2) return sentences;

  const out = sentences.slice();
  const chosen = hits.slice(0, Math.min(3, hits.length));
  // A. 第一条 → 插叙括号化
  const idx0 = chosen[0];
  let body0 = out[idx0].replace(NUM, "").trim();
  const punct = /[。！？!?]$/.test(body0) ? body0.slice(-1) : "。";
  body0 = body0.replace(/[。！？!?]$/, "");
  if (rng() < 0.7) {
    const parenth = "（顺便提一句——" + body0 + "）" + punct;
    const neighbor =
      idx0 - 1 >= 0 && !hits.includes(idx0 - 1)
        ? idx0 - 1
        : idx0 + 1 < out.length
          ? idx0 + 1
          : idx0;
    out[neighbor] = out[neighbor].replace(/\s*$/, "") + parenth;
    out[idx0] = "";
  }
  // B. 第二条 → 改反问句
  if (chosen[1] !== undefined) {
    const idx1 = chosen[1];
    let s = out[idx1].replace(NUM, "").trim();
    s = s.replace(/[。！？!?]$/, "");
    if (rng() < 0.8) {
      const suffix = pick(rng, [
        "，这难道还不够明显吗？",
        "，这不就是最直接的证据吗？",
        "——你们自己想，是不是这个道理？",
        "，真的能一笔带过吗？",
        "，这事儿恐怕没那么简单吧？",
      ]);
      out[idx1] = s + suffix;
    }
  }
  // C. 第三条 → 挪到段尾加"补充说明"头
  if (chosen[2] !== undefined) {
    const idx2 = chosen[2];
    const s2 = out[idx2].replace(NUM, "").trim();
    out[idx2] = "";
    const head = pick(rng, [
      "最后补充一句，",
      "哦对，差点忘了——",
      "还有个小尾巴：",
      "再多嘴一句哈，",
    ]);
    out.push(head + s2);
  }
  return out.filter((s) => s.length > 0);
}

/** P3-3 段首句长强制方差：段首雷同（相邻段首句长差 ≤ 2 字）时，
 *  50% 概率在段首加 4-8 字独立口语过渡短句，50% 概率把段首句中间切一刀，
 *  强制段首 CV 提升 0.1→0.4+  。 */
export function enforceParagraphLeadSentVariance(
  text: string,
  rng: () => number,
  intensity: number,
): string {
  if (intensity < 0.7) return text;
  const paras = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
  if (paras.length < 2) return text;
  const leadLens = paras.map((p) => {
    const first = splitSentences(p)[0] || "";
    return first.replace(/\s/g, "").length;
  });
  const corrected = paras.slice();
  for (let i = 1; i < corrected.length; i++) {
    const diff = Math.abs(leadLens[i] - leadLens[i - 1]);
    if (diff <= 2) {
      const sents = splitSentences(corrected[i]);
      if (!sents.length) continue;
      const mode = rng() < 0.5 ? "prependShort" : "chopLead";
      if (mode === "prependShort") {
        const head = pick(rng, [
          "先说清楚哈——",
          "别急，听我说。",
          "开门见山，",
          "哦对了，",
          "说句题外话，",
          "这点得承认，",
          "咱们实话说，",
        ]);
        corrected[i] = head + "\n" + corrected[i];
        leadLens[i] = head.length + leadLens[i];
      } else {
        const s0 = sents[0];
        if (s0.length > 12) {
          const cutPos = 6 + Math.floor(rng() * Math.max(1, s0.length - 14));
          const a = s0.slice(0, cutPos);
          const b = s0.slice(cutPos);
          sents[0] = a + "，" + b;
          corrected[i] = sents.join("");
        }
      }
    }
  }
  return corrected.join("\n\n");
}

/* 2026-08-26 v3 P4：N2/D2 低 burstiness + 破折号超标 + VOCAB 保护衍生套话 指纹补药
   v3 P5（抠最后 1~2 分）：A. avgLen 硬约束到 ≤25（独立于 burstiness）B. 放宽极短锚切段阈值（14→10 字）+ 加 1 字更极端锚
   放在 humanize() return 前做"清尾保险"：
   - P4-C replaceGuardedFormulaicDerivs：VOCAB 带 GUARD 后缀保护的合法套话衍生形（如"针对→性"=针对性）保语义整体替换
   - P4-A ensureEmDashCountHardCap：整篇「——」> cap 时，从后往前把多余非自问自答的换成「，」
   - P5-A clampAvgSentenceLenUnder25：若 avgLen>25 → 在最长句中央「，」处切段为两句，降 avgLen（O2/O3 各清 1 分）
   - P4-B boostBurstinessIfLow(v2)：burstiness<0.6 时，在长句尾插入 1~3 字极短独立句锚造双峰 CV（D2 清 2 分） */
export function replaceGuardedFormulaicDerivs(text: string): string {
  // 只替换组合词，不碰原本"针对/系统/有效"单字（避免破坏 guard 语义）
  return text
    .replace(/针对性的(?=[\u4e00-\u9fa5，。！？；：、])/g, "专门的")
    .replace(/针对性地(?=[\u4e00-\u9fa5])/g, "专门地")
    .replace(/针对性(?!词汇|治疗|培训|训练|广告)/g, "专门方向")
    .replace(/系统性的(?=[\u4e00-\u9fa5，。！？；：、])/g, "全盘的")
    .replace(/系统性地(?=[\u4e00-\u9fa5])/g, "从头到脚地")
    .replace(/系统性(?!改革|工程)/g, "完整体系")
    .replace(/有效性/g, "实际效果")
    .replace(/持续性的/g, "长期的")
    .replace(/持续性地/g, "长时间地")
    .replace(/(从根本)上(?=[说讲看解决改变]|，|。)/g, "$1来说");
}

/* P5-A：avgLen（纯句长，去标点）> 25 → 反复切最长句的中央逗号，直到 avgLen ≤ 25 或切无可切。
   注意：切段仅在「，/；/、/：」存在时做，避免斩断语义重的完整分句；最多 maxCuts 次防止过切。
   此函数不关心 burstiness，只为了清掉 aiScore 第三分量 clamp((avgLen-25)/40, 0, 1)*20 的 1 分惩罚（O2=1.33, O3=0.6 → 清为 0）。*/
export function clampAvgSentenceLenUnder25(text: string, targetAvg = 25, maxCuts = 6): string {
  // P7-F 段落感知：splitSentences 的 trim 会剥掉句尾 \n\n，
  // 全文级 splitSentences→join 会悄悄合并段落（与 boostBurstiness 相同的分段模式）
  if (!text.includes("\n\n")) return clampAvgSentencesInBlock(text, targetAvg, maxCuts);
  return text
    .split(/\n\n+/)
    .map((p) => clampAvgSentencesInBlock(p, targetAvg, maxCuts))
    .join("\n\n");
}

function clampAvgSentencesInBlock(text: string, targetAvg: number, maxCuts: number): string {
  if (maxCuts <= 0) return text;
  let working = text;
  for (let c = 0; c < maxCuts; c++) {
    const stats = sentenceStats(working);
    if (stats.avg <= targetAvg) break;
    const sents = splitSentences(working);
    // 找：最长的、内部有逗号/分号（可切段点）的句子
    const rank = sents
      .map((s, i) => {
        const pure = s.replace(/[\s。！？!?…—\-，、；：""''「」（）《》【】]/g, "");
        return { i, s, L: pure.length, hasCut: /[，；、：]/.test(s) };
      })
      .filter((x) => x.hasCut && x.L > targetAvg + 2)
      .sort((a, b) => b.L - a.L);
    if (rank.length === 0) break;
    // v0.9 专家修复 P2/P3：逐候选找切点（原版只试最长一句，守卫否决后整轮放弃，
    // avgLen 压不下去——O3 实测 avgLen 32 卡死）。最多看 4 条长句。
    let t: { i: number; s: string } | null = null;
    let cutIdx = -1;
    for (let k = 0; k < Math.min(4, rank.length); k++) {
      const cand = rank[k];
      const m = findGuardedCutNear(cand.s, Math.floor(cand.s.length / 2));
      if (m !== -1) {
        // v0.9.1 使役无主句守卫：切出的后半句若以"让/使/帮/叫"开头（承接前句宾语），
        // 不能独立成句——跳过该候选，换下一句切（scan-bugs v5.2「使役无主句」106 次违规）
        const rest = cand.s.slice(m + 1).trim();
        if (!fragmentCanStand(rest)) continue;
        t = cand;
        cutIdx = m;
        break;
      }
    }
    if (!t || cutIdx < 0) break;
    const front = t.s.slice(0, cutIdx); // 例如"根据报告显示，今年增长明显"
    const rest = t.s.slice(cutIdx + 1); // "今年增长明显。"
    // 把逗号换成句号；后半首字母大写对中文无所谓
    const newSents = [front + "。", rest];
    // 回写：sents 数组位置 t.i 替换为 2 条
    sents.splice(t.i, 1, ...newSents);
    working = sents.join("");
  }
  return working;
}
export function ensureEmDashCountHardCap(text: string, cap = 1): string {
  if (cap < 0) return text;
  // 先统计：匹配 em-dash 2字节标准写法 ——
  const EM = "——";
  let count = 0;
  for (let i = 0; i < text.length - 1; i++) if (text[i] === "—" && text[i + 1] === "—") count++;
  if (count <= cap) return text;
  let need = count - cap;
  let out = text;
  // 从尾部往前替换：优先保住开头「你可能会问——/有人要抬杠了——」这种自问自答（一般在段首靠前）
  // 保留第 1 个最早出现的，其余从后往前按能替换的换成合适的标点
  while (need > 0) {
    const last = out.lastIndexOf(EM);
    if (last === -1) break;
    const before = last > 0 ? out[last - 1] : "";
    // 如果前一字是「问/说/答/想/杠/啦/呢/吗/哦/哎」→ 自问自答型，不替换，跳过这一处
    const skipChars = "问说答想杠啦呢吗哦哎？！，";
    if (skipChars.includes(before)) {
      // 往前找下一个（跳过此位置）
      // 临时替换为 placeholder 避免反复命中
      out = out.slice(0, last) + "\x00\x00" + out.slice(last + 2);
      continue;
    }
    // 替换策略：前面如果有数字或「的/了/是/在/有」→ 用"，"，否则"，"通吃
    out = out.slice(0, last) + "，" + out.slice(last + 2);
    need--;
  }
  // 还原 placeholder（自问自答那几处保留下来的）
  out = out.split("\x00\x00").join(EM);
  return out;
}

/**
 * v0.8.8 语气词极短句密度上限：管线里多个注入器（boostBurstiness / IfLow 尾挂 /
 * 自问自答等）叠加后，同段可累积出「呣。哦。咳。」三连独立极短句——单个都在
 * 守卫限额内，叠起来仍是"过度人味"的机器指纹（v0.8.6 质检提示词已把它列为
 * FAIL 项，引擎侧也要自守同一条纪律）。确定性收口：每段独立极短语气句 ≤ 2 条，
 * 超出的直接删（它们是独立句，删除不伤语法、不伤语义）。零随机、幂等。
 */
const PARTICLE_SENT_RE = /^(?:对哦|是啊|好吧|[嗯嗨诶咳呵啧呣哦啊行]){1,4}$/;
/** 句尾挂语气词（"好评哦。""韧性好吧。"）：锚点注入器惯用手法——插在句末标点前 */
const PARTICLE_SUFFIX_RE = /(?:对哦|是啊|好吧|[嗯嗨诶咳呵啧呣哦啊行])$/;

export function capParticleSentenceDensity(text: string, maxPerPara = 1, stripSuffix = true): string {
  // v0.9 专家修复 P3：每段独立极短语气句上限 2 → 1。实测 0.9 档输出段尾
  // 「呵。啧。」「行。好吧。呵。」成串——每段 2 条在 3 段短文里就是 6 条，
  // 堆积密度远超真人（真人每段至多 1 条口头语，且不是每段都有）。
  // stripSuffix=false：只收独立语气句、保留句尾挂词（最终收口用，防止把
  // burstiness 兜底刚拉起的句长方差又拍平）。
  return text
    .split(/\n\n+/)
    .map((para) => {
      const sents = splitSentences(para);
      // v0.9 长尾：整段只剩短碎句（重切/桥接把正文抽走后留下「道理是这个道理。行。」
      // 式空段）→ 整段丢弃（全段句子均 ≤8 字即视为无正文残留）
      // v0.9.10 修正：原判据「全段句子均 ≤8 字」会把普通短句段整段清空——
      // 8 字是常见中文句长（「这个功能确实好用。」正好 8 字），不是碎句，
      // 实测该函数直接把这类段落返回成空串，与主流程注释「不动正常短句」相悖。
      // 空壳段的真特征是「语气词残留 + 全段极短」，故收紧为：≥2 句、均 ≤5 字、
      // 且至少含 1 条独立语气句（确有注入器残留痕迹）。
      const bareAll = sents.filter((s) => s.trim());
      const bareOf = (s: string) => s.replace(/[\s。！？!?…，、；：]/g, "");
      if (
        bareAll.length >= 2 &&
        bareAll.every((s) => bareOf(s).length <= 5) &&
        bareAll.some((s) => PARTICLE_SENT_RE.test(bareOf(s)))
      ) {
        return "";
      }
      const out: string[] = [];
      let kept = 0;
      for (const s of sents) {
        const bare = s.replace(/[\s。！？!?…，、；：]/g, "");
        const isStandalone = bare.length > 0 && bare.length <= 4 && PARTICLE_SENT_RE.test(bare);
        // 句尾挂词：只认长句（core>6 字），短句本身就是独立语气句走 isStandalone 分支
        const trimmed = s.trimEnd();
        const core = trimmed.replace(/[。！？!?…]+$/, "");
        const hasSuffix = core.length > 6 && PARTICLE_SUFFIX_RE.test(core);
        if (kept >= maxPerPara) {
          if (isStandalone) continue; // 超额独立语气句：整句丢弃
          if (hasSuffix && stripSuffix) {
            // 超额句尾挂词：剥语气词本体、保句子（"好评哦。"→"好评。"）
            const stripped = core.replace(PARTICLE_SUFFIX_RE, "").replace(/[，、；：,]$/, "。");
            out.push(stripped + trimmed.slice(core.length));
            continue;
          }
          out.push(s);
          continue;
        }
        if (isStandalone || hasSuffix) kept++;
        out.push(s);
      }
      return out.join("");
    })
    .join("\n\n");
}

/** P3-4 第一人称判断锚点：全文本按字数扫，每 300 字 ≥ 1 处。
 *  优先插在「报告显示/数据表明/高达…」之后，给"冰冷学术腔"注入主观视角。
 *
 *  ⚠️ v0.9.5 起只注入「主观判断」，不再注入「具体经历」。
 *  原实现（"我去年在老东家…""我之前查过一份内部纪要…""这块我自己上手试过…"）会
 *  静默替用户捏造可被证伪的事实主张——读者与审稿人会认为作者真的做过这些事。
 *  这与 README 的「严禁编造铁律」（LLM 通道：不得引入原文没有的人物、经历、案例、数据）
 *  直接冲突，且用户无从察觉，属法律风险而非风格问题。 */
export function injectFirstPersonAnchorPoints(
  text: string,
  rng: () => number,
  intensity: number,
): string {
  if (intensity < 0.85) return text;
  const chars = text.replace(/\s/g, "").length;
  const targetCount = Math.max(1, Math.floor(chars / 300));
  if (chars < 200) return text;

  const DATA_MARK =
    /(报告显示|数据显示|白皮书显示|调研显示|研究表明|数据表明|占比|同比|达到了|高达|根据[《\w].*?显示)/;
  // 只表达主观看法，不声称任何具体经历/资历/资料来源（无法被证伪为假）
  const ANCHORS = [
    "我个人觉得这块的门槛比看上去高。",
    "要我说，纸面数字和实际落地之间通常还隔着一段。",
    "这点我持保留意见，具体到每个团队差别可能很大。",
    "我的看法是，这类结论得配合场景看，单看数字容易误判。",
    "我觉得口径一变，结论可能完全反过来。",
    "在我看来，这部分最容易被想当然。",
  ];

  const allSents = splitSentences(text);
  const goodSlots: number[] = [];
  for (let i = 0; i < allSents.length - 1; i++) {
    if (DATA_MARK.test(allSents[i])) goodSlots.push(i + 1);
  }
  if (goodSlots.length < targetCount) {
    const step = Math.max(2, Math.floor(allSents.length / (targetCount + 1)));
    for (let k = step; k < allSents.length - 1 && goodSlots.length < targetCount; k += step) {
      if (!goodSlots.includes(k)) goodSlots.push(k);
    }
  }
  if (goodSlots.length === 0) return text;
  for (let i = goodSlots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [goodSlots[i], goodSlots[j]] = [goodSlots[j], goodSlots[i]];
  }
  const useSlots = goodSlots.slice(0, targetCount).sort((a, b) => a - b);

  const out: string[] = [];
  for (let i = 0; i < allSents.length; i++) {
    out.push(allSents[i]);
    if (useSlots.includes(i)) out.push(pick(rng, ANCHORS));
  }
  return out.join("");
}
