/**
 * 趣AI味 · 替换层：VOCAB 词汇替换 / 开头替换 / 模板替换 / 松弛类精修
 * （relaxLe / softenPassive / relaxIntensifierVerb / relaxRedundantVerb）。
 *
 * v0.9.53 拆分阶段 1b 第 2 步（docs/humanize-split-plan.md）：
 * 原为 humanize.ts 内联区块（301–823 行）。实测该层只被
 * humanizeSingle() 与 applyZhuqueFeatures() 调用，humanize() 主流程不直接用——
 * 因此可整体下沉，两个调用方（humanize.ts / humanize-zhuque-apply.ts）单向 import。
 *
 * 依赖方向（无环）：本模块 → humanize-data / humanize-rules / text-shield / term-protect
 */

import {
  INFORMAL_ONLY_KEYS,
  LE_VERBS,
  MEDIUM_NOUN_AFTER,
  OPENERS,
  guardBlocks,
  pick,
  RewriteStyle,
} from "./humanize-data.ts";

import {
  ABSTRACT_OBJECT_RE,
  COLLOQUIAL_RESULT_VERBS,
  DIR_MODIFIER_VERB_CLASH_RE,
  DROP_CONNECTIVE_INTENSITY_THRESHOLD,
  FORMAL_FORBIDDEN_SUBSTITUTES,
  PARTICLE_PREFIX_BLOCK,
  REPLACE_VOCAB_BASE,
  REPLACE_VOCAB_CANDIDATES,
  REPLACE_VOCAB_SLOPE,
  VOCAB_KEY_SET,
  wouldCascade,
} from "./humanize-rules.ts";

// v0.9.50 书名号/结构化串区间保护（URL、邮箱、文件标题一律不改写）
import { citedTitleSpans, spanGuard } from "./text-shield.ts";
// v0.8.6 术语保护：受保护术语位置禁止替换/拆句
import { isProtectedTerm } from "./term-protect.ts";

/** 剧本格式的场景/人物/背景/时间/角色/旁白/简介 段首块正则（P7-E 共用） */
// P7-E：剧本场景块行头。无锚 + 按行扫描——前置方言/观点注入会在段首加垫词，
// ^ 锚定的整段匹配会被击穿（台词区被塞自问自答的真实缺陷）
export const SCENE_BLOCK_LINE_RE =
  /【[^】]{0,80}(?:场景|人物|角色|地点|时间|背景|旁白|简介)[^】]{0,80}】/;

/* ------------------------------------------------------------------
  v0.9.50 试错存档：SCORING_EXCLUDE 派生冻结（已废弃，保留理由）
  ------------------------------------------------------------------
  思路曾很漂亮：SCORING_EXCLUDE 是项目自己认定的「正常书面语、不计 aiScore」名单，
  那么在正式语体下把它换成口语词的收益恒为 0、风险恒为正 ⇒ 一律冻结。
  实测（scripts/realcase 10 篇 × 12 seed）**确实一分 aiScore 都没掉**。

  但 verify-quality 的门禁全线报警，所以它错在用 aiScore 当唯一代价函数：
    · H0 纯人稿 6 → 7、O1 论说原文检出力 44 → 43、N1 叙事基础档 3 → 8
    · 分离度 min(AI原文)-H0 = 26 < 27（D 组绝对刻度守卫红）
    · 8 条单测红，多数以「提升 → 提高」为载体——这个词被冻掉后，
      宁定语感的去味收益实实在在少了一块。
  ⇒ 正式体裁下**看得过时而被视为 written-language 的词**（提升→提高、显著→明显）
    正是去味的主力，不能因为"不算分"就否掉。
  教训再记一条：**「替换不改善某个指标」不等于「替换没有价值」**。
  aiScore 是本地代理分，拿它当唯一代价函数会把路线带偏（与 memory 里
  「aiScore 不与朱雀官方分标定」同源）。
  处置：回到"见一个冻一个"，但必须有**多种子实测证据**才收录，见 INFORMAL_ONLY_KEYS 注释。
------------------------------------------------------------------ */

/** v0.9 专家修复 P5：academic 文风下禁止的口语替身（书面语体错位签名）。
 *  按源词建白名单表——源词在这些学术语义词上不得替换成口语替身。 */
const ACADEMIC_FROZEN = new Set([
  "改善",
  "持续",
  "推动",
  "认知",
  "总而言之",
  "综上所述",
  "本质上",
  "值得注意的是",
  "由此可见",
  "事实上",
  "此外",
  "因此",
  "然而",
  "从而",
  "进而",
  "逐步",
  "日益",
  "愈发",
  "亟需",
  "亟待",
  "尚待",
  "已然",
  "不容忽视",
  "不容小觑",
  "至关重要",
  // v0.9 长尾：书面连接词的口语替身在学术体里同样错位（与此同时→这期间/另一头）
  "与此同时",
  "伴随着",
  "具体而言",
  "换言之",
  "不仅",
  "而且",
  "诸如",
  "诸如",
]);

/** 替换文本里命中 VOCAB 的词（单趟收集命中、每词条一次线性拼接，避免逐命中整串重建） */
export function replaceVocab(
  text: string,
  rng: () => number,
  intensity: number,
  style: RewriteStyle = "casual",
  /** 正式语体（main / academic）：VOCAB 的口语替身在替换阶段直接否掉，见 FORMAL_FORBIDDEN_SUBSTITUTES */
  formal = false,
): string {
  const p = intensity <= 0 ? 0 : Math.min(1, REPLACE_VOCAB_BASE + REPLACE_VOCAB_SLOPE * intensity);
  const academic = style === "academic";
  const formalSubstituteBlocked = formal || academic;
  // v0.9.50 书名号保护：《…》内的字面不得改写（文件标题改一个字就是篡改事实，
  // 比语体崩严重一档，与 URL 不得丢同性质）。
  // ⚠️ 每个词条重算一次：替换会平移下标，用循环外的旧区间会错位。
  //    代价 O(词条数 × 文本长)，实测单篇亚毫秒，不值得为它维护增量结构。
  const hasTitle = text.includes("《");
  let inCitedTitle: (idx: number) => boolean = () => false;
  let base = text;
  for (const [from, candidates] of REPLACE_VOCAB_CANDIDATES) {
    if (hasTitle) inCitedTitle = spanGuard(citedTitleSpans(base));
    let idx = base.indexOf(from);
    if (idx === -1) continue;
    // P5：academic 冻结表——学术语义词的口语替身（调顺/推一把/没停过/拉总账）
    // 是书面语体 + 口语词的错位签名，学术体下直接跳过替换
    const frozen = academic && ACADEMIC_FROZEN.has(from);
    const hits: { at: number; rep: string }[] = [];
    while (idx !== -1) {
      const end = idx + from.length;
      // 与原实现一致：每个命中位置无条件消耗一次 rng
      if (
        !frozen &&
        rng() < p &&
        // v0.8.6 术语保护：命中位置落在受保护术语内则跳过（不影响 rng 消耗节奏）
        !isProtectedTerm(base, idx, end) &&
        // v0.9.50 书名号保护：文件/作品标题内部的字样一个都不能改
        //（C11 实测：《…评估实施细则》→《…评估执行细则》，等于编了一份不存在的文件）
        !inCitedTitle(idx) &&
        // 前窗取 6 字而非 3 字：够着"受到广泛"这类隔了状语的搭配。
        // judgeGuardBlocks 里所有前缀判据都是尾锚定（endsWith / /…$/），加宽不改变既有行为。
        !guardBlocks(from, base.slice(end, end + 8), base.slice(Math.max(0, idx - 6), idx)) &&
        // v0.9.24 前缀闭包：本词条是某个「助词结尾词条」的前缀 → 一起让位。
        // 见 PARTICLE_PREFIX_BLOCK 注释：不加这条，守卫拦住「取得了」的那一刻，
        // 「取得」会立刻在同一位置顶上来，替换词干并把助词留成病句。
        !PARTICLE_PREFIX_BLOCK.has(from)
      ) {
        // v0.9.49 正式语体候选**预滤**：被否决的替身在 pick 之前就滤出候选池，
        // 而不是 v0.9.46 的"挑了再毙"。后者在强度 1.0（p=1.0，每个命中都过门）
        // 等于按池子比例直接不换——实测赋能（池 4 个毙 3 个）19/25 seed 泄漏、
        // 心智 16/25，verify-quality 的零泄漏门禁当场红。预滤后 pick 永远落在
        // 安全候选上，强度 1.0 恢复 100% 替换。
        // ⚠️ 不违反 rng 纪律：pick 固定只调一次 rng()，滤池子不改变消耗次数，
        //    随机序列与此前逐位一致（变的是"这次挑中谁"，不是"何时挑"）。
        // 整池口语词条（INFORMAL_ONLY_KEYS）不走预滤——它们在下面 clashInformalEntry
        // 整条否决；那些池子里剩下的"次口语"替身（围着/下功夫）同样不许上场。
        const formalPool =
          formalSubstituteBlocked && !INFORMAL_ONLY_KEYS.has(from)
            ? candidates.filter((c) => !FORMAL_FORBIDDEN_SUBSTITUTES.has(c))
            : candidates;
        let rep = pick(rng, formalPool);
        // v0.9.41 替身降级（MEDIUM_DOWNGRADE）：「通过」后紧邻媒介/渠道名词时，
        // 「靠/借」崩坏（"靠短信通知"×）——但与 VERB_PHRASE_AFTER 的处置不同：
        // 那条是「跳过替换」（宁保留原词），本条**降级到「用」**（"用短信通知"√），
        // 保留去味收益。候选里没有「用」时不动（宁保留原选，不引入未验证的替身）。
        // 实证：操作说明语料 × 20 seed，"靠短信通知/靠邮件发送"稳定复现；
        // 判据必须紧邻（8 字窗口会把"通过各部门协作，用短信通知"误算）。
        if (
          (rep === "靠" || rep === "借") &&
          candidates.includes("用") &&
          MEDIUM_NOUN_AFTER.test(base.slice(end, end + 8))
        ) {
          rep = "用";
        }
        // v0.9.22 级联守卫（见 VOCAB_KEY_SET 注释）：替身本身是源词 → 会被下一轮
        // 词条循环再替一次（「实现→落地」后再「落地→真正做出来」）。作废该次替换。
        // v0.8.9 叠字守卫（右侧）：替换词尾字与右侧首字相同时将产生叠字——
        // 「彰显着」→「透着着」、「不仅是」→「不只是是」。
        // v0.9.22 补**左侧**：原守卫只查了右侧，漏了"替身首字撞左侧末字"。
        // 实测「从X的角度」模板先产出"从X看"，随后词条「审视→看看」再命中
        // → **"从治理与合规看看看"**。两侧都要查，缺一边就仍有三连字。
        // 作废时 rng 已消耗，不改变后续随机节奏。
        // ⚠️ 这里不能用 continue —— 循环末尾的 `idx = base.indexOf(from, end)` 是推进语句，
        // continue 会跳过它导致死循环。判定一律并入下面这一个 if。
        const nextCh = base.charAt(end);
        const prevCh = base.charAt(idx - 1);
        const cascade = wouldCascade(rep);
        const clashRight = nextCh !== "" && rep.endsWith(nextCh);
        const clashLeft = prevCh !== "" && rep.startsWith(prevCh);
        // v0.9.22 类别级：口语结果动词接抽象名词宾语 = 搭配不当（见 COLLOQUIAL_RESULT_VERBS）
        const clashAbstract =
          // 窗口必须与 ABSTRACT_OBJECT_RE 的 {0,12} 同宽再加一点余量（宾语词本身也要进得来）
          COLLOQUIAL_RESULT_VERBS.has(rep) && ABSTRACT_OBJECT_RE.test(base.slice(end, end + 14));
        // v0.9.24 类别级：替身**末字或倒数第二字**是助词，且右邻也是助词 = 助词连用。
        //
        // 「抱着」+「了」→「抱着了」；「就出现了」+「地」→「就出现了地」。
        //
        // 为什么 clashRight 拦不住：它查**单字碰撞**，「着」≠「了」⇒ 放行。
        // 与「不光仅」同型——各部分都没问题，合起来才成病（**第三类盲区**）。
        //
        // 全表实测 48 处，分三轮收敛：
        //   v1 只判「着尾+了」     → 48 → 41（漏 着+地/得/着）
        //   v2 「着尾+任一助词」   → 48 → 27（漏 了尾的动补短语）
        //   v3 +「了尾+地得着」    → 48 → 15（漏 源词自身残留助词的）
        //
        // ⚠️ 只看倒数第二字（不是全串扫助词）：替身中间带助词但句尾干净的
        //   情况很少见，全串扫会误伤「得到了成果」这类正常搭配。
        //
        // 注：源词自身以助词结尾的那 15 处（发挥着/取得了/展现出了…）
        // 由 `guardBlocks` 里的**类别规则**拦——只有那里能覆盖前缀链。
        const clashParticle =
          "了地得着".includes(nextCh) &&
          ("了地得着".includes(rep[rep.length - 1]) || "了地得着".includes(rep[rep.length - 2]));
        /**
         * v0.9.50 叠字守卫：替身与**紧随其后的原文**相同 ⇒ 换成重复两遍。
         *
         * 真实案例 C15 政策问答实测：「**生态环境**主管部门」→ 生态→环境 ⇒「**环境环境**主管部门」。
         * 这条比前面几条都便宜，因为它不需要语言知识：产出的前 n 字 == 紧邻原文的前 n 字，
         * 就是字面意义上的"写了两遍"，任何语体都不通。
         *
         * ⚠️ 只比**紧邻窗口**（rep 自身长度），不做全句搜重：
         * 远距离重复是作者自己的行文问题，不该由替换层背锅。
         */
        const clashDuplicate = base.startsWith(rep, end);
        // v0.9.31：方向修饰语 + 行为动词 = 搭配不当（见 DIR_MODIFIER_VERB_CLASH_RE 注释）。
        // 只测 `替身 + 右邻 2 字`：够判定"正向"后面接的是不是行为动词。
        const clashDirVerb = DIR_MODIFIER_VERB_CLASH_RE.test(rep + base.slice(end, end + 2));
        // v0.9.46 正式语体守卫：口语替身在替换阶段就否掉（详见 FORMAL_FORBIDDEN_SUBSTITUTES）。
        // ⚠️ v0.9.49 起这条是**兜底**：正式体的候选池已在 pick 前预滤（见上方 formalPool），
        //    正常路径走不到这里；留着是防将来有人改预滤条件时静默失效。
        const clashFormalSub = formalSubstituteBlocked && FORMAL_FORBIDDEN_SUBSTITUTES.has(rep);
        // v0.9.49 词条级正式语体守卫：整池口语的词条（数据见 humanize-vocab.ts 的
        // INFORMAL_ONLY_KEYS）在正式体裁下不发起替换——治本替代身级逐条打补丁。
        // 位置刻意放在 pick **之后**：pick 消耗的 rng 必须照常发生，否则正式体裁下的
        // 随机序列与 v0.9.48 不同，全仓 seed 敏感断言整体漂移（与 clashFormalSub 同哲学）。
        const clashInformalEntry = formalSubstituteBlocked && INFORMAL_ONLY_KEYS.has(from);
        if (
          rep &&
          !cascade &&
          !clashRight &&
          !clashLeft &&
          !clashAbstract &&
          !clashParticle &&
          !clashDuplicate &&
          !clashDirVerb &&
          !clashFormalSub &&
          !clashInformalEntry
        )
          hits.push({ at: idx, rep });
      }
      idx = base.indexOf(from, end);
    }
    // 同一词条内各命中互不重叠，一次线性拼接完成全部替换
    if (hits.length) {
      let out = "";
      let cursor = 0;
      for (const { at, rep } of hits) {
        out += base.slice(cursor, at) + rep;
        cursor = at + from.length;
      }
      base = out + base.slice(cursor);
    }
  }
  return base;
}

/** 处理 "随着……的发展" 套话 */
export function replaceWithDevelopment(text: string, rng: () => number, intensity: number): string {
  const re = /随着[\s\S]{0,18}?(的)?发展[，,]?/g;
  const timeTail = /(?:如今|现在|眼下|后来)[，,]?$/;
  return text.replace(re, (m: string, _g: string, offset: number, str: string) => {
    // v0.9.31：这条套话的删除会**连坐后句的主语**——「随着人工智能技术的不断发展，其在…」
    // 里「其」的先行词正是"人工智能技术"，状语一删，「其」就无所指（实测 6/30 命中
    // 「现在其在各个领域的应用越来越广泛。」，scan-bugs v8.0「代词主语悬空」）。
    // 故后接代词主语时整条保留，宁可留一处套话也不造病句。
    // rng() 照常消耗一次：守卫若少抽一次，后续所有随机步骤整体错位，
    // 等于用"改不改病句"顺手改了一遍全局随机序列——那是另一类不可控。
    if (/^(?:其|它|它们|该|此|这|那)/.test(str.slice(offset + m.length))) {
      rng();
      return m;
    }
    if (timeTail.test(str.slice(0, offset))) {
      return rng() < Math.max(intensity, 0.85) ? "" : m;
    }
    return rng() >= intensity ? m : pick(rng, ["如今", "现在", "", "", "后来"]);
  });
}

/** 句首连接词替换 */
export function replaceOpener(sentence: string, rng: () => number, p: number): string {
  for (const [from, tos] of Object.entries(OPENERS)) {
    if (sentence.startsWith(from)) {
      if (!"，、。：；".includes(sentence.charAt(from.length))) continue;
      if (rng() < p) return pick(rng, tos) + sentence.slice(from.length);
    }
  }
  return sentence;
}

/** 预编译：冗余动词前缀正则（热路径免循环内重复构造） */
const RELAX_REDUNDANT_RES = ["进行", "予以", "加以"].map(
  (pre) => new RegExp("(?<![正在])" + pre + "(?![了到下])([\\u4e00-\\u9fa5]{2,4})", "g"),
);

export function relaxRedundantVerb(text: string, rng: () => number, p: number): string {
  for (const re of RELAX_REDUNDANT_RES) {
    text = text.replace(re, (_m, verb: string) => (rng() < p ? verb : _m));
  }
  return text;
}

/**
 * 被动软化白名单：AI 稿爱堆无施事被动（被广泛使用于 / 受到广泛关注 / 被认为是），
 * 人写稿通常把施事补出来或干脆说主动。
 *
 * 只做**固定搭配整块替换**，不做切词式泛化：非白名单的"得到提高""受到启发"一律不碰，
 * 按"被+V于X"通用捕获重排会把主语边界切错（历史版本实测切出"人工智能技在…中，术…"）。
 */
const PASSIVE_REWRITES: { re: RegExp; variants: string[] }[] = [
  {
    re: new RegExp("被广泛使用于([^\\n，。！？；]{2,20})", "g"),
    variants: ["在$1用得很广", "在$1到处都在用"],
  },
  { re: /受到广泛关注/g, variants: ["大家都很关注", "被不少人盯着看", "挺受看重"] },
  { re: /得到广泛认可/g, variants: ["大家都很认可", "口碑不错", "普遍叫好"] },
  // 必须保留系词"是"；且替身要能直接接在原主语后面——"大家普遍觉得是"会留下
  // "这大家普遍觉得是行业趋势"这种悬空话题，"公认是/大家都说是"才读得通。
  { re: /被认为是/g, variants: ["公认是", "大家都说是"] },
  // "大家管它叫"要不得：原句式是「主语 + 被称之为 + 宾」，换完变"它大家管它叫里程碑"，
  // 主语与"管它"重复。只有能直接跟在主语后的谓语性说法才安全。
  { re: /被称之为/g, variants: ["人称", "俗称"] },
];

export function softenPassive(text: string, rng: () => number, p: number): string {
  for (const { re, variants } of PASSIVE_REWRITES) {
    text = text.replace(re, (...args: unknown[]) => {
      const matched = args[0] as string;
      if (rng() >= p) return matched;
      const g1 = args[1];
      return pick(rng, variants).replace(/\$1/g, typeof g1 === "string" ? g1 : "");
    });
  }
  return text;
}

/** 强化副词+动词搭配修残 */
const INTENSIFIER_ADV = ["大幅", "非常", "特别", "极为", "格外", "十分", "高度", "进一步", "不断"];
const INTENSIFIER_VERB = ["提高", "提升", "增强", "加强", "降低", "减少", "优化"];
/** 预编译：强化副词+动词搭配正则（热路径免 join 重组） */
const INTENSIFIER_RE = new RegExp(
  "(" + INTENSIFIER_ADV.join("|") + ")(" + INTENSIFIER_VERB.join("|") + ")(?!了)",
  "g",
);

export function relaxIntensifierVerb(text: string, rng: () => number, p: number): string {
  const re = INTENSIFIER_RE;
  return text.replace(re, (_m, _adv: string, verb: string) => (rng() < p ? verb : _m));
}

/**
 * v0.9.33：目的/未然从句里的完成态动词**不许补「了」**。
 *
 * 实测：政务短章 30 次运行命中 16 次「以保证其在健康有序的轨道上踏实推进了。」
 * ——「以确保/为了/需要/应当」引导的从句，动作**尚未发生**，补上「了」就把它标成
 * 已完成，是时态错误（不是语感问题，是语法错误）。
 *
 * 守卫与探针（`scan-bugs` v8.0「未然从句补了」）**共用这一条正则**：
 *   守卫侧测 `从句头…动词 + 句末标点`，探针侧测整段输出——同一形态、同一条判据。
 * ⚠️ 不含「使得」：「这使得效率提升了。」是**合法**完成态，人写也这么说。
 */
export const PURPOSE_LE_RE =
  /(?:\u4ee5\u786e\u4fdd|\u4ee5\u4fdd\u8bc1|\u4e3a\u4e86|\u4ee5\u4fbf|\u65e8\u5728|\u529b\u6c42|\u4ee5\u671f|\u624d\u80fd|\u9700\u8981|\u5e94\u5f53|\u5e94\u8be5|\u5fc5\u9808|\u6709\u5f85|\u5373\u5c06|\u5c06\u8981)[^\u3002\uff01\uff1f\n]{2,40}\u4e86[\u3002\uff01\uff1f]/;

/**
 * v0.9.50：规范性/祈使性子句里的完成态动词**不许补「了」**。
 *
 * 与 PURPOSE_LE_RE 同机制、另一类形态：那条守的是"动作尚未发生"，这条守的是
 * "子句所述动作是**规定**，不是已发生的事实"。
 *
 * 实测（scripts/realcase C11 行政通知，本次扩语料抓到）：
 *   「请结合实际认真贯彻落实。」→「请结合实际认真贯彻落实**了**。」
 * 一纸尚未执行的规定，被改写成一件已完成的事。
 *
 * 为什么**不**按体裁一刀切（这是一个 v0.9.50 试过又放弃的方案）：
 *   正式体裁里也有完全正常的完成态——论文「本文提出该方法并验证了其效果」里的
 *   「了」正是人写的样子；按 genre 关掉会把这一类时态一并砍掉。
 *   ⇒ 与项目一贯口径一致：**判形态，不判体裁**（同界线：坏替身还原被体裁门控
 *     这个坑已经踩过一次，见 anti-fingerprint.ts 的 fixBrokenCollocations 注释）。
 */
export const NORMATIVE_LE_RE =
  /(?:\u8bf7|\u5e94\u5f53|\u4e0d\u5f97|\u4e25\u7981|\u7981\u6b62|\u987b|\u5e94|\u6309\u7167|\u4f9d\u636e|\u53c2\u7167|\u9002\u7528\u4e8e|\u81ea[^\u3002\uff01\uff1f\n]{0,12}\u8d77|\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343]+\u6761)[^\u3002\uff01\uff1f\n]{2,40}\u4e86[\u3002\uff01\uff1f]/;

/** 预编译：补"了"口语化正则（依赖导入的 LE_VERBS） */
const LE_RE = new RegExp(
  "(?<!\u7684[\\u4e00-\\u9fa5]{0,3})(?<!\u4e86[\\u4e00-\\u9fa5]{0,3})(" +
    LE_VERBS.join("|") +
    ")([\u3002\uff01\uff1f!?])",
  "g",
);

export function relaxLe(text: string, rng: () => number, p: number): string {
  const re = LE_RE;
  return text.replace(re, (m: string, verb: string, end: string, offset: number, str: string) => {
    // v0.9.33：从句头到动词之间若出现过目的/未然引导词，这一句整体不补「了」。
    // 测的形态是"补了之后"的样子（clause + verb + 了 + end）——PURPOSE_LE_RE 要的正是
    // "引导词…了。"这个完整形态，少了「了」永远匹配不上（第一版就这么漏的，一条不减）。
    const clauseStart = Math.max(
      str.lastIndexOf("\u3002", offset),
      str.lastIndexOf("\uff01", offset),
      str.lastIndexOf("\uff1f", offset),
      str.lastIndexOf("\n", offset),
      -1,
    );
    const candidateClause = str.slice(clauseStart + 1, offset) + verb + "\u4e86" + end;
    if (
      PURPOSE_LE_RE.test(candidateClause) ||
      // v0.9.50 规范性子句：与上面同一机制，只多一类引导形态（见 NORMATIVE_LE_RE 注释）
      NORMATIVE_LE_RE.test(candidateClause)
    ) {
      rng(); // 守卫命中也抽一次：少抽会让后续随机序列整体错位（同 replaceWithDevelopment 的做法）
      return m;
    }
    return rng() < p ? verb + "\u4e86" + end : m;
  });
}

/** 结构级去味：句/段首过渡词直接删除 */
export function dropLeadingConnectives(text: string, rng: () => number, intensity: number): string {
  if (intensity <= DROP_CONNECTIVE_INTENSITY_THRESHOLD) return text;
  const re =
    /([。！？!?\n])(\s*)(然而|因此|此外|与此同时|同时|另外|而且|更重要的是|综上所述|总而言之|总的说来|总的来说)(，|、)?/g;
  return text.replace(re, (m, end: string, ws: string, _w: string, _c: string) =>
    rng() < 0.35 * (intensity - DROP_CONNECTIVE_INTENSITY_THRESHOLD) ? end + ws : m,
  );
}

/** 处理带"……"通配的套话模板 */
export function replaceTemplates(text: string, rng: () => number, intensity: number): string {
  const rules: { re: RegExp; tos: string[] }[] = [
    {
      re: /以([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)为抓手/g,
      tos: ["拿$1当发力点", "靠$1发力", "用$1当突破口"],
    },
    {
      re: /在([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)的(背景|大环境)下/g,
      tos: ["借着$1的风", "在$1当口", "赶上$1这波"],
    },
    {
      re: /为([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)注入(?:了|了一)?(?:新|强劲|强大|新的)?(动能|活力|动力|血液)/g,
      // v0.9 专家修复 P6：原正则缺「了/强劲」可选组，「为经济增长注入了强劲动力」
      // 整句漏匹配（专家实测 0.9 档原样存活）
      tos: ["给$1添了把劲", "让$1更有劲", "给$1加了把火", "带动了$1"],
    },
    {
      re: /为([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)提供了(有力|坚实|重要)?(支撑|保障)/g,
      tos: ["给$1撑了腰", "为$1兜了底"],
    },
    {
      re: /成为([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)的重要组成部分/g,
      tos: ["成了$1里重要的一块", "变$1里少不了的部分"],
    },
    { re: /以([\s\S]{1,12}?)为契机/g, tos: ["借着$1的机会", "趁$1"] },
    { re: /([\s\S]{1,14}?)发挥着([\s\S]{1,8}?)作用/g, tos: ["$1很重要", "$1顶用", "$1是关键"] },
    {
      re: /为([\s\S]{1,10}?)奠定了(坚实|良好|重要)?基础/g,
      tos: ["给$1打了底", "为$1铺了路", "给$1垫了基"],
    },
    {
      re: /在([\s\S]{1,12}?)方面取得(了)?(显著|明显|良好|阶段性)?成效/g,
      tos: ["在$1上见到了真章", "在$1上干出了名堂"],
    },
    {
      re: /以([\s\S]{1,10}?)为(引领|统领|指导|核心)/g,
      tos: ["由$1带着", "拿$1当头", "以$1为主心骨"],
    },
    {
      // v0.9.22：末尾补一段可选的"看类动词"。原正则只吃到"...的角度"，后面的动词
      // （审视/观察/考量/分析）会被留在原地 → 实测「从治理与合规的角度审视」
      // → 模板产出"从治理与合规看" + 残留"审视" = **"从治理与合规看审视"**。
      // 这些动词正是"从X的角度"这个套话的谓语，套话要整块替换，不能只换半截。
      re: /(?:从|站在)([\s\S]{1,10}?)的(?:角度|视角)(?:来看|出发|讲)?(?:审视|观察|考量|分析|考察)?/g,
      tos: ["搁$1看", "站$1这边看", "从$1看"],
    },
    {
      re: /不仅([\s\S]{1,16}?)，而且([\s\S]{1,16}?)(?=[。，；;])/g,
      tos: ["$1，也$2", "$1，还$2", "不光$1，还$2"],
    },
    {
      re: /不但([\s\S]{1,16}?)，而且([\s\S]{1,16}?)(?=[。，；;])/g,
      tos: ["$1，也$2", "$1，还$2", "不光$1，还$2"],
    },
    {
      re: /一方面([\s\S]{1,16}?)，另一方面([\s\S]{1,16}?)(?=[。，；;])/g,
      tos: ["先说$1，再说$2", "一头$1，另一头$2"],
    },
    {
      re: /既要([^，。；\n]{1,16}?)，也要([^，。；\n]{1,16}?)(?=[。，；;])/g,
      tos: ["$1，也要$2", "又$1，又$2"],
    },
    {
      re: /既要([^，。；\n]{1,16}?)，又要([^，。；\n]{1,16}?)(?=[。，；;])/g,
      tos: ["$1，也要$2", "又$1，又$2"],
    },
    { re: /只要([^，。；\n]{1,16}?)，就([^，。；\n]{1,16}?)(?=[。，；;])/g, tos: ["$1，便$2"] },
    {
      re: /无论([^，。；\n]{1,16}?)，都([^，。；\n]{1,16}?)(?=[。，；;])/g,
      tos: ["不管$1，都$2", "不论$1，都$2"],
    },
    { re: /不管([^，。；\n]{1,16}?)，都([^，。；\n]{1,16}?)(?=[。，；;])/g, tos: ["不论$1，都$2"] },
    {
      re: /并非([^，。；\n]{1,16}?)，而是([^，。；\n]{1,16}?)(?=[。，；;])/g,
      tos: ["不是$1，是$2", "倒不是$1，是$2", "压根不是$1，而是$2"],
    },
    {
      re: /与其(?!说)([^，。；\n]{1,16}?)，不如([^，。；\n]{1,16}?)(?=[。，；;])/g,
      tos: ["与其$1，还不如$2"],
    },
    { re: /这说明([^，。；\n]{1,20}?)(?=[。，；;])/g, tos: ["这其实意味着$1", "说白了就是$1"] },
    {
      re: /由此(?:可见|可以看出)([^，。；\n]{1,20}?)(?=[。，；;])/g,
      tos: ["这么看$1", "照这么说$1"],
    },
    { re: /可以看出([^，。；\n]{1,20}?)(?=[。，；;])/g, tos: ["能瞅出$1", "看得出$1"] },
    { re: /通过([\s\S]{1,8}?)(可以)?看出/g, tos: ["从$1能看出", "拿$1说，能看出"] },
    {
      re: /关于([\s\S]{1,12}?)的(论述|分析|研究|探讨|思考|认识)(表明|指出|发现|显示)?[，,]?/g,
      tos: ["$1这块，", "聊到$1，", "$1这事儿，"],
    },
    { re: /充分发(挥了|挥)/g, tos: ["用足了", "用足"] },
  ];
  let result = text;
  for (const { re, tos } of rules) {
    result = result.replace(re, (...args) => {
      if (rng() >= intensity) return args[0] as string;
      const groups = args.slice(1, args.length - 2);
      let out = pick(rng, tos);
      for (let i = 0; i < groups.length; i++) {
        out = out.split("$" + (i + 1)).join(groups[i] ?? "");
      }
      return out;
    });
  }
  return result;
}

/**
 * 词表命中计数：统计文本里出现的所有 VOCAB 词表词的总次数。
 * 只在开 trace 时调用（全表扫描有成本），用来给出「本步替换了几处」的真实数字。
 */
export function countVocabTokens(text: string): number {
  let n = 0;
  for (const k of VOCAB_KEY_SET) {
    let i = text.indexOf(k);
    while (i !== -1) {
      n++;
      i = text.indexOf(k, i + k.length);
    }
  }
  return n;
}
