/**
 * 趣AI味 · 指标层：AI 味评分 / 指纹体检 / 本地忠实度校验
 *
 * 从 humanize.ts 拆出的独立领域，只依赖 humanize-data.ts 的共享原语，
 * 不依赖核心替换引擎（避免循环依赖）。零第三方依赖。
 *
 * ⚠️ 命名说明：本文件注释里的 `v0.9.6` / `v0.9.7` / `v0.9.8` 指的是
 * **评分标尺的修订批次**，不是产品版本号。二者恰好数字接近，易混淆：
 *   - 标尺批次：标尺公式/权重/词表的每次重新标定（本文件）
 *   - 产品版本：package.json 的 version（面向用户的发版号）
 * 因此出现「产品 0.9.6 的代码里写着标尺 v0.9.8」属正常，不是笔误。
 */

import {
  VOCAB,
  FORMULAIC,
  SCORING_EXCLUDE,
  PAD_WORDS,
  splitSentences,
  sentenceStats,
  MIN_BURSTINESS_CV,
  BROKEN_SUBSTITUTES,
} from "./humanize-data.ts";
import { FORMULAIC_EXTRA } from "./humanize-vocab-extra.ts";
import type { PplFeature } from "../ppl/scorer-core.ts";

/* ----------------------------- AI 味评分（本地启发式代理） ----------------------------- */

/**
 * v0.9.6：口语垫词"独句"表。
 *
 * 这些词在自然口语/对话里完全正常（"事情就这样结束了"），
 * 但引擎会把它机械地插成独立短句：「……必然趋势。就这样。根据……」
 * 只有**独立成句**才算硬伤，所以不能简单计入 BROKEN_SUBSTITUTES（会误伤），
 * 改用句式层的"独句检测"。
 */
const PAD_SENTENCE_WORDS = new Set([
  "就这样",
  "你懂的",
  "说白了",
  "讲真",
  "说真的",
  "老实讲",
  "行吧",
  "好吧",
  "是啊",
  "你说得对",
  "是这个理",
  "随你怎么说",
  "反正",
  "往实了说",
  "往好听了说",
  "说难听点",
  "夸张点说",
  "不瞒你说",
  "这么说吧",
  "差不多得了",
]);

export interface ScoreBreakdown {
  /** 0~100，越高越像 AI 写的（也越高说明质量越差） */
  score: number;
  /** 套话/书面腔词命中数 */
  formulaicHits: number;
  /** 句子数 */
  sentenceCount: number;
  /** 句长变异系数（越大越自然） */
  burstiness: number;
  /** 平均句长 */
  avgLen: number;
  /** v0.9.6：病词命中数（引擎产出的坏替身，越多越糟） */
  brokenHits?: number;
  /** v0.9.6：句式损伤计数（断句/连接词丢失等结构性缺陷） */
  structureHits?: number;
}

/**
 * v0.9.6 修正说明（详见 artifacts/rt-20260914/引擎质量诊断报告-20260914.html）
 *
 * 原实现把 VOCAB 的**全部 key**（= 引擎要替换掉的正常书面语：提升/完善/构建…）
 * 当作 AI 味计分。后果是形成自证闭环：引擎把「构建完善」改成病词「搭起弄全」
 * 后，评分函数检测不到病词 → 判"不像 AI"给最低分 → bestOf 专挑病词最多的稿
 * → 回归把烂成绩锁成基线 → 优化方向被彻底带偏。
 *
 * 修正三点：
 *   1) 正常书面语（SCORING_EXCLUDE，已扩充到 150+ 词）不计分；
 *   2) 新增**病词惩罚**（BROKEN_SUBSTITUTES）——出现坏替身要加分而非无视；
 *   3) 新增**句式完整性检查**——断句、连接词丢失、标点异常等结构性缺陷加分。
 *
 * 目标是让评分函数与"人眼判断"对齐，而不是与引擎自身词表对齐。
 */
/**
 * v0.9.7：口语污染检测用的词表与阈值。
 *
 * 词表直接取自**引擎自己的注入表**（PAD_WORDS / SENTENCE_FRAGMENTS）——
 * 用引擎的注入清单来检测引擎的注入痕迹，口径天然对齐，不会出现
 * "检测器认不出自己注入的东西"这种低级错配。
 *
 * 阈值 0.25 来自标定语料实测（scripts/_calib_ratio.ts）：
 *   阈值 0.25 → 真人写误伤 0/8，引擎污染命中 7/9。
 * 真人写样本最高污染率 0.2（合法垫词开头），留出安全边距。
 */
const POLLUTION_SENTENCE_THRESHOLD = 0.25;

/** 句中/句首垫词（含"其实"这类引擎高频插入词） */
const POLLUTION_PAD_WORDS = [
  ...PAD_WORDS,
  "其实",
  "说到底",
  "具体来说",
  "换句话说",
  "简单说",
  "总体而言",
  "坦白讲",
  "客观讲",
  "往实了说",
  "话又说回来",
];

/** 语气词：紧跟汉字后接标点即算污染痕迹 */
const POLLUTION_PARTICLES = ["嗯", "啊", "哦", "嗨", "咳", "呣", "啧", "诶", "哈", "嗼", "呵"];

/** 碎片句独立成句的整句形态 */
const POLLUTION_FRAGMENTS = [
  "就这样",
  "怎么说呢",
  "反正就那样",
  "你懂的",
  "没别的意思",
  "话是这么说",
  "道理是这个道理",
  "也不是不行",
  "差不多得了",
  "懂的都懂",
  "你别不信",
  "这谁说得准呢",
  "也不是没有道理",
  "行吧",
  "随你怎么说",
  "反正我信了",
  "无话可说",
  "是啊",
  "哦对",
];

const ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PAD_ALT = POLLUTION_PAD_WORDS.map(ESC).join("|");
const FRAG_ALT = POLLUTION_FRAGMENTS.map(ESC).join("|");
const PART_ALT = POLLUTION_PARTICLES.map(ESC).join("|");

/** 句首垫词 + 逗号 */
const POLL_HEAD_PAD_RE = new RegExp(`^(?:${PAD_ALT})[，,]`);
/** 句中垫词 + 逗号（前面至少有 4 个汉字，避免把句首误算两次） */
const POLL_MID_PAD_RE = new RegExp(`^.{4,}?(?:${PAD_ALT})[，,]`);
/** 垫词紧邻堆叠 */
const POLL_PAD_STACK_RE = new RegExp(`(?:${PAD_ALT})[，,]\\s*(?:${PAD_ALT})[，,]`);
/** 语气词跟在汉字后 + 标点 */
const POLL_PARTICLE_RE = new RegExp(`[\\u4e00-\\u9fa5](?:${PART_ALT})[，,。！？]`);
/** 碎片词整体成句（允许前置标点已由切句去掉） */
const POLL_FRAG_RE = new RegExp(`^(?:${FRAG_ALT})[。！？]?$`);

/**
 * 统计"被口语污染的句子"占比。
 *
 * 设计取舍：只看**句子级命中**，不看词频。原因是真人写确实会用垫词
 * （"说真的，这事儿我琢磨好几天了"），但真人**不会在一个句子里堆两个**、
 * 也**不会让每个短句都带个语气词**。句级口径天然把"点缀"和"堆砌"分开。
 */
function countPollutedSentences(text: string): { total: number; polluted: number; ratio: number } {
  const sents = text
    .split(/(?<=[。！？])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sents.length === 0) return { total: 0, polluted: 0, ratio: 0 };

  let polluted = 0;
  for (const s of sents) {
    const bare = s.replace(/[。！？]+$/, "");
    const hit =
      POLL_HEAD_PAD_RE.test(s) ||
      POLL_MID_PAD_RE.test(bare) ||
      POLL_PAD_STACK_RE.test(s) ||
      POLL_PARTICLE_RE.test(s) ||
      POLL_FRAG_RE.test(bare);
    if (hit) polluted++;
  }
  return { total: sents.length, polluted, ratio: polluted / sents.length };
}

export function aiScore(text: string): ScoreBreakdown {
  const stats = sentenceStats(text);
  const n = stats.count;
  if (n === 0) {
    return {
      score: 0,
      formulaicHits: 0,
      sentenceCount: 0,
      burstiness: 0,
      avgLen: 0,
      brokenHits: 0,
      structureHits: 0,
    };
  }

  // ---- 1) 套话命中（真 AI 套话；正常书面语已排除）----
  let hits = 0;
  const haystack = text;
  const ALL_FORMULAIC = Array.from(new Set([...FORMULAIC, ...FORMULAIC_EXTRA]));
  for (const phrase of ALL_FORMULAIC) {
    if (!(phrase in VOCAB) && haystack.includes(phrase)) hits++;
  }
  for (const from of Object.keys(VOCAB)) {
    if (SCORING_EXCLUDE.has(from)) continue; // v0.9.6：正常书面语不再计分
    if (haystack.includes(from)) hits++;
  }

  // ---- 2) 病词惩罚（v0.9.6 新增）----
  // 这些是引擎替换层的"坏替身"，出现即是质量事故，必须让分数反映出来。
  // 注意：部分词（就这样/你懂的/说白了…）在口语里本身正常，
  // 只有被机械插成独立短句才是硬伤 —— 这类改由 3d 的"垫词独句"检测处理，
  // 所以此处排除 PAD_SENTENCE_WORDS，避免双重计分与误伤。
  let broken = 0;
  for (const w of BROKEN_SUBSTITUTES) {
    if (PAD_SENTENCE_WORDS.has(w)) continue;
    if (haystack.includes(w)) broken++;
  }

  // ---- 3) 句式完整性检查 ----
  //
  // v0.9.7 重构：`structure` 的语义从「缺陷**次数**累加器」改为「**分值**累加器」。
  //
  // 起因：旧实现里各检测项往里加的是次数（1~4），最后由 `structure * N` 统一换算成分数。
  // 加入 3e（句级口语污染）后这个设计崩了——3e 的天然量纲是"分值"（8/16/28），
  // 和"次数"混在一起。于是调 `structure * N` 的系数就会**顾此失彼**：
  // 调大让 3e 生效，旧的 3a~3d（次数 1~4）被同时放大到失真；调小则旧项全被削弱。
  // 实测踩到这个坑：系数 8→3 后 M8 从 16 分掉到 6 分、M9 从 8 分掉到 3 分。
  //
  // 现在每个检测项**自带权重、直接给分**，`structure` 只做累加，不再乘系数。
  // 好处：新增检测器时不必再回过头平衡全局系数，各环节可独立标定。
  let structure = 0;
  // 权重常量（集中定义，便于标定时对照）
  //
  // 标定依据：scripts/_calib_holdout.ts（训练集）与 _calib_margin.ts（训练+验证双集）
  // 全程在本仓库上实测（原 D:\deep\quaiwei，2026-09-18 迁至 D:\projects\quaiwei），样本集见 scripts/_calib_corpus.ts。
  //
  // 标定过程记录：
  //   初版权重（10/10/14/9，污染 12/20/30）→ 验证集漏判 2 项（V5 垫词 30、V7 碎片 38）
  //   二者与训练集 M1（30）、M2（39）同位置同分值 → 判定为系统性欠力度而非过拟合
  //   上调至（12/16/20/12，污染 16/26/36）→ 总错判 7→5，验证集漏判 2→1
  //
  // ⚠️ 已知灰区（不再继续上调，这是有意保留的）：
  //   分数 20~36 区间里同时躺着真人写与引擎污染样本，原因各不相同——
  //     H6 正式公文（26）、H8 技术说明（27）：得分来自 avgLen 长句项，与口语污染无关
  //     V2 真人随笔（26）：单个合法垫词，刚过 3e 阈值
  //     M1/V5 纯垫词堆叠（36）：只命中 3e 一项，无其他特征佐证
  //     M9 错别字（20）：短样本仅命中 1 处
  //   **继续上调权重会把 H6/H8/V2 一起推过 40，那是真误伤，代价不可接受。**
  //   故接受灰区存在，靠"组合证据"定性；只有单一特征的短文本本就该落在可疑带。
  const W_TAIL_PARTICLE = 12; // 句尾语气词硬插：一次即定性
  const W_ORPHAN_CONN = 16; // 连接词孤立成句：一次即定性（真人极少如此）
  const W_PAD_SENTENCE = 12; // 垫词独立成句

  // 3a) 句尾语气词硬插：陈述句末尾紧跟单字语气词（"达到了 41.8%嗯。"）
  const tailParticle = (
    text.match(/[\d%．.、，]?[嗯啊哦嗨咳呣啧诶哈]{1,2}[。！？]/g) ?? []
  ).length;
  if (tailParticle > 0) structure += Math.min(2, tailParticle) * W_TAIL_PARTICLE;
  // 3b) 连接词后直接跟句号（"说到底。/具体来说。"—— 连接词被孤立成句）
  // v0.9.7：词表从 6 个扩到 20 个。旧表漏了"换句话说"这类，
  // 导致 M8 样本（说到底。/换句话说。）只被算作 1 处。
  const ORPHAN_CONN_RE =
    /(?:说到底|具体来说|总的来说|换句话说|简单说|总体而言|归根到底|归根结底|一言以蔽之|综上所述|由此可见|值得一提的是|换言之|简而言之|与此同时|在此基础上|从长远来看|本质上|核心在于)[。！？]/g;
  const orphanConn = (text.match(ORPHAN_CONN_RE) ?? []).length;
  if (orphanConn > 0) structure += Math.min(3, orphanConn) * W_ORPHAN_CONN;
  // 3c) 明显错别字（实测"在去年→再去年"这类替换副作用）
  //
  // v0.9.7：从 structure 挪出，独立成项（与病词同级）。
  // 理由：错别字是**语义级**错误——病词只是"读着别扭"，错别字是"字写错了"，
  // 严重程度等同病词，不该混在句式损伤里按 20 分计。独立后：
  //   - 单处错别字即得 30 分（接近但不到阈值），两处 60 分直接定性
  //   - 不与句式项的累加互相挤占
  const TYPO_PATTERNS: RegExp[] = [
    /再去年/g,
    /再上个/g,
    /是实上/g,
    /大这?家/g,
    /时候候/g,
  ];
  let typoCount = 0;
  for (const re of TYPO_PATTERNS) typoCount += (text.match(re) ?? []).length;
  // 3d) 垫词独句：口语垫词被机械插成独立短句。
  //     正常写作里"就这样"可以出现（"事情就这样结束了"），
  //     但绝不会以「就这样。」「你懂的。」这种形态单独成句 —— 那是引擎的插入痕迹。
  for (const w of PAD_SENTENCE_WORDS) {
    const re = new RegExp(
      `(?:^|[。！？!?\\n]\\s*)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[。！？]`,
      "g"
    );
    const c = (text.match(re) ?? []).length;
    if (c > 0) structure += Math.min(3, c) * W_PAD_SENTENCE;
  }

  // 3e) 句级口语污染率（v0.9.7 新增）
  //
  // 背景：v0.9.6 补了「病词惩罚」和「句式损伤」，但实测发现标尺仍有一个**系统性盲区**——
  // 它认不出「口语化污染」。铁证（scripts/_calib_baseline.ts，2026-09-14）：
  //
  //   说真的，其实说白了，在当前背景下，企业要转型。讲真，老实讲，数字化转型不是一蹴而就的。
  //
  // 这段任何中文母语者一眼看出是机器拼的，旧标尺给 **0 分**。原因是四个维度全部落空：
  //   套话项  —— 说真的/讲真/老实讲 不在 VOCAB 也不在 FORMULAIC
  //   病词项  —— 不在 BROKEN_SUBSTITUTES
  //   句式 3d —— 只认「垫词+句号」（你懂的。），这里垫词后面跟的是**逗号**
  //   avgLen  —— 20.5 字、CV 0.07，落在"正常"区间
  //
  // 后果比"漏判"更严重：这是个**自证闭环**。优化器（bestOf）专挑低分稿，
  // 而"把书面句改成满嘴你懂的"正好拿 0 分 → 优化方向被彻底带偏。
  // v0.9.6 修掉过一次同类闭环（引擎造病词 → 标尺不认 → 专挑病词稿），
  // 这里是它的换皮版本：引擎撒口语垫词 → 标尺不认 → 专挑口语垃圾稿。
  //
  // 口径选择（经实测比较，scripts/_calib_ratio.ts / _calib_threshold.ts）：
  //   候选 A「垫词密度（每百字词数）」：零误伤但只命中 4/9 —— 对长文本不公平，
  //     长文里垫词绝对数少、被字数稀释后密度掉到阈值以下，但"被污染的句子"占比其实不低。
  //   候选 B「句级污染率（被污染句数 / 总句数）」：阈值 0.25 时零误伤 + 命中 7/9。
  //   采用 B。
  //
  // 安全边距：真人写样本里最高的污染率是 0.2（H2 那句合法的「说真的，这事儿…」），
  // 与阈值 0.25 之间留出余量。真人会写垫词，但**不会连着堆**——检测器据此取证。
  //
  // 污染句的判定（任一命中即算）：
  //   - 句首垫词 + 逗号（说真的，…）
  //   - 句中垫词 + 逗号（…，说白了，…）
  //   - 垫词紧邻堆叠（说真的，其实…）
  //   - 语气词跟在汉字后 + 标点（…很大嗼。）
  //   - 碎片词独立成句（就这样。/你懂的。）
  const polluted = countPollutedSentences(text);
  if (polluted.ratio >= POLLUTION_SENTENCE_THRESHOLD) {
    // v0.9.7：分段给分（初版线性公式给分过保守，M1/M2/M3 污染率 0.5~1.0 只拿到 7~14 分，
    // 全部卡在 40 阈值下方）。分段依据：污染率越高，越不可能是自然写作。
    //   0.25~0.40 → 16 分（少数句子带痕迹，可能只是风格）
    //   0.40~0.60 → 26 分（明显成片）
    //   >= 0.60   → 36 分（满篇痕迹，直接定性为引擎产物）
    // 与病词项（上限 45）同级但略轻：口语污染不改变语义，病词会改变语义。
    const r = polluted.ratio;
    structure += r >= 0.6 ? 36 : r >= 0.4 ? 26 : 16;
  }

  // 句长统计（复用入口处的 stats，避免重复切句）
  const avgLen = stats.avg;
  const burstiness = stats.cv;
  const lenStd = stats.std;

  // ---------------------------------------------------------------------------
  // v0.9.6 修正（二）：burstiness 反向项的删除
  //
  // 原式 `(1 - min(1, burstiness/0.6)) * 30` 隐含假设「CV 越低越像 AI」，但实测
  // 该假设不成立（scripts/_burst_test.ts，2026-09-14）：
  //
  //   样本            CV     STD    avgLen  人/机
  //   人写·口语随笔    0.27   6.96   25.4    人
  //   人写·正式公文    0.46   10.38  22.6    人
  //   AI·典型套话      0.27   8.77   32.1    机
  //   AI·均匀排比      0.34   8.69   25.6    机
  //
  // 人随手写的口语 CV 反而是全场最低（短句为主、长度集中）。而引擎把文本砸碎
  // 后 CV 可飙到 0.84（劣质输出实测），在旧式下 `(1-1.4)*30 → clamp 0` 完全免罚。
  // 即「CV 高」既可能是人味也可能是破碎，判别力接近零，且方向反了。
  // 结论：删除该项，把判别力交还给 avgLen / 套话 / 病词 / 句式损伤。
  //
  // 保留一个**弱**的节奏信号：AI 文本的句长标准差实测集中在 8.7~8.8（人写
  // 6.96~7.67），但样本量小、差距窄，只给 ≤8 分的辅助权重，不做主判据。
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // v0.9.7：加权公式。注意 structure **已经是分值**，这里不再乘系数。
  // （重构原因见上方 3) 段的说明：旧的"次数 + 统一系数"设计在加入 3e 后顾此失彼。）
  // ---------------------------------------------------------------------------
  let ai = Math.min(60, hits * 6);
  ai += Math.min(45, broken * 12); // 病词是硬伤（上限 45）
  ai += Math.min(60, typoCount * 30); // 错别字（语义级错误，单处即 30 分）
  ai += Math.min(70, structure); // 句式/污染损伤（已是分值，直接累加，上限 70）
  // 长且均匀：AI 骨架的主要残留信号。25 字起步，65 字以上拿满 25 分。
  ai += Math.max(0, Math.min(1, (avgLen - 25) / 40)) * 25;
  // 句长标准差落入 AI 集中带（实测 8.0~10.5 是 AI 高发区，人写偏小）——弱信号 ≤8 分
  if (lenStd >= 8.0 && lenStd <= 10.5) ai += 8;

  return {
    score: Math.round(Math.max(0, Math.min(100, ai))),
    formulaicHits: hits,
    sentenceCount: n,
    burstiness: Number(burstiness.toFixed(2)),
    avgLen: Number(avgLen.toFixed(1)),
    brokenHits: broken,
    structureHits: structure,
  };
}

/* ----------------------------- 指纹体检 ----------------------------- */

export interface FingerprintIssue {
  name: string;
  count: number;
  hint: string;
}
export interface FingerprintReport {
  pass: boolean;
  issues: FingerprintIssue[];
  sentenceCV: number;
  /** 句长标准差（朱雀官方口径参考：AI 文本常落在 5~8 区间） */
  sentenceStd?: number;
}

/** 对任意文本做确定性指纹自检：把内部回归套件变成用户功能。
 *  送检朱雀前先跑一遍，红项就是会被抓的把柄。 */
export function fingerprintCheck(text: string): FingerprintReport {
  const issues: FingerprintIssue[] = [];
  // 1) 中英数字间空格
  const spaceHits =
    (text.match(/[\u4e00-\u9fa5，。；：、][ \t]+[A-Za-z0-9]/g) || []).length +
    (text.match(/[A-Za-z0-9%）)\]][ \t]+[\u4e00-\u9fa5]/g) || []).length;
  if (spaceHits > 0) {
    issues.push({
      name: "中英数字间空格",
      count: spaceHits,
      hint: 'AI 训练语料爱留空格（"共 100 次"），人打字不留',
    });
  }
  // 2) 垫词复读
  for (const w of PAD_WORDS) {
    const c = text.split(w + "，").length - 1;
    if (c > 1) {
      issues.push({ name: `垫词复读「${w}」`, count: c, hint: "同一口头禅出现多次，机器复读特征" });
    }
  }
  // 3) 破折号/省略号超标
  const dash = text.split("——").length - 1;
  if (dash > 1) issues.push({ name: "破折号超标", count: dash, hint: "整篇最多 1 个，AI 爱滥用" });
  const ell = text.split("……").length - 1;
  if (ell > 1) issues.push({ name: "省略号超标", count: ell, hint: "整篇最多 1 个" });
  // 4) 段首过渡词残留
  const transRe =
    /(?:^|[。！？!?\n]\s*)(然而|因此|此外|与此同时|综上所述|总而言之|值得注意的是)[，,]?/g;
  const trans = (text.match(transRe) || []).length;
  if (trans > 0) {
    issues.push({
      name: "段首过渡词残留",
      count: trans,
      hint: "然而/因此/综上所述等，AI 骨架特征，直删或口语化",
    });
  }
  // 5) AI 套话（v0.8：合并 FORMULAIC + FORMULAIC_EXTRA）
  let formulaic = 0;
  const ALL_FORMULAIC_FP = Array.from(new Set([...FORMULAIC, ...FORMULAIC_EXTRA]));
  for (const p of ALL_FORMULAIC_FP) if (text.includes(p)) formulaic++;
  const FP_EXTRA_HARD = [
    "展望未来",
    "面向未来",
    "按下了快进键",
    "迈上了新的台阶",
    "交出了一份满意的答卷",
    "具有里程碑意义",
    // v0.8.5: 关键在于/核心在于/本质在于/根本在于 已是 VOCAB 源词（概率式替换），
    // 列入硬签名会导致"概率跳过替换"与"探针零残留"自相矛盾——移除，计分走 FORMULAIC
  ];
  for (const w of FP_EXTRA_HARD) {
    if (text.includes(w) && !ALL_FORMULAIC_FP.includes(w)) formulaic++;
  }
  if (formulaic > 0) {
    issues.push({
      name: "AI 套话残留",
      count: formulaic,
      hint: "值得注意的是/毋庸置疑 这类词是检测器一票抓的特征",
    });
  }
  // 6) 节奏过平（突发性双通道：CV 相对判据 + 句长标准差绝对判据，后者为朱雀官方口径）
  const stats = sentenceStats(text);
  const cv = Number(stats.cv.toFixed(2));
  const std = Number(stats.std.toFixed(1));
  if (stats.count >= 4 && cv < MIN_BURSTINESS_CV) {
    issues.push({
      name: "句长节奏过平",
      count: 1,
      hint: `句长变异系数 ${cv}（建议 >0.45），AI 句子长度均匀`,
    });
  }
  if (stats.count >= 6 && std >= 4.5 && std <= 8.5) {
    issues.push({
      name: "句长标准差落入 AI 特征带",
      count: 1,
      hint: `句长标准差 ${std}（实测 AI 文本多在 5~8 区间），长短句交错可拉开`,
    });
  }
  // 7) 半角逗号过多（反向检查：过度混入也是新指纹）
  // 阈值 15%：人类手打文本偶尔有 5-15% 半角逗号（输入法切换失误），
  // 注入层控制在 ≤5%，15% 足够安全且不误报短文本
  const halfC = (text.match(/,/g) || []).length;
  const fullC = (text.match(/，/g) || []).length;
  if (halfC > 0 && fullC + halfC > 0 && halfC / (fullC + halfC) > 0.15) {
    issues.push({
      name: "半角逗号过多",
      count: halfC,
      hint: "模拟手滑要克制，超过 15% 反而是新指纹",
    });
  }
  return { pass: issues.length === 0, issues, sentenceCV: cv, sentenceStd: std };
}

/* ------------------- 第 8 项：困惑度特征判定（评分由宿主层注入） ------------------- */
// 朱雀官方点名的困惑度指标，本地用 ONNX MLM 伪困惑度近似（Salazar 打分法）。
// 阈值来自 scripts/ppl-calibrate.ts 本地标定：分组掩码 K=5 下人工组 meanNll∈[0.98,1.35]、
// AI 组∈[0.18,0.42]，完全线性可分，取间隔中点 0.70。随朱雀回传数据迭代（见
// docs/fingerprint-and-zhuque-calibration.md §5）。本函数是纯函数，不感知模型与宿主的存在。

/** 全文平均 NLL 低于此值报「困惑度异常低」（单位 nat；标定间隔中点，见 §5） */
export const PPL_MIN_MEAN_NLL = 0.7;
/** 窗间 NLL 样本标准差低于此值报「困惑度曲线过平」（标定两组 max 均 ≈0.10） */
export const PPL_MAX_WIN_STD = 0.12;
/** 参与打分字数下限：短文的困惑度不可靠，不判定 */
export const PPL_MIN_CHARS = 60;
/** 平坦通道最少窗口数：窗口太少谈不了"起伏" */
export const PPL_MIN_WINDOWS = 3;

export function pplIssues(feature: PplFeature): FingerprintIssue[] {
  const issues: FingerprintIssue[] = [];
  if (feature.scoredChars < PPL_MIN_CHARS) return issues;
  if (feature.meanNll < PPL_MIN_MEAN_NLL) {
    issues.push({
      name: "困惑度异常低",
      count: 1,
      hint: `字均NLL ${feature.meanNll.toFixed(2)} nat（<${PPL_MIN_MEAN_NLL}）：对语言模型过于可预测，AI 生成特征`,
    });
  }
  if (feature.windows.length >= PPL_MIN_WINDOWS && feature.winStd < PPL_MAX_WIN_STD) {
    issues.push({
      name: "困惑度曲线过平",
      count: 1,
      hint: `窗间NLL标准差 ${feature.winStd.toFixed(2)}（<${PPL_MAX_WIN_STD}）：全文置信度缺乏起伏，生成式特征`,
    });
  }
  return issues;
}

/* ----------------------------- 本地忠实度校验 ----------------------------- */

export interface FidelityReport {
  pass: boolean;
  /** 数字/英文专名的增删改明细 */
  problems: string[];
}

/** 本地零成本忠实度校验：比对原文与改写稿的数字、英文专名集合。
 *  LLM 质检会漏看、会挂（限流/空回复），但"23% 变 32%""AI 变人工智能导致术语丢失"
 *  这类最危险的偏义，用确定性抽取比对一抓一个准。 */
export function checkFidelityLocal(original: string, rewritten: string): FidelityReport {
  const problems: string[] = [];
  const nums = (t: string) => t.match(/\d+(?:\.\d+)?/g) || [];
  const a = nums(original),
    b = nums(rewritten);
  const count = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
    return m;
  };
  const ca = count(a),
    cb = count(b);
  for (const [num, n] of ca) {
    const m = cb.get(num) || 0;
    if (m < n) problems.push(`数字 ${num} 出现次数减少（${n}→${m}）`);
  }
  for (const [num, n] of cb) {
    const m = ca.get(num) || 0;
    if (n > m && !ca.has(num)) problems.push(`改写新增了原文没有的数字 ${num}`);
  }
  // 英文专名/术语：纯字母+连字符，不含数字——否则 "GDP42%" 会被提取为 "GDP42"
  // 导致与原文 "GDP" 集合比对失败误报"丢失"。数字由上面的 nums() 单独提取。
  const en = (t: string) =>
    new Set((t.match(/[A-Za-z][A-Za-z-]*/g) || []).map((w) => w.toUpperCase()));
  const ea = en(original),
    eb = en(rewritten);
  for (const w of ea) {
    if (!eb.has(w)) problems.push(`英文术语 ${w} 在改写中丢失`);
  }
  return { pass: problems.length === 0, problems: problems.slice(0, 8) };
}

/** 塌句常被垫词补成"人工智能技术吧。"，比对前先剥掉尾部语气词 */
const COLLAPSE_TAIL_PARTICLES = /[吧呢啊嘛呀哦哈呗咯嗯]+$/;
const CLAUSE_SPLIT_RE = /[，、；;：:。！？!?\n]+/;

/**
 * 语法塌缩检测（与原文做差分）：改写稿里凡是"原文某小句的严格前缀、且尾巴被砍掉 ≥2 字"
 * 的短小句，就是谓语被删光后剩下的光杆主语（"人工智能技术展望未来。"→"人工智能技术。"）。
 *
 * 用差分而不是动词表：中文没有可靠的光杆谓语判据，靠词表要么漏（含"在/被"就放行，
 * 实测"这种技术在医疗诊断"正是这么滑过去的），要么误杀"脑子木。"这类正常短句。
 * 而"逐字前缀 + 尾部被截"只有删减型破坏才会产生——正常改写会换词，不会原样保留前缀
 * 再砍掉尾巴。
 *
 * 这条检查存在的原因：aiScore 对塌句给 0 分，等于奖励删除；不补一票否决，
 * 择优会稳定挑出删得最狠的那一稿。
 */
export function collapseIssues(original: string, rewritten: string): string[] {
  // 两侧必须用同一套分隔符切句，否则切分口径不一致会整批误报（全角冒号就是这么漏的）
  const srcClauses = original.split(CLAUSE_SPLIT_RE).map((s) => s.trim()).filter((s) => s.length >= 4);
  const outClauses = rewritten.split(CLAUSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (!srcClauses.length) return [];
  const outSet = new Set(outClauses);
  const issues: string[] = [];
  for (const raw of outClauses) {
    const frag = raw.replace(COLLAPSE_TAIL_PARTICLES, "");
    if (frag.length < 4 || frag.length > 16) continue;
    // 只有"被截的那个原文小句在输出里也消失了"才算塌缩——否则它只是另一句的普通前缀
    //（"字字字…"这类嵌套前缀、或两句共享词头时都会整批误报）
    const victim = srcClauses.find(
      (s) => s.length - frag.length >= 2 && s.startsWith(frag) && !outSet.has(s),
    );
    if (victim) issues.push(`「${frag}」是原文「${victim.slice(0, 24)}」被截断后的残留，谓语已丢失`);
  }
  return issues;
}

// splitSentences 在此保留引用以维持导出面（部分调用方可能直接用它做切句校验）
export { splitSentences };
