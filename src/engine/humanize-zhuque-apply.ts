/**
 * 趣AI味 · 朱雀增强应用层：applyZhuqueFeatures（反检测特征注入）+
 * humanizeSingle（本地引擎单遍主体）+ injectDialect 家族（已停用，留档）。
 *
 * v0.9.53 拆分阶段 1b 第 3 步（docs/humanize-split-plan.md 边界修正，选项 A）：
 * 原为 humanize.ts 内联区块。实测替换层只被本文件两个函数调用，
 * 且 trace 三件套已于第 1 步下沉 primitives ⇒ 可整体迁出，无环。
 *
 * 依赖方向（无环）：本模块 → humanize-data / humanize-rules / humanize-replace /
 * humanize-primitives / humanize-shuffle / anti-fingerprint / classify-genre / detector
 */

import {
  DIALECT_ENTRIES,
  HumanizeOptions,
  INTERJECTIONS,
  OPINION_PHRASES,
  PARENTHETICALS,
  PARENTHETIC_NOTES,
  RewriteStyle,
  SENTENCE_FRAGMENTS,
  SOFT_ENDINGS,
  findSplitPoint,
  fragmentCanStand,
  isCJK,
  isSceneBlockLine,
  isScriptFormatLine,
  makeRng,
  pick,
  splitSentences,
  startsWithConnector,
} from "./humanize-data.ts";

import {
  INTERJECTION_RATE,
  MERGE_SENTENCE_PREV_MAX,
  MERGE_SENTENCE_RATE,
  MERGE_SENTENCE_THRESHOLD,
  SOFT_ENDING_PROB,
  SOFT_TAIL_PROB,
  SPLIT_SENTENCE_RATE,
  SPLIT_SENTENCE_THRESHOLD,
} from "./humanize-rules.ts";

import {
  SCENE_BLOCK_LINE_RE,
  countVocabTokens,
  dropLeadingConnectives,
  relaxIntensifierVerb,
  relaxLe,
  relaxRedundantVerb,
  replaceOpener,
  replaceTemplates,
  replaceVocab,
  replaceWithDevelopment,
  softenPassive,
} from "./humanize-replace.ts";

import {
  PAD_INJECT_CAP,
  REPORTING_DAO_RE,
  countPadHeads,
  emitStage,
  nowMs,
} from "./humanize-primitives.ts";

import {
  boostBurstinessSingle,
  dedupePadWords,
  injectHalfWidth,
  injectSelfQA,
  limitPunctuation,
  reframeConcessives,
  relaxColon,
  relaxDunhao,
  relaxEmDash,
  relaxQuotes,
  splitOnConnectors,
  stripAICliches,
  stripCJKEdgeSpaces,
  stripLeadingConnectivesHard,
} from "./humanize-shuffle.ts";

import { isSceneMetaSentence, isSpecTableParagraph } from "./anti-fingerprint.ts";
import { suppressSelfQA } from "./classify-genre.ts";
import { keepOnlyIfDetectDrops } from "./detector.ts";

/* ---------------- v0.9.8 强度斜坡（RAMP）---------------- */
/**
 * 强度斜坡：把 [RAMP_START, RAMP_END] 区间的有效注入强度从 0 线性升到 intensity。
 *
 * 起因（scripts/archive/_stability.ts 全档位扫描）：
 *   0.35 档近乎干净（叙事均值 2.4），0.40 档突然爆分（叙事均值 23.4，最差 55）——
 *   用户把强度上调 0.05，输出质量断崖式下降，体验上像"开关"而不是"旋钮"。
 *
 * 真凶（scripts/_punct_probe.ts 标点剖面）：
 *   不是"注入器撒得太多"，而是**两条句子级开关的阈值错位**：
 *     · "过短句与前句合并" 概率跟着 intensity 线性爬，0.35→0.40 已能命中；
 *     · 唯一能对冲的切句力量 boostBurstinessSingle 挂在 `intensity > 0.4` 严格比较上。
 *   0.40 档因此处于"合并开着、切句没开"的状态，句长单向膨胀
 *   （原文 句号5/逗号6 → 0.40 档 句号2/逗号9，avgLen 20.4 → 52.5）。
 *
 * 修法：
 *   ① 把上述两条句子级开关的概率从 intensity 换成 eff（本函数返回值）；
 *   ② 注入器（injectParentheticals / injectOpinion / injectParentheticNotes /
 *      injectFragments）的概率同样换成 eff。
 *   0.60 以上 ramp=1，行为与原实现完全一致，高档位的完整注入能力不受影响。
 *
 * 区间取 [0.35, 0.60] 的理由：
 *   0.35 是原硬门槛（起点应接近零）；0.60 是既有 `>= 0.55` 结构层
 *   与 `>= 0.65` 模板封顶的激活带起点，把斜坡终点放在这里，
 *   让这些既有阈值继续在"已完全放开"的区间里工作，不改变它们的行为。
 */
const RAMP_START = 0.35;
const RAMP_END = 0.6;

function rampFactor(intensity: number): number {
  return Math.max(0, Math.min(1, (intensity - RAMP_START) / (RAMP_END - RAMP_START)));
}

/** 有效注入强度：低档位被斜坡压到 ≈0，0.60 档起等于 intensity 本身。 */
function effectiveIntensity(intensity: number): number {
  return intensity * rampFactor(intensity);
}

/** 朱雀增强：仅叠加反检测特征，不跑本地引擎 */
export function applyZhuqueFeatures(
  text: string,
  intensity: number,
  seed?: number,
  style: RewriteStyle = "casual",
  // P7-E：对话体剧本场景块跳过自问自答注入
  // v0.9.1：narrative/humanHand 跳过全部自问自答+碎片注入
  opts: { skipSceneInject?: boolean; skipSelfQA?: boolean } = {},
): string {
  if (!text || intensity < 0.35) return text;
  const zrng = makeRng(seed, 7777);
  let result = text;

  // v0.9.8 P0 收敛（六）：0.35 硬门槛 → 强度斜坡。
  //
  // 缺陷（scripts/archive/_stability.ts 全档位扫描）：
  //   0.35 档近乎干净（叙事均值 2.4），0.40 档突然爆分（叙事均值 23.4，最差 seed 46）——
  //   跨过 0.35 后多个注入器同时以完整概率启动，中间没有过渡。
  //
  // 详见文件上方 rampFactor / effectiveIntensity 的注释（含 _punct_probe.ts 定位的真凶）。
  const eff = effectiveIntensity(intensity); // 有效注入强度：0.35 档 ≈ 0，0.60 档起 = intensity

  const isCasual = style === "casual";
  const skipSelfQA = opts.skipSelfQA ?? false;
  // v0.9.8 P0 收敛（三）：删除 injectDialect 注入。
  //
  // 证据一（净负收益，左右手互搏）：
  //   injectDialect 撒下「唠/瞅/贼/整/寻思」后，anti-fingerprint.ts 172~190 行
  //   又把它们还原成书面词（唠→谈、瞅→看、贼→非常）。实测 0.9 档：
  //     注入 10 处 → 还原 8 处 → 净留 2 处
  //   且漏网的恰好是还原表**未覆盖**的 寻思/寻/整 —— 也就是说：
  //   白付一遍注入成本，最后只留下「两侧词表都对不齐的残渣」。
  //
  // 证据二（残渣是双重扣分项）：
  //   这些残渣既命中 BROKEN_SUBSTITUTES（病词，12 分/处），
  //   又命中 3e 垫词表（句式污染）。一个装置喂两个扣分项。
  //
  // 证据三（归因实测）：injectDialect 概率最高（0.20×intensity），
  //   且 4/4 体裁全部命中（叙事/论说/观点 × casual/plain），是第一位注入污染源。
  //
  // 结论：净负收益设计，**删除优于调低概率**——只要还注入，就会留残渣。
  //
  // 原调用（保留注释备查）：
  //   if (isCasual) result = injectDialect(result, zrng, 0.2 * intensity);

  // v0.9.8 P0 收敛（四）：injectParentheticals / injectOpinion 收紧为 casual 专属。
  //
  // 收敛前条件是 `style !== "academic"` → plain 风格也在跑。
  // 实测（scripts/_layer_attrib2.ts）：plain 已关闭方言/碎片/括号自语/自问自答，
  // 污染率却仍有 0.60、句式分 60 —— 残存污染词「我寻思着/说真的/坦白讲」
  // 全部来自这两个注入器。plain 的定位就是「少口语」，塞插话/观点短语是定位冲突。
  //
  // v0.9.8 P0 收敛（六）：概率改用 eff（斜坡有效强度）而非 intensity。
  //   理由见上方 RAMP 段：0.35 档位以前是"完整概率注入"，与 0.40 档无区别，
  //   造成"旋钮"变"开关"。改用 eff 后 0.35 档 ≈ 零注入，0.60 档起恢复原行为。
  //
  // v0.9.8 P0 收敛（六·续）：叙事/人写体裁**整体**禁用插话/观点注入（含句内分支）。
  //
  // 补丁起因（scripts/archive/_n60.ts / _narr_ab.ts，叙事 seed=2 恒定 31 分）：
  //   句首垫词的三重门控只挡了句首入口，injectParentheticals 的**句内**分支漏网——
  //   seed=1 插出「坦白讲，…，在我看来，」、seed=2 恒定在开头插出「我个人的看法，」
  //   句尾插出「往好听了说，」，句式分 28，且**不随强度变化**（确定性路径，非概率抖动）。
  //   实测 avg 只有 2.6~4.1，但 max 卡在 31 —— 一个坏 seed 就毁掉整档体验。
  //   叙事体裁的定位是「把事讲清楚」，句内塞口语插话与句首塞「说真的，」同类错位，
  //   门控必须覆盖整条注入路径，不能只挡句首那一个入口。
  //
  // ⚠️ 注意：**不要**用 skipSelfQA 关掉注入器本体 + injectOpinion 的**组合**。
  //   实测叙事体裁同时关掉这两个注入器后，aiScore 反而从 12 涨到 32 ——
  //   文本变短触发了 boost 切句路径，按下葫芦浮起瓢。叙事的问题不在插话注入器。
  //
  // 风险与验证：历史上曾有"关掉注入器 → 文本变短 → boost 切句反扑"的陷阱。
  //   本次改动前先记录了基线 avg/max，改动后必须复跑脚本确认 avg 未上升、
  //   max 显著下降。**若 avg 上升则回滚本门控**（data > 直觉）。
  // 四个注入器合并到同一门控（原本写成两个条件完全相同的 if，无实际区分）
  if (isCasual && !skipSelfQA) {
    result = injectParentheticals(result, zrng, 0.15 * eff);
    result = injectOpinion(result, zrng, 0.12 * eff);
    result = injectParentheticNotes(result, zrng, 0.08 * eff);
    // 注：injectFragments 无 style 参数（签名仅 text/rng/p），其碎片词池是
    // 体裁无关的固定池，风格差异由外层 isCasual 门控负责。这里不存在漏传问题。
    result = injectFragments(result, zrng, 0.06 * eff);
  }
  result = dedupePadWords(result);
  result = limitPunctuation(result, "——", 1, "，");
  // v0.8：自问自答（增强句式跳脱，AI 极少写自问自答，人类日常到处是）
  // P7-E：对话体剧本【场景/人物/背景】块跳过注入，避免台词区被塞"问：…答：…"违和
  // v0.9.1：narrative/humanHand 跳过全部自问自答（"例子呢？"不属于叙事/人写原稿）
  // v0.9.8 P0 收敛（七）：外层条件 isCasual → style !== "academic"。
  //
  // 原文注释写着「plain 走克制型池」，但外层判的是 `isCasual`，
  // plain 根本进不来 —— 注释与代码脱节。injectSelfQA 的 POOLS 里
  // plain 那 6 条克制模板（「为什么呢？原因其实不复杂。」…）从未被使用。
  //
  // 修正后：
  //   casual → 表演型池（10 条，含「不信？那你自己试试」这类）
  //   plain  → 克制型池（6 条，无表演性碎句）
  //   academic → POOLS.academic = []，函数内直接 return，天然禁用
  //
  // 注意：casual 池里的「不信？「有人要抬杠了——」是标尺 3e 的命中词，
  //   但 casual 已不再是默认档，保留其历史行为不作二次改动。
  if (style !== "academic" && intensity >= 0.7 && !skipSelfQA) {
    const qrng = makeRng(seed, 8888);
    // P7-E：体裁级开关（对话体）→ 全文跳过；未开开关时逐段保护——
    // 含剧本【场景/人物/背景】行的段落原样保留，其余段落照常注入
    const skipFlag = opts.skipSceneInject ?? false;
    // v0.9 专家修复 P5：academic 文风禁自问自答（已由外层条件拦截）。
    // plain 走克制型池，casual 走表演型池 —— 词池由 injectSelfQA 按 style 自选。
    //
    // 2026-10-01 修：这里此前逐段各调一次 injectSelfQA，**段与段之间没有记忆**，
    // plain 池只有 6 条 → 两段撞同一条是 1/6 概率的必然偶发（实测 1/5 种子复现
    // 「是不是只有这一种解释？未必，但这一种最直接。」连出两遍）。
    // 现在整个 split 共享一个 usedQA 集合，逐段去重。
    const usedQA = new Set<string>();
    const beforeQA = result;
    result = result
      .split(/\n\n+/)
      .map((p) => {
        if (skipFlag || p.split(/\n/).some((ln) => SCENE_BLOCK_LINE_RE.test(ln))) return p;
        const sents = splitSentences(p);
        if (sents.length < 5) return p;
        return injectSelfQA(sents, qrng, intensity, style, usedQA).join("");
      })
      .join("\n\n");
    // v0.9.28 P0：效果回滚——加噪必须换来 detectAI 下降，否则把这一轮整个撤掉。
    // 详见 detector.ts 的 keepOnlyIfDetectDrops 注释（含实测与"判据是本地检测器"的边界）。
    result = keepOnlyIfDetectDrops(beforeQA, result);
  }
  return result;
}

export function humanizeSingle(text: string, opts: HumanizeOptions = {}): string {
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 0.6));
  // v0.9.8 P0 收敛（六·续）：句子级节奏开关（合并 / 句尾软化）走斜坡有效强度。
  // 注意**只**给节奏类开关用，词汇替换（relaxIntensifierVerb 等）继续吃 intensity——
  // 那些是核心去味功能，被斜坡压掉会让低档位彻底失效。
  // 详见文件上方 effectiveIntensity 的注释（含 _punct_probe.ts 的断崖定位）。
  const eff = effectiveIntensity(intensity);
  const rng = makeRng(opts.seed);
  const style = opts.style ?? "plain";
  const isAcademic = style === "academic";
  const isCasual = style === "casual";
  // v0.9.51：参数表/技术规格表段落判定（一次算好，劈句/合并/节奏兜底共用）。
  // C18 招标参数表实测：条目句被劈成五句、条款被搬位移、参数后挂「为什么呢？」
  // ——三条路分别在逐句劈句（下方）、结构层与节奏兜底，同判据一起堵。
  // 判据与注释见 anti-fingerprint.ts 的 isSpecTableParagraph。
  const specTablePara = isSpecTableParagraph(text);

  if (!text || !text.trim()) return "";

  // trace：段落级步骤发射器。
  // 把上一步的输出长度当成本步的输入长度串起来，逐段逐步骤产出真实快照。
  // ⚠️ 未传 onStage 时 `t0` 连算都不算（三元短路），只多一层函数调用，输出逐字不变。
  const on = opts.onStage;
  const para = opts.para;
  let prev = text;
  // fn 刻意做成**无参**thunk：调用处直接读外层 working，
  // 这样每一步的赋值都是"下一步真会读"的活值（而不是被 eslint 判成死存储的中间量）。
  const step = (
    id: string,
    name: string,
    why: string,
    fn: () => string,
    metric?: string,
  ): string => {
    const b = prev;
    const t0 = on ? nowMs() : 0;
    const after = fn();
    prev = after;
    if (!on) return after;
    emitStage(
      on,
      {
        id,
        name,
        why,
        charsBefore: b.length,
        ...(metric === undefined ? {} : { metric }),
        ...(para === undefined ? {} : { para }),
      },
      t0,
      after,
    );
    return after;
  };

  // P8 场景块全格式保真：整段为剧本【场景/人物/背景…】块头行 → 原样返回。
  // 块头是元数据不是行文：relaxColon 会改成【场景，…】、replaceVocab/templates 也会污染。
  if (isSceneBlockLine(text)) {
    if (on)
      emitStage(
        on,
        {
          id: "scene-block",
          name: "场景块全格式保真",
          why: "整段是剧本【场景/人物/背景】块头行。块头是元数据不是行文，任何替换都会破坏剧本格式，原样返回。",
          charsBefore: text.length,
          ...(para === undefined ? {} : { para }),
        },
        nowMs(),
        text,
      );
    return text;
  }

  // 1) 全局词汇替换 + 套话
  let working = step(
    "conn",
    "删句首连接词",
    "「然而 / 因此 / 与此同时」这类句首连接词是 AI 论说文最稳定的痕迹——真人起句多半直入正题，不垫过渡。",
    () => dropLeadingConnectives(text, rng, intensity),
  );
  working = step(
    "redundant",
    "去冗余动词",
    "「进行 / 予以 / 加以 + 动词」是公文式冗余，去掉后动词直接落地，句子立刻短一截。",
    () => relaxRedundantVerb(working, rng, 0.85 * intensity),
  );
  working = step(
    "intensifier",
    "拆强化副词",
    "「大幅提升 / 不断优化」这类「副词+动词」固定搭配过于规整，按概率拆掉副词，节奏才会参差不齐。",
    () => relaxIntensifierVerb(working, rng, 0.85 * intensity),
  );
  working = step(
    "le",
    "补完成态「了」",
    "AI 文本极少使用完成态。按概率补「了」，让叙述有时态落点。",
    // v0.9.50：正式语体下不补。
    () => relaxLe(working, rng, 0.6 * intensity), // 补"了"概率从 0.4 提到 0.6，人味更强
  );
  // 必须排在 replaceVocab 之前：否则"受到广泛关注"的"关注"先被换成"留意"，
  // 这里再也匹配不到，实测会留下"受到广泛留意"这种搭配病句。
  working = step(
    "passive",
    "被动改主动",
    "「受到广泛关注」这类被动句是书面腔的显著特征，改回主动。必须排在词汇替换之前——顺序颠倒会留下「受到广泛留意」这类搭配病句。",
    () => softenPassive(working, rng, Math.min(1, 0.85 * intensity)),
  );
  working = step(
    "template",
    "模板套话改写",
    "整句级模板替换：「值得注意的是…」「综上所述…」这类开场套式按表改写，比逐词替换更贴近真人起笔方式。",
    () => replaceTemplates(working, rng, intensity),
  );
  // v0.9.46：正式语体 = main / academic（与 guardFormalRegister 完全同口径）。
  // 传给 replaceVocab 后，口语替身就地否掉，不再走"先改成病句、再靠下游还原"的老路。
  const formalRegister = opts.genre === "main" || style === "academic";
  // 词汇替换要给出真实命中数：本步单独手写 emit（step 的 metric 是静态串，这里需要前后计数差）
  {
    const b = working;
    const t0 = on ? nowMs() : 0;
    const before = on ? countVocabTokens(b) : 0;
    working = replaceVocab(b, rng, intensity, style, formalRegister);
    prev = working;
    if (on) {
      const hits = Math.max(0, before - countVocabTokens(working));
      emitStage(
        on,
        {
          id: "vocab",
          name: "词汇替换",
          why: "词表级替换。正式语体（main / academic）下口语替身会被就地否掉——不从「先改成病句再靠下游还原」的老路走，而是源头就否掉。",
          charsBefore: b.length,
          metric: `词表词减少 ${hits} 处${formalRegister ? " · 正式语体门控已开" : ""}`,
          ...(para === undefined ? {} : { para }),
        },
        t0,
        working,
      );
    }
  }
  working = step(
    "dev",
    "「随着…的发展」改写",
    "「随着人工智能技术的发展」这类开场套式单独处理——它是整段级结构，逐词替换拆不动。",
    () => replaceWithDevelopment(working, rng, intensity),
  );
  working = step(
    "concessive",
    "让步结构重构",
    "「虽然…但是」的让步结构换写法，避免通篇一种句式。",
    () => reframeConcessives(working, rng, Math.min(1, 0.5 + 0.5 * intensity)),
  );
  working = step(
    "punct",
    "标点松弛",
    "破折号、顿号、冒号、引号按概率换成更口语的形态。AI 的标点过于规整本身就是可检测特征。",
    () => {
      let r = relaxEmDash(working, rng, 0.6 * intensity);
      r = relaxDunhao(r, rng, 0.5 * intensity);
      // v0.9.51：参数表段不松冒号——「三、软件平台：支持不少于……」的条目冒号
      // 被 relaxColon 换成逗号后，字段分隔符消失（C18 实测）。其余三项对
      // 参数表无害（顿号已有编号守卫，破折号/引号参数表基本不出现）。
      // ⚠️ 跳过会少消耗一次 rng——只影响参数表段的随机序列，其余篇目逐字不变
      //    （多种子验收基线不受影响，因为参数表语料是本轮新增的）。
      if (!specTablePara) r = relaxColon(r, rng, 0.4 * intensity);
      return relaxQuotes(r, rng, 0.3 * intensity);
    },
  );
  working = step(
    "splitconn",
    "连接词处切句",
    "长句里的连接词处按概率断开成两句，制造长短交错——这是句长方差的主要来源之一。",
    () => splitOnConnectors(working, rng, 0.3 * intensity),
  );

  // 2) 切句，逐句处理
  const tSent = on ? nowMs() : 0;
  const sentences = splitSentences(working);
  const out: string[] = [];
  const usedInterjections = new Set<string>();
  let lastWasInterjection = false;
  // v0.9.8 P0 收敛：humanHand / narrative 体裁禁句首垫词（语体错位）。
  // narrative 的文风是「把事讲清楚」，humanHand 的原稿本来就是人写的——
  // 两者塞「说真的，」都是机器味而非人味。显式 genre 与自动识别都覆盖。
  const padForbiddenGenre = opts.genre === "humanHand" || opts.genre === "narrative";

  for (let i = 0; i < sentences.length; i++) {
    let s = sentences[i];

    // v0.9-D 场景块行保护：剧本【场景/人物/背景…】块头行原样保留，
    // 跳过语气词/句尾软化/拆句/合并等全部注入（此前"啧。嗯。呣。"会污染块头）
    //
    // v0.9.8 P0 扩展：台词行（「张总（项目经理）：…」）同样原样保留。
    // 块头保护只认【…】行，台词行漏网时 injectOpinion / Interjections 会把垫词
    // 插到说话人**前面**（「讲真，张总（项目经理）：…」）——说话人标签前不得有修饰，
    // 这会直接破坏剧本格式。humanizeSingle 是逐段调用，段落内的行在此逐句处理，
    // 故用 isScriptFormatLine 同时覆盖块头与台词。
    if (isSceneMetaSentence(s) || isScriptFormatLine(s)) {
      out.push(s);
      continue;
    }

    // v0.9.51：正式稿件的句首结构标记不做口语化。「首先/其次/最后/第一/第二」
    // 在致辞、判项、条款、论文里是**结构标记**（C20 大会致辞实测
    // 「首先，我谨代表主办方……」→「先说一个，我谨代表……」，同篇
    // 「最后，预祝……」→「最后说一句，预祝……」——都是语体崩）。
    //
    // ⚠️ 这是 replaceVocab 之外的**平行路径**（OPENERS 表），
    //    FORMAL_FORBIDDEN_SUBSTITUTES 盖不到这里，必须单独门控——
    //    v0.9.51 首轮把六个替身加进黑名单后 C20 照旧泄漏，根因就在这。
    //
    // ⚠️ 门控判据是**文档签名**（suppressSelfQA：公文/学术/致辞/诉讼/参数表），
    //    不是体裁。首版写成 `if (!formalRegister)`（genre==="main" 一律冻），
    //    全量门禁当场抓出附带损害：无签名的普通论说样本（injection-overlap.test.ts
    //    固定 seed 20260905）detectAI 基线 26→40——「首先/其次/最后」被冻在稿里，
    //    而论说稿的去味收益恰恰包括换掉它们。而五个正式语料案例（C1 工作总结/
    //    C6 学术摘要/C17 判决书/C18 参数表/C20 致辞）全部命中签名，缺陷覆盖不减。
    //    ⇒ 「判形态，不判体裁」：签了名的正式稿件冻，观点文/营销文的口语替身
    //    仍是设计意图（casual 营销文「先说一个」有效）。
    //    另：academic 文风是用户显式声明的正式体，与签名并列冻结。
    const openerFrozen = (opts.officialDoc ?? suppressSelfQA(text)) || style === "academic";
    if (!openerFrozen) s = replaceOpener(s, rng, intensity);

    // v0.9.8 P0 收敛：句首垫词注入的三重门控。
    //
    // 收敛前：条件只有 `!isAcademic` → plain 风格、humanHand 体裁全都在跑。
    // 实测（scripts/_c_diag.ts）这是残存的唯一共因污染源——4/4 样本首句都被插
    // 「说真的，」「讲真，」「坦白讲，」「我寻思着，」；剥夺该项可回收
    // 论说 55→39、叙事 36→20 分。
    //
    // 三重门控（缺一不可）：
    //   a) 风格必须是 casual —— plain 的定位就是「少口语」，academic 早已排除；
    //   b) 体裁不得是 humanHand/narrative —— 人写原稿与叙事文塞「说真的」是语体错位
    //      （humanHand 的 intensityCap=0.48 也说明该体裁本就该轻改）；
    //   c) 全篇垫词未超预算 —— 各注入点独立掷骰会叠加，必须有全局约束。
    //      v0.9.4 P2 已引入 countPadHeads/PAD_INJECT_CAP 跨轮守卫，此处复用同一口径。
    // v0.9.21 性能：原实现是先无条件算 `countPadHeads(out.join(""))`，再拿结果去和
    // 三个更便宜的布尔做 `&&`——而 countPadHeads 要扫描「已累积全文」，逐句调用即
    // O(句数 × 全文长)。单段长文实测超线性（38400 字 / 800 句：99.8ms，倍率 ×1.58）。
    // 挪到 `&&` 链**末端**后：默认风格是 plain（isCasual=false），这三条先短路，
    // 昂贵调用根本不会执行。countPadHeads 是纯函数、无副作用，短路掉它行为完全等价。
    const padInjectAllowed =
      !isAcademic && isCasual && !padForbiddenGenre && countPadHeads(out.join("")) < PAD_INJECT_CAP;
    if (
      padInjectAllowed &&
      rng() < INTERJECTION_RATE * intensity &&
      !lastWasInterjection &&
      !/^[，。！？!?；;]/.test(s) &&
      isCJK(s.charAt(0)) &&
      !startsWithConnector(s)
    ) {
      let cand = pick(rng, INTERJECTIONS);
      let guard = 0;
      while (usedInterjections.has(cand) && guard++ < 3) cand = pick(rng, INTERJECTIONS);
      usedInterjections.add(cand);
      s = cand + "，" + s;
      lastWasInterjection = true;
    } else {
      lastWasInterjection = false;
    }

    // 长句偶尔劈成两句
    // v0.9.51：参数表段不劈——C18 招标参数表实测条目句「配置不少于 2 颗 32 核
    // 处理器，内存容量不低于 512GB，硬盘容量不低于 4TB NVMe SSD，支持 RAID
    // 0/1/5/6」被这条路径劈成五句，规格表述碎成散文。与结构层
    // （structuralShuffleParagraph）/ 节奏兜底（boostBurstinessSingle）的
    // 参数表跳过同判据，三条路一起堵。
    if (
      !specTablePara &&
      s.length > SPLIT_SENTENCE_THRESHOLD &&
      rng() < SPLIT_SENTENCE_RATE * intensity
    ) {
      const mid = findSplitPoint(s, SPLIT_SENTENCE_THRESHOLD + 1);
      if (mid !== -1) {
        const tail = s.slice(mid + 1).trim();
        // v0.8.5：劈出的后半句必须能独立成句（使役"让/使/帮/叫"承接前句宾语时不能切）
        if (fragmentCanStand(tail)) {
          out.push(s.slice(0, mid).trim() + "。");
          out.push(tail);
          continue;
        }
      }
    }

    // 过短句偶尔与前句合并 —— 仅论说/公文/普通文风。
    //
    // v0.9.8 P0 收敛（六·续）：概率改用 eff（斜坡）。
    //   断崖真凶之一（scripts/_punct_probe.ts）：
    //     0.35 档「…路上。路过巷口…」保持独立（avgLen 20.4）
    //     0.40 档被合并成「…路上，路过巷口…」→ 三条一焊 avgLen 52.5 → 长句项独得 17 分
    //   为何 0.35 干净而 0.40 爆炸：合并开关跟着 intensity 线性爬（0.35→0.40 已能命中），
    //   而唯一的切句力量 boostBurstinessSingle 挂在 `intensity > 0.4` 严格比较上——
    //   0.40 档「合并开着、切句没开」，句长单向膨胀。这是**阈值错位**，不是撒得太多。
    //   改用 eff 后 0.35 档合并概率≈0，与切句阈值同向放开。
    //
    // v0.9.8 P0 收敛（六·续二）：叙事/人写体裁**不合并**。
    //   证据（scripts/_narr_len.ts，NARR_MULTI 0.9 档）：seed 间 avgLen 在 19.4 / 33 之间跳，
    //   段数虽保持 3，但段内短句被焊成长句（65 字段里出现 33 字长句）。
    //   叙事文本的断句本身就是作者的节奏表达——把「…汤。我…」焊成
    //   「…汤，我…」改变了语气，且丢失断句信息。humanize 的职责是去 AI 味，
    //   不是重写作者的句子边界。
    //   注意用 opts.genre 而非 effectiveGenre：humanizeSingle 作用域内只有 opts，
    //   调用方 humanize 已把 effectiveGenre 注入 opts.genre（见 humanize 内两处调用）。
    const mergeForbiddenGenre = opts.genre === "narrative" || opts.genre === "humanHand";
    // v0.9.36：纯标点段（切句残余的闭引号/闭括号）**不参与"短句合并"**，原样附回前句尾。
    //
    // 实证（2026-10-13 对话体语料人眼审查）：`"好，我这就去准备。"` 被切句后残余一个
    // 独立引号段，走进下面的合并模板「剥句尾标点 + ，+ s」⇒ 产出 `"好，我这就去准备，"`——
    // **句末句号被换成逗号、引号还在外面**，标点损坏（全种子复现）。
    // 引号不是"短句"，附回时不该动任何标点。
    const sHasWordChar = /[\u4e00-\u9fa5a-zA-Z0-9]/.test(s);
    if (!sHasWordChar) {
      if (out.length > 0) out[out.length - 1] += s;
      else out.push(s);
      continue;
    }
    if (
      !specTablePara &&
      !mergeForbiddenGenre &&
      out.length > 0 &&
      s.length < MERGE_SENTENCE_THRESHOLD &&
      out[out.length - 1].length < MERGE_SENTENCE_PREV_MAX &&
      rng() < MERGE_SENTENCE_RATE * eff
    ) {
      const prev = out.pop()!;
      out.push(prev.replace(/[。！？!?]+$/, "") + "，" + s);
      continue;
    }

    // 句尾偶尔软化
    if (
      !isAcademic &&
      /[。！]+$/.test(s) &&
      !lastWasInterjection &&
      !/[吗呢吧么啊]$/.test(s.slice(0, -1)) &&
      !/(性|化|所以|以及|亦|之所|不光|不仅|不但|与|互为|予以)/.test(s) &&
      isCJK(s.charAt(s.length - 2))
    ) {
      // v0.8.5 语体守卫：句尾落在书面抽象名词上时不加尾助词——
      // 「教育的本质呀。」「技术发展趋势嘛。」是书面语体 + 口语气词的错位组合，
      // 既是 scan-bugs 探针签名，也是真人一眼能读出的机器感。
      const stripped = s.replace(/[。！？!?]+$/, "");
      const formalityGuard =
        /[\u4e00-\u9fa5]{0,4}(行业|趋势|教育|技术|发展|本质|方案|融合|转型|体系|机制|模式|能力|水平|质量|效率|价值|意义|作用|目标|战略|格局|态势)$/.test(
          stripped,
        );
      const r = rng();
      // v0.9.8 P0 收敛（六·续）：叙事/人写体裁禁句尾语气词。
      //
      // 证据（scripts/archive/_narr9.ts，叙事种子 9）：即使句尾软化走了斜坡，
      //   0.80/1.00 档仍恒定产出 29 分（句式 28），污染源就是句尾「哈。」「呢。」——
      //   「…停不了哈。」「…叶子贴了一地呢。」这类聊天腔落在叙事文上是语体错位。
      //   avg 只有 2.1 却 max 29，一个坏种子的体验远重于均值。
      //
      // 为什么此前保留单字尾：注释（见下）说「A/B 显示不贡献污染分」，
      //   但那是在 humanizeSingle 单层测的；全文级（含朱雀层）复测推翻了该结论。
      //   对 casual 的论说/对话体裁仍保留——那里「嘛」「吧」是有效的人味信号。
      // v0.9.44：收敛到**只 dialogue 允许**句尾语气词（此前是 humanHand/narrative 禁、
      // main 照给）。
      //
      // 为什么连 main 一起禁（2026-10-14 引擎行为审计，21 篇真人文本/17.2 万字）：
      //   main 是**默认/通用**语体，同时承载口语化自媒体文案**与**书面说明文/公文。
      //   实测在 main 下向 19 篇**书面**文本注入了 354 处句尾语气词
      //   （4.5 处每百句，密度最高的《老舍》10.6 处每百句）：
      //     「1928年國民政府将北京改为北平**吧**。」「…视为北京城的源头**呢**。」
      //   ⇒ 书面/公文语体里的**明确病句**，而且方向是反的——AI 文本最爱加语气词，
      //     给书面稿加语气词等于**替 AI 加特征**。
      //
      // 与本函数下方评分器自相矛盾的事实：`humanize-metrics.ts` 把句尾语气词列为
      // 「3a 硬插，一次即定性」，**W_TAIL_PARTICLE = 12 分/处**（真污染扣分）。
      // 引擎此前是在**注入自己判定为污染的东西**。
      //
      // 需要口语人味的用户有 dialogue 这个显式选项，不必由 main 兜底。
      const tailForbiddenGenre = opts.genre !== "dialogue";
      // v0.9.36：引述标记「X道」（说道/问道/答道…）收尾不加语气词——「说道吧。」「问道呢。」
      // 是引述标记与口语气词的错位组合（对话体语料实测全种子复现，min repro: artifacts/_repro-v8.ts）。
      // 与 scan-bugs v8.0 探针「引述动词+语气词」共用 REPORTING_DAO_RE，判据天然对齐。
      const reportingTail = REPORTING_DAO_RE.test(stripped);
      if (!formalityGuard && !tailForbiddenGenre && !reportingTail) {
        // v0.9.8 P0 收敛（五）：废除 SOFT_TAIL_VARIANTS 句尾收束分支。
        //
        // 证据（A/B 实验，scripts/_ab_driver.ts）：单独关掉本分支，
        //   叙事 12 → 2（句式 12 → 0），论说与对话零变化 —— **只降不升**，
        //   是四个注入器里唯一净收益的收敛点。
        //
        // 为什么它是污染源：SOFT_TAIL_VARIANTS 全部 7 条都是口语插话
        //   （「，说白了。」「，你细品。」「，实话实说。」「，就这么回事。」
        //    「，搁谁都一样。」「，没毛病。」「，对吧。」），
        //   其中 5 条直接命中标尺 3e 的垫词/碎片表。
        //
        // 为什么可以删：它的设计目的是「制造收束节奏」，而这个职能已被
        //   boostBurstinessByCutting（纯切句、零注入）接管 —— 功能重复，
        //   且旧实现引入了新标尺要抓的污染。删掉不留功能缺口。
        //
        // 保留 SOFT_ENDINGS 单字尾（吧/呢/呀，概率 0.06×intensity 很低）：
        //   它们更轻，且 A/B 显示不贡献污染分（关掉后叙事仍是 12）。
        // 废除 SOFT_TAIL_VARIANTS 句尾收束分支（原第 1 分支）：
        //   `if (r < SOFT_ENDING_PROB * intensity && isCasual) { s += pick(rng, SOFT_TAIL_VARIANTS); }`
        // 只保留单字尾软化分支。
        // v0.9.8 P0 收敛（六·续）：概率改用 eff（斜坡）。
        //   句尾软化是全档位唯一「跟着 intensity 全程线性走」的注入线，
        //   0.35 档仍会撒「嘛/哈」（scripts/_punct_probe.ts 实测 seed=1/3 命中「嘛」），
        //   与「低档位应近乎零注入」的定位冲突。改用 eff 后 0.35 档自然归零。
        //
        // 保留 SOFT_ENDINGS 单字尾（吧/呢/嘛/呀/哈）：它们本身很轻，
        //   问题只在「不该在低档位出现」，不在「不该存在」。
        if (r < SOFT_ENDING_PROB * eff + SOFT_TAIL_PROB * eff) {
          s = s.replace(/[。！？!?]+$/, "") + pick(rng, SOFT_ENDINGS) + "。";
        }
      }
    }

    out.push(s);
  }

  if (on)
    emitStage(
      on,
      {
        id: "sentence",
        name: "逐句处理（节奏层）",
        why: "逐句跑四件事：句首垫词、劈长句、合并过短句、句尾软化。所有注入都受垫词总预算约束；剧本台词行与场景块行整句跳过，避免把垫词插到说话人前面。",
        charsBefore: working.length,
        metric: `句数 ${sentences.length} → ${out.length}`,
        ...(para === undefined ? {} : { para }),
      },
      tSent,
      out.join(""),
    );

  // 3) 重新拼接 + 清理
  const tJoin = on ? nowMs() : 0;
  let result = out
    .join("")
    .replace(/\n{2,}/g, "\n")
    .trim();
  result = result.replace(/—{3,}/g, "——");
  result = result
    .replace(/但，/g, "但")
    .replace(/([，、])\1+/g, "$1")
    .replace(/。，/g, "。")
    .replace(/，。/g, "。");
  result = stripCJKEdgeSpaces(result);
  if (on) {
    emitStage(
      on,
      {
        id: "cleanup",
        name: "拼接清理",
        why: "劈句与合并会留下重复标点、悬空连接词和「但，」这类粘连，这里统一收口。",
        charsBefore: prev.length,
        ...(para === undefined ? {} : { para }),
      },
      tJoin,
      result,
    );
    prev = result;
  }

  // 4) 确定性套话兜底
  const tCliche = on ? nowMs() : 0;
  result = stripAICliches(result);
  result = stripLeadingConnectivesHard(result);
  result = dedupePadWords(result);
  if (on) {
    emitStage(
      on,
      {
        id: "cliche",
        name: "套话兜底（与强度无关）",
        why: "确定性兜底，不吃强度参数：删残留 AI 套话、删句首连接词、全文去重垫词。前面所有概率性 pass 都可能漏，这一层保证下限。",
        charsBefore: prev.length,
        ...(para === undefined ? {} : { para }),
      },
      tCliche,
      result,
    );
    prev = result;
  }

  // 半角逗号微混入
  result = step(
    "halfwidth",
    "半角逗号微混入",
    "按 4%×强度 把全角逗号换成半角。真人手写中英混排时标点并不统一，这一点点不一致反而是人味。",
    () => injectHalfWidth(result, rng, 0.04 * intensity),
  );

  // 5) 句长节奏兜底
  const tBurst = on ? nowMs() : 0;
  // v0.9.51：参数表段落跳过节奏兜底。C18 招标参数表实测：条目句的参数并列
  // （「配置不少于 2 颗 32 核处理器，内存容量不低于 512GB，硬盘容量不低于
  //   4TB NVMe SSD，支持 RAID 0/1/5/6」）被 findGuardedCutNear 在每个逗号处
  // 劈开，规格表述碎成散文。参数表的节奏就是枚举节奏，不需要句长方差。
  if (intensity > 0.4 && !specTablePara) {
    const rng2 = makeRng(opts.seed, 3333);
    result = boostBurstinessSingle(result, rng2, 0.5 * intensity);
  }
  if (on) {
    emitStage(
      on,
      {
        id: "burst-single",
        name: intensity > 0.4 ? "段内节奏兜底" : "段内节奏兜底（跳过）",
        why: "段一级再补一次句长方差：只劈长句、不注入任何新词。全文级那道兜底在 humanize() 末尾，这里管段内。",
        charsBefore: prev.length,
        metric:
          intensity > 0.4
            ? `劈句概率 ${(0.5 * intensity).toFixed(2)}`
            : `强度 ${intensity.toFixed(2)} ≤ 0.4，段内不切`,
        skipped: !(intensity > 0.4),
        ...(para === undefined ? {} : { para }),
      },
      tBurst,
      result,
    );
    prev = result;
  }

  // 6) 标点相撞兜底 —— 必须放在**最后**。
  //    上面第 3 步已经做过一次同样的归一，但第 4/5 步会重新造出坏标点：
  //    stripAICliches 删掉句尾套话（「具有十分重要的意义」）后留下悬空的「，」，
  //    接上原句的「。」就是「，。」——示例文本实测 80 次里 40 次命中，
  //    而 aiScore 对这种标点残缺给中位 6 分（它只看词与结构，看不见坏标点）。
  //    injectHalfWidth 掺的是半角「,」，这里只收全角相撞形态，不会互相抵消。
  result = result
    .replace(/([，、])\1+/g, "$1")
    .replace(/，。|。，/g, "。")
    .replace(/。{2,}/g, "。")
    .replace(/(^|\n)[，、。；：]+/g, "$1");

  return result;
}

/* ======================== 朱雀增强：深度反检测特征 ======================== */

/** 启动时预计算剔除自替身后的候选列表（与 replaceVocab 一致） */
const DIALECT_CANDIDATES: [string, string[]][] = DIALECT_ENTRIES.map(([from, tos]) => {
  const realTos = tos.filter((t) => t !== from);
  return [from, realTos.length ? realTos : tos];
});

/**
 * 方言/地域化口语替换。
 *
 * @deprecated v0.9.8 P0 —— **已停用，不再被 applyZhuqueFeatures 调用**。
 * 停用原因见 applyZhuqueFeatures 内注释：与 anti-fingerprint 的还原表左右手互搏，
 * 注入的 10 处里 8 处被还原，净留的 2 处残渣（寻思/寻/整）同时喂病词与 3e 两个扣分项，
 * 属净负收益。函数本体保留以备回滚，**不要重新接回主路径**。
 * 导出仅为消除 unused 告警并保留回滚入口。
 */
export function injectDialect(text: string, rng: () => number, p: number): string {
  if (p <= 0) return text;
  // P8 场景块保真：按行护盾——方言表单字词（做/说/从/看）会污染【场景：从早上八点】类块头
  return text
    .split("\n")
    .map((ln) => (isSceneBlockLine(ln) ? ln : injectDialectLine(ln, rng, p)))
    .join("\n");
}
function injectDialectLine(base: string, rng: () => number, p: number): string {
  for (const [from, candidates] of DIALECT_CANDIDATES) {
    const total = base.split(from).length - 1;
    if (total === 0) continue;
    // 每词上限：最多 3 处，且不超过全文出现次数 × 0.25（+p 保证 p 足够大时至少改 1 处）
    const cap = Math.max(1, Math.min(3, Math.ceil(total * 0.25 + p)));
    let replaced = 0;
    let idx = 0;
    while ((idx = base.indexOf(from, idx)) !== -1 && replaced < cap) {
      // 每个命中位置无条件消耗一次 rng（与原实现 rng 序列消费节奏一致）
      if (rng() < p) {
        const rep = pick(rng, candidates);
        base = base.slice(0, idx) + rep + base.slice(idx + from.length);
        idx += rep.length;
        replaced++;
      } else {
        idx += from.length;
      }
    }
  }
  return base;
}

// P7-F 段落感知：splitSentences().trim() 会剥掉句尾 \n\n，splitSentences→join("") 会把
// 多段焊成一段（postmortem 缺陷二的同款模式）。朱雀增强路径的三处全文级注入必须复用
// boostBurstiness / clampAvgSentenceLenUnder25 已验证的分段分发模式。
function injectParentheticals(text: string, rng: () => number, p: number): string {
  if (!text.includes("\n\n")) return injectParentheticalsBlock(text, rng, p);
  return text
    .split(/\n\n+/)
    .map((para) => injectParentheticalsBlock(para, rng, p))
    .join("\n\n");
}
function injectParentheticalsBlock(text: string, rng: () => number, p: number): string {
  // v0.9.8：按行分发——剧本块头行与台词行原样保留。
  // splitSentences 会跨行切句，直接用 isSceneBlockLine 逐句判定会漏掉台词行
  // （「张总（项目经理）：…」不含【】，块头判定不命中）。
  return text
    .split("\n")
    .map((line) => {
      if (isScriptFormatLine(line)) return line;
      const sentences = splitSentences(line);
      const out: string[] = [];
      for (let i = 0; i < sentences.length; i++) {
        let s = sentences[i];
        if (s.length < 15 || rng() >= p) {
          out.push(s);
          continue;
        }
        const comma = s.indexOf("，");
        if (comma > 3 && comma < s.length - 5) {
          const paren = pick(rng, PARENTHETICALS);
          const form = rng() < 0.5 ? "，" + paren + "，" : "——" + paren + "——";
          s = s.slice(0, comma) + form + s.slice(comma + 1);
        }
        out.push(s);
      }
      return out.join("");
    })
    .join("\n");
}

function injectFragments(text: string, rng: () => number, p: number): string {
  const paras = text.split(/\n\n+/);
  if (paras.length < 2) return text;
  const out: string[] = [];
  // v0.8.4：碎片全文去重 + 总量封顶（约每 3 段最多 1 条）——原实现可同碎片复读、
  // 多段连塞，碎片复读与语气词复读一样是可被统计抓到的机器指纹
  const used = new Set<string>();
  let injected = 0;
  const cap = Math.max(1, Math.ceil(paras.length / 3));
  for (const para of paras) {
    let ptext = para.trim();
    if (!ptext) continue;
    if (injected < cap && rng() < p) {
      const fresh = SENTENCE_FRAGMENTS.filter((f) => !used.has(f));
      if (fresh.length) {
        const frag = pick(rng, fresh);
        used.add(frag);
        ptext += "\n\n" + frag;
        injected++;
      }
    }
    out.push(ptext);
  }
  return out.join("\n\n");
}

// P7-F 段落感知：同 injectParentheticals，避免多段被焊成一段
function injectOpinion(text: string, rng: () => number, p: number): string {
  if (!text.includes("\n\n")) return injectOpinionBlock(text, rng, p);
  return text
    .split(/\n\n+/)
    .map((para) => injectOpinionBlock(para, rng, p))
    .join("\n\n");
}
function injectOpinionBlock(text: string, rng: () => number, p: number): string {
  // v0.9.8：按行分发——剧本块头行与台词行原样保留。
  // 台词行漏网时 injectOpinion 会把垫词插到说话人**前面**：
  //   「讲真，张总（项目经理）：这个季度的指标完成得怎么样了？」
  // 说话人标签前不得有任何修饰，这会直接破坏剧本格式。
  const used = new Set<string>();
  return text
    .split("\n")
    .map((line) => {
      if (isScriptFormatLine(line)) return line;
      const sentences = splitSentences(line);
      const out: string[] = [];
      let lastOpinion = false;
      for (let i = 0; i < sentences.length; i++) {
        let s = sentences[i];
        const hasOpinion = /^(我觉得|我认为|在我看来|以我的经验|我个人的看法|我寻思着|要我说)/.test(
          s,
        );
        const hasInterjection = /^(说真的|说实话|老实讲|讲真|说白了|你别说|不瞒你说)/.test(s);
        if (s.length > 10 && rng() < p && !lastOpinion && !hasOpinion && !hasInterjection) {
          let op = pick(rng, OPINION_PHRASES);
          let guard = 0;
          while (used.has(op) && guard++ < 3) op = pick(rng, OPINION_PHRASES);
          used.add(op);
          s = op + "，" + s;
          lastOpinion = true;
        } else {
          lastOpinion = false;
        }
        out.push(s);
      }
      return out.join("");
    })
    .join("\n");
}

// P7-F 段落感知：同 injectParentheticals，避免多段被焊成一段
function injectParentheticNotes(text: string, rng: () => number, p: number): string {
  if (!text.includes("\n\n")) return injectParentheticNotesBlock(text, rng, p);
  return text
    .split(/\n\n+/)
    .map((para) => injectParentheticNotesBlock(para, rng, p))
    .join("\n\n");
}
function injectParentheticNotesBlock(text: string, rng: () => number, p: number): string {
  const sentences = splitSentences(text);
  const out: string[] = [];
  for (const s of sentences) {
    if (isSceneBlockLine(s)) {
      out.push(s);
      continue;
    }
    if (s.length > 15 && rng() < p) {
      const note = "（" + pick(rng, PARENTHETIC_NOTES) + "）";
      out.push(s + note);
    } else {
      out.push(s);
    }
  }
  return out.join("");
}
