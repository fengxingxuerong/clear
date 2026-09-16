/**
 * 趣AI味 · 困惑度评分内核（纯函数，零第三方依赖）
 *
 * 职责：把"逐 token NLL 数组"聚合成文本级困惑度特征。
 * 模型加载与推理在宿主层（Electron 主进程 / Web Worker），本文件只做数学，
 * 因此可以在 vitest 里用 stub NLL 直接测试，不碰 ONNX。
 *
 * 打分方法：MLM 伪困惑度（Salazar et al. 2019 的逐位置掩码打分法），
 * 与朱雀官方点名的困惑度指标同一原理的本地近似。
 */

/** 单个滑窗内的打分明细 */
export interface PplWindow {
  /** 本窗覆盖的字符区间 [start, end)（原文坐标） */
  charStart: number;
  charEnd: number;
  /** 参与打分的字数 */
  scoredCount: number;
  /** 本窗平均 NLL（nat） */
  meanNll: number;
}

/** 文本级困惑度特征（喂给 metrics 层 pplIssues 判定） */
export interface PplFeature {
  /** 全文平均 NLL（nat），仅统计参与打分的字 */
  meanNll: number;
  /** 各窗平均 NLL 的样本标准差（生成式"全程高置信"时趋于 0） */
  winStd: number;
  /** 参与打分的总字数 */
  scoredChars: number;
  windows: PplWindow[];
}

/** 滑窗参数：中文 bert-base-chinese 上限 512 token，留出 [CLS]/[SEP]/[MASK] 余量取 384 */
export const WIN_TOKENS = 384;
/** 相邻窗口重叠 token 数：保证跨窗词不被切断漏判 */
export const STRIDE_TOKENS = 320;

/**
 * 把原文按字符切成模型窗口序列。
 * 规则：先剔除空白字符（空白不打分、不计入窗口长度），按 token 容量切窗并回填原文坐标。
 * 纯确定性，无随机。
 */
export function planWindows(
  text: string,
  winTokens = WIN_TOKENS,
  stride = STRIDE_TOKENS,
): Array<{ chars: string[]; offsets: Array<[number, number]> }> {
  const chars: string[] = [];
  const offsets: Array<[number, number]> = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    chars.push(text[i]);
    offsets.push([i, i + 1]);
  }
  const out: Array<{ chars: string[]; offsets: Array<[number, number]> }> = [];
  let start = 0;
  while (start < chars.length) {
    const end = Math.min(start + winTokens, chars.length);
    out.push({ chars: chars.slice(start, end), offsets: offsets.slice(start, end) });
    if (end >= chars.length) break;
    start += Math.max(1, stride);
  }
  return out;
}

/**
 * 聚合一个窗口的逐位置 NLL 为窗口均值。
 * masked[i] === false 的位置不参与统计（如标点的可选掩码）。
 * 返回 null 表示本窗无可打分位置（调用方应丢弃该窗）。
 */
export function aggregateWindow(nlls: number[], masked: boolean[]): number | null {
  if (nlls.length !== masked.length) {
    throw new Error(`NLL 与掩码长度不一致：${nlls.length} vs ${masked.length}`);
  }
  let sum = 0;
  let n = 0;
  for (let i = 0; i < nlls.length; i++) {
    if (!Number.isFinite(nlls[i])) continue;
    if (masked.length > 0 && !masked[i]) continue;
    sum += nlls[i];
    n++;
  }
  return n === 0 ? null : sum / n;
}

/** 样本标准差；n<2 时返回 0（单窗无法谈起伏，视为不触发平坦通道） */
function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/**
 * 把全部窗口聚合为文本级特征。
 * 输入为各窗的 { 区间, 平均NLL }（宿主层已用 aggregateWindow 过滤空窗）。
 * meanNll 采用按字数加权（长窗权重高），winStd 为窗口间的简单样本标准差。
 */
export function aggregateText(windows: PplWindow[]): PplFeature {
  const valid = windows.filter((w) => w.scoredCount > 0 && Number.isFinite(w.meanNll));
  if (valid.length === 0) {
    return { meanNll: 0, winStd: 0, scoredChars: 0, windows: [] };
  }
  const totalChars = valid.reduce((a, w) => a + w.scoredCount, 0);
  const meanNll = valid.reduce((a, w) => a + w.meanNll * w.scoredCount, 0) / totalChars;
  return {
    meanNll,
    winStd: sampleStd(valid.map((w) => w.meanNll)),
    scoredChars: totalChars,
    windows: valid,
  };
}

/** 一个待打分 token：在输入序列中的下标与其原词 id（MLM 打分只需这两样，无需字符坐标） */
export interface ScoredToken {
  pos: number;
  origId: number;
}

/**
 * 分组掩码数：把窗内打分目标分成 K 组轮流掩码（组内掩、组外保留原文）。
 * 「全部同时掩码」会让每个位置近乎看不到上下文，NLL 被压到词表熵上限附近，
 * 抹平人机差异；逐位掩码成本又太高。K=5 是质量-成本折中（实测标定后可调）。
 */
export const MASK_GROUPS = 5;

/**
 * 把打分目标按序轮转分成 groups 组（确定性，无随机）。
 * 相邻 token 落入不同组，使每个被掩位置尽可能多的邻居保留原文上下文。
 */
export function maskGroups<T>(items: T[], groups: number): T[][] {
  const n = Math.max(1, Math.floor(groups));
  const out: T[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < items.length; i++) out[i % n].push(items[i]);
  return out;
}

/**
 * bert-base-chinese 特殊 token id（官方 WordPiece 词表固定值，已实测核对）：
 * [PAD]=0、[UNK]=100、[CLS]=101、[SEP]=102、[MASK]=103
 */
export const SPECIAL_TOKEN_IDS = { pad: 0, unk: 100, cls: 101, sep: 102, mask: 103 } as const;

/**
 * 从分词序列挑出打分目标：全部非特殊、非 UNK 的位置。
 *
 * 为什么免对齐：transformers.js v4 不返回 offset_mapping、也不暴露词表，
 * 但 MLM 打分本来只需要「位置 + 原词 id」，两者都在 ids 里——无需字符对齐。
 * 标点也参与打分（更贴近生成式困惑度的口径）；UNK 跳过（原词未知，掩码打分无意义）。
 * Web Worker 与测试共用本实现；Electron 主进程持有一份镜像副本，改动必须同步。
 */
export function selectTargets(ids: number[]): ScoredToken[] {
  const skip = new Set<number>(Object.values(SPECIAL_TOKEN_IDS));
  const targets: ScoredToken[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (skip.has(ids[i])) continue;
    targets.push({ pos: i, origId: ids[i] });
  }
  return targets;
}

/**
 * 把 transformers.js 的张量/嵌套数组归一成 number[]。
 *
 * 三种实际遇到的形状：
 *  · Tensor 对象：有 tolist()，但返回嵌套数组（[[]] 或 [[[]]]），需展平
 *  · Tensor 对象降级：只有 .data（TypedArray）
 *  · 纯嵌套数组（测试桩/旧版本）
 * 归一失败一律返回 null 让调用方抛错——静默拿到空数组会让 PPL 层算出 0 分，
 * 比直接报错危险得多（分数会假性变好）。
 */
export function toNumberList(x: unknown): number[] | null {
  if (x == null) return null;
  const obj = x as { tolist?: () => unknown; data?: ArrayLike<number> };
  if (typeof obj.tolist === "function") {
    const v = obj.tolist();
    return Array.isArray(v)
      ? (v.flat(Number.POSITIVE_INFINITY) as unknown[]).map(Number)
      : null;
  }
  if (obj.data != null) return Array.from(obj.data, (n) => Number(n));
  return Array.isArray(x)
    ? ((x as unknown[]).flat(Number.POSITIVE_INFINITY) as unknown[]).map(Number)
    : null;
}

/**
 * 从整段 logits（长度 seqLen*vocabSize 的扁平数组）按目标位计算
 * log softmax 后取原词分量的均值负对数似然（nat）。数值稳定实现。
 */
export function maskedMeanNll(
  data: ArrayLike<number>,
  seqLen: number,
  vocabSize: number,
  targets: ScoredToken[],
): number {
  if (targets.length === 0) return NaN;
  void seqLen;
  let sum = 0;
  for (const tg of targets) {
    const base = tg.pos * vocabSize;
    let max = -Infinity;
    for (let v = 0; v < vocabSize; v++) {
      const x = data[base + v];
      if (x > max) max = x;
    }
    let sumExp = 0;
    for (let v = 0; v < vocabSize; v++) sumExp += Math.exp(data[base + v] - max);
    sum += data[base + tg.origId] - (max + Math.log(sumExp));
  }
  return -sum / targets.length;
}

/** nat → perplexity（仅供展示与文档口径换算，判定一律用 NLL） */
export function nllToPerplexity(nll: number): number {
  return Math.exp(nll);
}
