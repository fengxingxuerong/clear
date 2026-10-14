/**
 * 趣AI味 · 共享引擎原语：mulberry32 可复现随机源、句长统计、劈句点查找。
 * 核心替换 / 机械扰动 / 评分三方共用，全部纯函数、零副作用。
 */
import { fragmentCanStand } from "./humanize-vocab";
import { splitSentences } from "./humanize-text";

/* ----------------------------- 共享引擎原语 ----------------------------- */
// 由 humanize.ts（核心替换）、humanize-metrics.ts（评分/指纹）、humanize-shuffle.ts（机械扰动）
// 三方共用，故下沉到此层，避免模块间循环依赖。全部纯函数、零副作用。

/** 文风预设：控制朱雀增强特征的开关门控 */
export type RewriteStyle = "casual" | "plain" | "academic";

/** 去味参数：核心替换、机械扰动与评分共用 */
export interface HumanizeOptions {
  /** 去味强度 0~1，越大改得越狠（默认 0.6） */
  intensity?: number;
  /** 随机种子，固定后结果可复现 */
  seed?: number;
  /** 朱雀增强模式：开启后激活额外对抗特征（方言、插入语、句式片段、主观意见、标点不规整等），
   *  针对 AI 文本检测器（朱雀/知网等）的统计特征做定向干扰。强度 ≥0.5 时自动启用。 */
  zhuqueMode?: boolean;
  /** 文风预设：casual=自然口语（朱雀特征全开）/ plain=平实书面（禁方言/网络梗，保留结构操作）
   *  / academic=学术体（禁方言/网络梗/主观意见，保留结构操作）。 */
  style?: RewriteStyle;
  /**
   * v3 P7 引擎级体裁联动：
   *  · main/narrative/dialogue：引擎自动/显式识别后，对应调 avgLen/burst 阈值、P3 结构门控强度
   *  · humanHand：纯人写原稿，强制强度 ≤0.48、关闭朱雀增强、跳过自问自答/错别字等（负斜率，越去味越升官%）
   *  · undefined（默认）：由 classifyGenre(text) 自动在 main/narrative/dialogue 三选内判定
   */
  genre?: "main" | "narrative" | "dialogue" | "humanHand";
  /**
   * v0.8.9 P0：是否强制剥离中英/中数之间的空格（默认 false = 尊重原文排版）。
   *
   * 背景：无条件剥离会毁掉技术文档的可读性——
   *   「从 Webpack 迁移到 Vite」→「从Webpack迁移到Vite」、「手动 scp」→「手动scp」，
   *   连 optimizeDeps.include 这类标识符都变得难辨认。
   * 而空格是排版习惯，不是可靠的 AI 语义特征：真人写技术博客同样会加空格。
   *
   * 默认 false：成规模的中英空格排版（≥3 处）视为技术/正式文档，原样保留；
   *             零散一两处仍照旧剥离，保留零散场景的降分收益。
   * 传 true：恢复 v0.8.8 及之前的无条件剥离行为（回归探针用，见 scripts/scan-bugs.ts）。
   */
  stripCJKSpaces?: boolean;
}

/**
 * 句长变异系数最低阈值（节奏兜底与指纹体检共用）。
 * v0.9.1：0.45→0.40。0.45 是旧极短语气锚引擎时代标定的，v0.9.8 废除极短锚后
 * 引擎实际稳定做到 CV≈0.35~0.45（少语气词 vs 低 CV 的设计权衡）。朱雀官方口径
 * 的绝对判据（std∈[4.5,8.5]=AI特征带）已在 fingerprintCheck 独立检查，
 * CV 检查是补充判据——0.40 反映新引擎真实能力，仍能抓到 std<4.5 且 CV<0.40 的
 * 真正均匀文本。
 */
export const MIN_BURSTINESS_CV = 0.4;

/* =========================================================
   v0.9.4 P2 跨轮垫词饱和守卫
   ========================================================= */
/**
 * 口语插话/碎片句头共享表：shuffle 碎片、朱雀模板、方言替换产物的并集。
 * 背景：实测把去味输出再次喂回引擎（串联迭代），垫词 12→22→28→35 线性堆积、
 * 字数注水 +89% 而自检分横盘——三个注入点各自只管"本轮限额"，对输入里
 * 已有的垫词无记忆。守卫口径：文本已有垫词达到上限后，本轮不再注入新的。
 * （只关注入、不禁减法：套话清除/指纹清理等 pass 在饱和文本上照常工作。）
 */
export const PAD_HEADS: string[] = [
  "就这样",
  "你懂的",
  "说白了",
  "差不多得了",
  "哦对",
  "行吧",
  "有一说一",
  "要我说",
  "说起来",
  "据我观察",
  "客观讲",
  "客观来讲",
  "老实讲",
  "话又说回来",
  "话又侃回来",
  "不瞒你说",
  "不吹不黑",
  "讲道理",
  "真的假的",
  "插一句",
  "这有什么要紧的",
  "要紧的在后头",
  "为啥这么说",
  "细想一下还真不是",
  "就这么回事",
  "侃真的",
  "往实了说",
  "往好听了说",
];

/** 单篇垫词注入上限：已有命中 ≥ 此值时跳过所有注入类 pass（实测单次正常去味
 *  的输出垫词数约 10~14 个，取 10 保证"第二次处理"即触发守卫，堵死堆积）。 */
export const PAD_INJECT_CAP = 10;

/** 统计文本中垫词句头出现次数（饱和度估计口径，允许少量跨界误配） */
export function countPadHeads(text: string): number {
  let n = 0;
  for (const p of PAD_HEADS) {
    let i = 0;
    while ((i = text.indexOf(p, i)) !== -1) {
      n++;
      i += p.length;
    }
  }
  return n;
}

/** mulberry32 伪随机源：零依赖、可复现（seed 固定则序列固定） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 可复现随机源：seed 缺省时按当前时间取种；offset 用于同一流程内互不干扰的多个随机流 */
export function makeRng(seed?: number, offset = 0): () => number {
  return mulberry32((seed ?? Date.now() & 0xffffffff) + offset);
}

export interface SentenceStats {
  count: number;
  lens: number[];
  avg: number;
  std: number;
  cv: number;
}

export function computeStats(lens: number[]): { avg: number; std: number; cv: number } {
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const std = lens.length
    ? Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length)
    : 0;
  return { avg, std, cv: avg > 0 ? std / avg : 0 };
}

/** 句长统计：句子数、句长数组、均值、标准差、变异系数（CV 越大节奏越跳脱）。
 *  评分 / 指纹体检 / 节奏兜底共用，避免多处重复实现。 */
export function sentenceStats(text: string): SentenceStats {
  const sentences = splitSentences(text);
  const lens = sentences.map((s) => s.replace(/[。！？!?；;\n]/g, "").length);
  const { avg, std, cv } = computeStats(lens);
  return { count: lens.length, lens, avg, std, cv };
}

/** 在句中找可安全劈开的位置：30%~70% 区间内的逗号，且后半句能独立成句（fragmentCanStand）。
 *  括号内的逗号不作为切点（v0.8.6 括号守卫：防止「（如中芯国际）」被拆成残段）。
 *  minLen 为最短句长门槛；找不到返回 -1。 */
export function findSplitPoint(s: string, minLen: number): number {
  if (s.length < minLen) return -1;
  // 括号深度表：切点 depth>0 一律否决
  const depth = new Array<number>(s.length).fill(0);
  {
    let d = 0;
    for (let k = 0; k < s.length; k++) {
      if ("（（《【「".includes(s[k])) d++;
      depth[k] = d;
      if ("））》】」".includes(s[k])) d = Math.max(0, d - 1);
    }
  }
  const commas: number[] = [];
  let ci = s.indexOf("，");
  while (ci !== -1) {
    if (depth[ci] === 0) commas.push(ci);
    ci = s.indexOf("，", ci + 1);
  }
  const mid = commas.find(
    (c) => c > s.length * 0.3 && c < s.length * 0.7 && fragmentFrontCanStand(s.slice(0, c).trim()),
  );
  if (mid === undefined) return -1;
  if (!fragmentCanStand(s.slice(mid + 1).trim())) return -1;
  return mid;
}

/** v0.9 专家修复 P2/P3 配套：在 s 中找离 preferPos 最近、且前后半句均能独立成句的
 *  「，；：」切点。括号内不切、顿号并列不切、状语/名词残片/光杆谓语均否决。无则 -1。 */
export function findGuardedCutNear(s: string, preferPos: number): number {
  if (!s) return -1;
  const depth = new Array<number>(s.length).fill(0);
  {
    let d = 0;
    for (let k = 0; k < s.length; k++) {
      if ("（（《【「".includes(s[k])) d++;
      depth[k] = d;
      if ("））》】」".includes(s[k])) d = Math.max(0, d - 1);
    }
  }
  const cuts: number[] = [];
  for (let k = 0; k < s.length - 1; k++) {
    if ("，；：".includes(s[k]) && depth[k] === 0) cuts.push(k);
  }
  if (cuts.length === 0) return -1;
  cuts.sort((a, b) => Math.abs(a - preferPos) - Math.abs(b - preferPos));
  return (
    cuts.find(
      (k) =>
        fragmentFrontCanStand(s.slice(0, k).trim()) &&
        fragmentCanStand(
          s
            .slice(k + 1)
            .replace(/[。！？!?…]$/, "")
            .trim(),
        ),
    ) ?? -1
  );
}

/**
 * v0.9.36：从属连词开头的小句——切点落在其后必然产生悬空从句残句
 * （「如果你也在为选台灯发愁。」「虽然天气很冷。」）。
 *
 * 实证（2026-10-13，扩 v8.0 语料池时人眼审查抓到）：原有守卫覆盖了「随着/在/根据…」
 * 状语头（ADVERBIAL_HEAD_RE），却没覆盖**从属连词**——「如果你也在为选台灯发愁，
 * 不妨试试这一款」被切成「如果你也在为选台灯发愁。不妨试试这一款」，全种子复现。
 *
 * ⚠️ 只在**从句未闭合**（front 内无逗号）时否决：一旦出现逗号，说明「从句, 主句」
 *   都已就位（「如果 A，B」的 front 含逗号时是完整复合句），切出来合法、不拦。
 */
export const SUBORDINATE_LEAD_RE =
  // v0.9.40：补 **目的连词**（以便/从而/以免/以防/借此）。原表只有「为了」，
  // 而「以便做到快速回滚。」这类目的从句残句在新语料上实测 44/60 命中——
  // 成因与「为了」完全同源（连词引导的成分不能独立成句），只是当时没走到这条分支上。
  /^(?:如果|假如|假设|倘若|若是|要是|一旦|只要|只有|即使|即便|哪怕|虽然|尽管|固然|因为|由于|鉴于|为了|无论|不管|不论|除非|与其|以便|从而|以免|以防|借此)/;

/**
 * v0.9.36：传信/引述结构收尾——句尾落在「了解到/获悉/表示/指出」这类引述动词上，
 * 说明引述的内容（宾语）还没出现，切点落在其后必然残句
 * （「记者从相关部门了解到。」「有关负责人表示。」）。
 *
 * 实证：同批 news 语料——「记者从相关部门了解到，我市近期将启动…」被切成
 * 「记者从相关部门了解到。我市近期将启动…」，全种子复现。
 *
 * 否定式放行（「我不这么认为。」「他没表示。」是自足的"表态"义，完整句）：
 * 双 lookbehind 排除「否定词 + 0~2 字 + 尾词」形态（`不这么认为`/`没明确表示`）。
 * ⚠️ 本条与 scan-bugs v8.0 探针「引述结构残句」共用（探针在 source 末尾接 `。`），
 *   判据天然对齐：守卫拦掉的 = 探针抓的。
 */
export const REPORTING_TAIL_RE =
  /(?<![不没别无非])(?<![不没别无非][\u4e00-\u9fa5]{2})(?:了解到|获悉|得知|表示|指出|强调|认为|说道|问道|答道|喊道|透露|坦言|发布消息|发布公告|发表声明|发文称|报道称|通报称)$/;

/**
 * v0.9.36：「X道」式引述标记（说道/问道/答道/喊道/笑道/叹道）。两类用法共用同一条正则：
 *  ① 守卫（humanize.ts 句尾软化）：其后不加句尾语气词——「说道吧。」「问道呢。」不通；
 *  ② scan-bugs v8.0 探针「引述动词+语气词」。
 * ⚠️ 不含单字「说」：「就听他说吧」是合法的祈使句，一刀切会误伤。
 */
export const REPORTING_DAO_RE = /[说道问答喊答应笑叹]道$/;

/**
 * v0.9.43：**及物动词收尾** → 切点落在其后必然产生「悬空及物动词」残句。
 *
 * 实证（2026-10-15 真实稿件测试，议论文 × 3 档 × 10 seed：**30/60 必现**）：
 *
 *     原文：我们也必须清醒地认识到，转型过程仍然面临数据孤岛、人才短缺等多重挑战。
 *     旧产出：我们也必须清醒地认识到。转型过程仍然面临数据孤岛、人才短缺等多重挑战。
 *
 * 前半句「…认识到」的宾语（整个从句）被留在后半句 ⇒ 及物动词悬空。
 *
 * 为什么既有守卫漏掉：`REPORTING_TAIL_RE` 收的是**引述**动词
 * （了解到/获悉/表示/指出/强调/认为…），「认识到/意识到/提出/包括/涉及/发现」
 * 不在这个语义类里，一条都没进表。
 *
 * ⚠️ 刻意**不收「要求」「建议」「明确」**——它们有高频名词用法
 *   （「满足要求，」「采纳建议，」），收进来会误伤正常切分（宁可少拦）。
 * ⚠️ `了?` 容差：「提出了，…」同样悬空，只锚定「提出」会漏。
 */
export const TRANSITIVE_TAIL_RE =
  /(?:认识到|意识到|认识到|提出|包括|涵盖|涉及|发现|显示|表明|证明|阐明|揭示|体现)了?$/;

/** v0.9 专家修复 P2（前半句守卫）：切点前半句若以「在/随着/当/根据/通过…下/中/时/后」
 *  收束，说明这是状语从句与主句的分界——句号化后前半句是无谓语残句
 *  （「在28纳米工艺节点下。」），这种切点必须否决。
 *  v0.9 长尾补充：名词残片守卫——前半句末段若是光杆名词短语（「工艺」「一颗采用3D
 *  堆叠封装的处理器」），句号化后同样是残句。 */
// v0.9.40：补**替换后的介词头**（用/靠/借/凭借/基于/依托/经过）。原表只有「通过」，
// 但引擎会先把「通过」替换成「用/靠」，再走切句——替换在前、守卫在后，
// 于是「通过合理配置构建与部署流程，可以有效提高交付质量」被切成
// 「用合理配置构建与部署流程。可以有效提高交付质量。」（新语料实测 18/60）。
// 守卫表若只认替换前的形态，等于给替换开了一道侧门。
//
// ⚠️ scan-bugs 的「介词结构残句」探针**独立抄了一份表**，刻意不引用本常量——
//   v0.9.40 实测：探针与守卫共用同一常量时，变异检验「回退守卫」会连探针一起回退，
//   直接失效（0 命中，看不出探针是否敏感）。两处改动需手工同步（探针在 scan-bugs.ts）。
const ADVERBIAL_HEAD_RE =
  /^(?:在|随着|当|于|对于|根据|通过|由|从|自|沿着|处于|用|靠|借|凭借|基于|依托|经过)/;
const ADVERBIAL_TAIL_RE = /[下中时后里间际]$/;
/** 谓语/体态标记：正常分句几乎必含其一（排除「的」——名词短语也常带「的」） */
const CLAUSE_PREDICATE_RE = /[了着过是将有可会为使应需已能得以更很都也还就便再又均亦尚加以]/;
/** 量词开头（同位语名词短语签名：「一颗…处理器」「这项…技术」） */
const QUANTIFIER_HEAD_RE = /^(?:一|两|三|四|五|几|某|该|这|那)?[颗个种项目条台套份位款只张批次家]/;
/**
 * 2026-09-30 C 类：「的 + 名词性中心语」收尾的名词短语（「采用智能化系统的企业」）。
 * 句号化即无谓语残句。中心语取签名（`scan-bugs.ts` v7.0「引导语命题被切开」）里
 * 已验证的名词性后缀白名单——与签名同表，保证"守卫判据 = 签名判据"，
 * 不会出现"守卫否掉的比签名抓的多/少"这种对不齐。
 */
const NP_TAIL_RE =
  /(?:的|之)[\u4e00-\u9fa5]{0,6}(?:人群|企业|群体|用户|学生|员工|机构|公司|团队|产品|项目|数量|比例|幅度|水平|速度|规模|情况|因素|问题|方式|机制|过程|结果|能力|需求|成本|效率|难度|标准|体系|模式|路径|目标|价值|意义|关系|结构|内容|形式|条件|环境|阶段|方面|领域|行业|市场|地区|学校|教师|客户|读者)$/;
/**
 * 上条配套的"真谓语"判据：**体标记 + 双字谓词**，一个单字都不收。
 *
 * 为什么连 CLAUSE_PREDICATE_RE 和"单字情态表"都不能用（两次实测踩坑，都写在这里防第三次）：
 *   ① CLAUSE_PREDICATE_RE 是单字符宽表，含「以」→「采**用**…」旁的「以」命中，
 *      名词短语被判成"有谓语"，守卫形同虚设（实测 119/119 不动）；
 *   ② 换成"单字情态窄表"（是|在|有|能|会|要…）仍不行——「智**能**化」含「能」、
 *      「机**会**」含「会」、「现**有**」含「有」，中文名词内部大量嵌这类单字。
 * ⇒ 判据必须是**不可能出现在名词内部**的形式：体标记（着/了/过）与双字谓词。
 *
 * 代价：单字谓词句（「这是最好的方式」的「是」）会被误判成无谓语 → 少切一次句。
 * 这个方向的错误是安全的：少切只损失一次去味机会，多切则产出病句残句。
 */
const NP_PREDICATE_RE =
  /[着了过]|正在|可以|应该|需要|能够|必须|得以|受到|加以|提升|提高|降低|减少|增加|推动|实现|促进|加强|优化|改善|完成|开展|进行|出现|存在|发生|改变|影响|形成|构成|成为|决定|带来|导致|依赖|适用|具备|具有|意味着|表明|显示|说明/;
export function fragmentFrontCanStand(front: string): boolean {
  if (!front) return false;
  // v0.9 长尾：「随着」引导的从句必须挂主句——切点落在其后必然产生
  // 悬空状语（「随着半导体制造工艺进入3纳米节点。」），一律否决
  if (/^随着/.test(front)) return false;
  // v0.9.36：从属连词开头且从句未闭合（front 内无标点）⇒ 悬空从句残句，否决
  if (SUBORDINATE_LEAD_RE.test(front) && !/[，、；：]/.test(front)) return false;
  // v0.9.36：引述动词收尾（引述内容缺失）⇒ 残句；否定式"表态"义由正则内 lookbehind 放行
  if (REPORTING_TAIL_RE.test(front)) return false;
  // v0.9.43：及物动词收尾（宾语被留在后半句）⇒ 悬空及物动词残句（见 TRANSITIVE_TAIL_RE）
  if (TRANSITIVE_TAIL_RE.test(front)) return false;
  if (ADVERBIAL_HEAD_RE.test(front) && ADVERBIAL_TAIL_RE.test(front)) return false;
  // 「…的同时」「…的时候」等复合状语尾
  if (/(?:的同时|的时候|的情形|的情况下|的基础上)$/.test(front)) return false;
  // 名词残片：末段过短且无谓语标记（「工艺」）；或量词开头的同位语短语且无谓语标记
  // 分隔符必须含冒号：「…入手：首先」按逗号切只得到 5 字 lastSeg「入手：首先」，
  // 长度门槛(≤4)量不到它，于是切点被放行、产出光杆句「…入手：首先。」
  // （实测 UI 论说样本 69/210 次 = 32.9%，强度 ≥0.5 起）。
  const lastSeg = front.split(/[，、；：:]/).pop() ?? front;
  if (lastSeg.length <= 4 && !CLAUSE_PREDICATE_RE.test(lastSeg)) return false;
  // v0.9.44：裸时间名词残句（第二轮真实案例测试，真实通稿 20/20 复现）：
  //   「本报讯 昨日上午，市轨道交通集团发布消息，…」被劈成
  //   「本报讯 昨日上午。」+「市轨道交通集团发布消息，…」——光杆时间名词不能独立成句。
  //   既有组合抓不住：ADVERBIAL_HEAD_RE 只收介词头（在/随着/当…），不收「昨日」这类
  //   裸时间名词；ADVERBIAL_TAIL_RE 的 [下中时后里间际] 不含「上午/凌晨」等。
  //   判据打在 lastSeg 的**结尾**：「本报讯 昨日上午」以「昨日上午」收束即拦；
  //   「去年冬天很冷」不以时间词收束，照常放行。
  if (
    /(?:^|\s)(?:昨日|今日|当天|当日|近日|日前|目前|当晚|本周|上周|下周|今年|去年|明年|凌晨|清晨|傍晚|深夜)(?:[上中下]午|左右|前后|以来|期间)?$/.test(
      lastSeg,
    )
  )
    return false;
  // 2026-09-30 C 类（见 docs/2026-09-30-sentence-defects-report.md §5.3 ②）：
  // 「…的+名词」结尾的**长**名词短语同样是残句——上面那条只管 ≤4 字的短残片，
  // 而「采用智能化系统的企业」有 10 字、全段无谓语标记，得以放行，
  // 于是被劈成「数据显示，采用智能化系统的企业。」+「其生产效率…」（实测 119/120 命中）。
  //
  // 只收"的+名词性中心语"这一形态（而非"任意无谓语长段"）：日常分句里
  // 无谓语的长段还有「通过数据分析」「在这样的背景下」等，那些已由上面的
  // 状语守卫与长度守卫覆盖；这里新增的判据刻意**只**对准签名所指的形态，
  // 以免把正常可切的分句一起否掉（每否决一次 = 白丢一次劈句机会）。
  // 注意：这里**不能**复用 CLAUSE_PREDICATE_RE。它是为"短残片"设计的单字符宽表，
  // 含「能/会/有/要/以…」这类单字——「智**能**化的企业」直接命中「能」，
  // 于是这个纯名词短语被判成"有谓语"（实测：守卫加了却 119/119 一动不动）。
  if (NP_TAIL_RE.test(lastSeg) && !NP_PREDICATE_RE.test(lastSeg)) return false;
  if (QUANTIFIER_HEAD_RE.test(lastSeg) && !CLAUSE_PREDICATE_RE.test(lastSeg)) return false;
  // v0.9 长尾：末段为悬空状语/时间名词短语（「说到底，在后摩尔时代」切点在时代后）
  // ——以介词/时间词开头且无任何谓语标记，句号化即无谓语残句
  if (ADVERBIAL_HEAD_RE.test(lastSeg) && !CLAUSE_PREDICATE_RE.test(lastSeg)) return false;
  if (
    /^(?:前|后)?摩?尔?时代|^(?:古|新|旧|大)?时代$|时期$|阶段$|节点$/.test(lastSeg) &&
    !CLAUSE_PREDICATE_RE.test(lastSeg)
  )
    return false;
  return true;
}
