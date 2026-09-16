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
export const MIN_BURSTINESS_CV = 0.40;

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

/** v0.9 专家修复 P2（前半句守卫）：切点前半句若以「在/随着/当/根据/通过…下/中/时/后」
 *  收束，说明这是状语从句与主句的分界——句号化后前半句是无谓语残句
 *  （「在28纳米工艺节点下。」），这种切点必须否决。
 *  v0.9 长尾补充：名词残片守卫——前半句末段若是光杆名词短语（「工艺」「一颗采用3D
 *  堆叠封装的处理器」），句号化后同样是残句。 */
const ADVERBIAL_HEAD_RE = /^(?:在|随着|当|于|对于|根据|通过|由|从|自|沿着|处于)/;
const ADVERBIAL_TAIL_RE = /[下中时后里间际]$/;
/** 谓语/体态标记：正常分句几乎必含其一（排除「的」——名词短语也常带「的」） */
const CLAUSE_PREDICATE_RE = /[了着过是将有可会为使应需已能得以更很都也还就便再又均亦尚加以]/;
/** 量词开头（同位语名词短语签名：「一颗…处理器」「这项…技术」） */
const QUANTIFIER_HEAD_RE = /^(?:一|两|三|四|五|几|某|该|这|那)?[颗个种项目条台套份位款只张批次家]/;
export function fragmentFrontCanStand(front: string): boolean {
  if (!front) return false;
  // v0.9 长尾：「随着」引导的从句必须挂主句——切点落在其后必然产生
  // 悬空状语（「随着半导体制造工艺进入3纳米节点。」），一律否决
  if (/^随着/.test(front)) return false;
  if (ADVERBIAL_HEAD_RE.test(front) && ADVERBIAL_TAIL_RE.test(front)) return false;
  // 「…的同时」「…的时候」等复合状语尾
  if (/(?:的同时|的时候|的情形|的情况下|的基础上)$/.test(front)) return false;
  // 名词残片：末段过短且无谓语标记（「工艺」）；或量词开头的同位语短语且无谓语标记
  const lastSeg = front.split(/[，、；]/).pop() ?? front;
  if (lastSeg.length <= 4 && !CLAUSE_PREDICATE_RE.test(lastSeg)) return false;
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
