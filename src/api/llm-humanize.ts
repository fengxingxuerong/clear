/**
 * 趣AI味 · LLM 去味流程：单轮改写 与 深度多轮闭环（质检+交叉评判+定向修订）
 */

import { ApiConfig, ADAPTIVE_CONTEST_CHARS, DEEP_MAX_ROUNDS, DEEP_TARGET_SCORE } from "./llm-config";
import {
  SYSTEM_PROMPT,
  pickExemplarBlock,
  buildRevisionPrompt,
  intensityDirective,
  personaDirective,
  styleDirective,
} from "./llm-prompts";
import { chat, resetApiCallCount, getApiCallCount } from "./llm-chat";
import { processCandidate, fabricationReview } from "./llm-quality";
import { restoreMixedSpacing } from "../engine/humanize-shuffle.ts";
import { fingerprintCheck } from "../engine/humanize.ts";
import { errMsg } from "./llm-judge";

/* ----------------------------- 去味 ----------------------------- */

/** v0.8.8 评判员宽严自适应：动态达标线 = max(绝对目标, 首轮分 × 此比例)。
 *  依据：2026-09-07 真实实测，glm-5.2 交叉评判对双模型竞争胜出稿仍打 86/91——
 *  绝对目标 10（按宽评评判员标定）在严评下永不达标，只能靠预算白烧收场。
 *  以首轮正分为宽严锚点后：严评（首轮 86）→ 目标 ≤31；宽评（首轮 45）→ ≤16；
 *  首轮已很低（≤28）→ 维持绝对目标不变。0.35 对两种宽严都落在
 *  "改写稿显著优于底稿"的语义带内，且不需要按模型硬编码宽严表。 */
const RELATIVE_TARGET_RATIO = 0.35;

/**
 * v0.9.13 首轮好区：评委分已落到这个值以内，就**不再进修订轮**。
 *
 * 依据（2026-09-19 四篇真送网关实测）：修订轮**没有一次拿到更优分**（0/2 收益）——
 *   s4 财报 首轮最优 15 → 修订稿 49   s1 议论文 首轮 89 → 修订稿 92
 * 两次修订都被"未优于当前最优"守卫拦住、没有接管交付（46 是 s4 竞争段第二候选，不是修订），
 * 所以这里的实测代价是
 * **白烧一整轮调用**，不是"把交付稿改坏"（措辞要准：唯一一次修订稿真被交出去的是 s2，
 * 那是另一码事——见 FabricationVetoError）。
 * 而 s4 的 15 分按旧公式算 `max(绝对目标 10, 15×0.35=5)` = 目标 10，一个已经好的稿子
 * 因此还要再走一轮注定不划算的修订。v0.8.8 的注释写着"首轮已很低（≤28）→ 维持绝对
 * 目标不变"，但这句话从未落到公式上，而且"维持绝对目标"本身就是继续往下追。
 *
 * 28 取自评判分与 aiScore 共用的"人写/机器"分界（见 humanize-metrics-calibration
 * 的分离区间 [27,30]）；这里只用作**收手**判据，不放宽任何绝对目标。
 * ⚠️ 但评委分本身跨日不可比（同模型同稿历史上判过 16/24/38，本日同样判 46），
 * 所以 28 是"落在人写带就收手"的保守点位，不是标定出来的阈值。
 */
const JUDGE_GOOD_BAND = 28;

/**
 * v0.9.14 编造否决：严格保真开启时，收稿终审发现"原文没有的事实性新增"即拒绝交付。
 *
 * 触发实测（2026-09-19 s2 种草文）：原文"重量仅为450克"被写成"**裸机**450克"、
 * "完全满足日常需求"被写成"**出门一天**够用"、原文无第一人称却出现"**我觉得**算省心"。
 * 当时复核抓到了，却只往 note 里写一句"请人工核对"，稿子照样交付——营销文里凭空多出的
 * 技术参数与时长断言是要发出去错的。
 *
 * 抛出后由上层（runHumanize）回退本地引擎并标 degrade：本地引擎只做换词/删套话，
 * 结构上不具备新增事实断言的能力，是这里唯一干净的兜底。
 * 注意：默认 strictFidelity=false，本否决只影响显式开启"严格保真"的用户。
 */
export class FabricationVetoError extends Error {
  readonly fabrications: string[];
  constructor(fabs: string[]) {
    super(
      `编造复核否决：交付稿有 ${fabs.length} 处原文没有的事实性新增（如「${(fabs[0] ?? "").slice(0, 28)}」），已拒绝交付`,
    );
    this.name = "FabricationVetoError";
    this.fabrications = fabs;
  }
}

/** 多候选并发的上限：与 Key 池容量（3）对齐。再高不增吞吐，只会加剧 429 反而更慢。 */
const CONTEST_MAX_PARALLEL = 3;

/**
 * 有界并发遍历：同时最多 limit 个任务在跑，任务自己负责把结果写到自己的下标位。
 * 刻意不返回"按完成顺序"的数组——聚合必须按输入下标，否则并发完成顺序会改变
 * qcPassed/roundScores 序列，同一输入两次跑出不同结果，可复现性就没了。
 */
async function mapLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    }),
  );
}

/** 组装改写用的 system 提示词（基础战术 + 按体裁选范例 + 文风预设 + 人味人格 + 强度档位） */
export function buildSystemPrompt(
  cfg: ApiConfig,
  intensity: number,
  sourceText?: string,
): string {
  return (
    SYSTEM_PROMPT +
    pickExemplarBlock(sourceText ?? "", cfg.style) +
    styleDirective(cfg.style) +
    personaDirective(cfg.persona) +
    intensityDirective(intensity)
  );
}

/** 单轮 LLM 去味 */
export async function humanizeViaApi(
  text: string,
  cfg: ApiConfig,
  intensity = 0.6,
): Promise<string> {
  const { content } = await chat(
    cfg,
    [
      { role: "system", content: buildSystemPrompt(cfg, intensity, text) },
      { role: "user", content: text },
    ],
    { temperature: cfg.temperature, maxTokens: 16000 },
  );
  // 空输出视为失败：让上层回退本地引擎，而不是把空串当去味结果
  if (!content) {
    throw new Error("模型返回空内容（思考型模型 token 预算耗尽，可重试或换非思考型模型）");
  }
  // v0.8.9：回填被 LLM 压掉的中英/中数空格（提示词管不住，改确定性后处理）
  return restoreMixedSpacing(text, content);
}

/**
 * v0.8.9 P0：空响应降级重试。
 *
 * 背景：深度闭环实测在第 2 轮拿到空 content 就直接 break——首轮明明改写成功，说明模型可用，
 * 空响应多为偶发（思考型模型 reasoning 吃光 max_tokens / 网关抖动 / 修订指令过长）。
 * 原实现不重试、不换模型，242s 后把「首轮 60 分、目标 21」的未达标稿静默交付。
 *
 * 降级链：默认参数 → token 预算翻倍 → 换备选模型，任一环节拿到非空内容即返回。
 * 已超调用预算时不再重试，避免把时间/额度烧在重试上。
 */
async function chatNonEmpty(
  cfg: ApiConfig,
  messages: { role: "system" | "user"; content: string }[],
  opts: { temperature: number; maxTokens: number; model?: string },
  altModel: string,
  isOverBudget: () => boolean,
): Promise<{ content: string; via: string }> {
  const attempts: { model?: string; maxTokens: number; label: string }[] = [
    { model: opts.model, maxTokens: opts.maxTokens, label: "" },
    { model: opts.model, maxTokens: Math.min(32000, opts.maxTokens * 2), label: "token 预算翻倍" },
  ];
  if (altModel && altModel !== opts.model) {
    attempts.push({ model: altModel, maxTokens: opts.maxTokens, label: `换模型 ${altModel}` });
  }
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0 && isOverBudget()) break;
    try {
      const r = await chat(cfg, messages, {
        temperature: opts.temperature,
        maxTokens: attempts[i].maxTokens,
        model: attempts[i].model,
      });
      if (r.content) return { content: r.content, via: attempts[i].label };
    } catch {
      // 单档失败交给下一档降级；全部失败由调用方按空内容处理
    }
  }
  return { content: "", via: "" };
}

/** v0.9.4 P2：去空白字符数之比（产出/原文），作为压缩率口径 */
function shrinkRatioOf(original: string, output: string): number {
  const chars = (s: string) => s.replace(/\s+/g, "").length;
  const o = chars(original);
  if (o <= 0) return 1;
  return +(chars(output) / o).toFixed(2);
}

export interface DeepResult {
  text: string;
  /** 每轮改写后的 LLM 评分（中位数），如 [45, 18, 7] */
  roundScores: number[];
  /** v0.8.8：本次闭环实际使用的达标分（评判锚点放宽后可能高于绝对目标） */
  targetUsed: number;
  /** 达标（≤target）提前收手时为 true */
  hitTarget: boolean;
  /** 中途收场原因（如第 N 轮限流），无则空串 */
  note: string;
  /** 各轮质检（通顺+忠实）结果 */
  qcPassed: boolean[];
  /** 最后一轮未修复的质检问题（展示用） */
  qcIssues: string[];
  /** v0.9.4 P2 压缩率：去空白后 产出字数 / 原文字数。LLM 改写系统性压缩 25~44%，
   *  UI/note 需要让用户知情（本地引擎是注水 +8~22%，两者方向相反）。 */
  shrinkRatio?: number;
}

/** 深度去味闭环：改写 →（机械扰动）→ 质检 → 交叉评判 → 未达标按痕迹定向修订，
 *  全程保留"质检通过且评分最低"版本。v0.5.1：配置 altModel 时首轮双模型竞争择优。 */
export async function humanizeViaApiDeep(
  text: string,
  cfg: ApiConfig,
  onProgress?: (round: number, score: number | null, stage?: string) => void,
  target = DEEP_TARGET_SCORE,
  maxRounds = DEEP_MAX_ROUNDS,
  intensity = 0.6,
  /** v0.8.6 分块场景：调用预算跨块共享。true 时不清零计数器，
   *  由调用方（llm.ts 分块循环）在整篇开始前 reset 一次，maxApiCalls 对整篇生效
   *  而非按块重置。单篇独立调用保持默认 false，行为不变。 */
  budgetShared = false,
): Promise<DeepResult> {
  const startTime = Date.now();
  // 用户设的最长等待时间（秒）：0 = 不限制
  const maxWaitSec = cfg.maxWaitSeconds || 0;
  // v0.8.5 调用预算（次）：0 = 不限制。轮间检查，轮内不中断。
  const maxCalls = cfg.maxApiCalls || 0;
  if (!budgetShared) resetApiCallCount(); // 闭环从零计数（历史调用不占本次预算）；分块共享预算时由外层统一 reset
  const isOverBudget = () =>
    (maxWaitSec > 0 && (Date.now() - startTime) / 1000 > maxWaitSec) ||
    (maxCalls > 0 && getApiCallCount() >= maxCalls);
  const budgetReason = () =>
    maxCalls > 0 && getApiCallCount() >= maxCalls
      ? `已达调用上限 ${maxCalls} 次（实际 ${getApiCallCount()} 次）`
      : `已达最长等待 ${maxWaitSec}s`;
  const roundScores: number[] = [];
  const qcPassed: boolean[] = [];
  let bestText = "";
  let bestScore = Infinity;
  let hitTarget = false;
  let lastCritique: string[] = [];
  /**
   * v0.9.13 质检状态按稿归属：原先是一个"随轮次滚动"的 qcIssues 变量，谁最后失败就
   * 显示谁的问题——实测 s3 交付的是过检稿，日志却报着被淘汰候选的两条"谓语丢失"，
   * 让人去核对一个交付稿里根本不存在的缺陷。改成 稿文本 → 该稿自己的质检清单，
   * 返回时只报真正交付那一稿的状态（过检稿也照记它的 issues，如"质检通道异常放行"）。
   */
  const qcIssuesByDraft = new Map<string, string[]>();
  let note = "";
  let writerModel: string | undefined; // 竞争胜者覆盖后续修订轮的改写模型
  // v0.8.8 评判锚点：以首个有效正分为宽严锚点（全程只锚一次，后续轮不再抬锚，
  // 避免"越改越宽"），有效目标 = max(绝对目标, 首轮分 × RELATIVE_TARGET_RATIO)
  let anchorScore: number | null = null;
  /** 首轮分是否已落在好区（决定还要不要开修订轮，见 JUDGE_GOOD_BAND） */
  const inGoodBand = () => anchorScore !== null && anchorScore <= JUDGE_GOOD_BAND;
  const effTarget = () =>
    anchorScore === null
      ? target
      : // 好区内：目标就是它自身（绝不低于绝对目标，也绝不继续往下追）
        inGoodBand()
        ? Math.max(target, anchorScore)
        : Math.max(target, Math.round(anchorScore * RELATIVE_TARGET_RATIO));
  /** 往 note 上追加一句（note 为空时不能带前导分号） */
  const appendNote = (n: string, extra: string) => (extra ? (n ? `${n}；${extra}` : extra) : n);
  /**
   * 达标线为什么不是绝对目标——两种情形都要让用户看见：首轮已进好区就地收手，
   * 或严评下按锚点放宽。两条返回路径（竞争段提前收手 / 主循环收场）共用同一套说法。
   */
  const targetHint = () => {
    if (anchorScore === null) return "";
    if (inGoodBand())
      return `首轮 ${anchorScore} 分已落在人写带（≤${JUDGE_GOOD_BAND}），未进修订轮——实测两轮修订都没拿到更优分（15→49、89→92），继续只是白烧调用`;
    const t = effTarget();
    return t > target ? `评判锚点：首轮 ${anchorScore} 分 → 达标线放宽至 ≤${t}` : "";
  };
  // v0.9.6 未改进即停·L1（痕迹收敛守卫）：上一轮交叉定罪痕迹集合。
  // 修订轮定罪清单中若与上轮重合度 ≥2 项，说明定向修订没有消除目标痕迹——
  // 实测（panel-revision 实验）：合议庭痕迹可精确执行消除（虚构事例 ✅），
  // 但总分受"地板噪声"（句长/收尾类风格偏好）托底不降，继续轮次只会白烧预算。
  let prevCrimes: Set<string> | null = null;
  // v0.9.6 未改进即停·L2（风格回退守卫）：修订前最优稿的本地指纹硬伤集合。
  // 修订候选若新增硬指纹（句长节奏过平等——LLM 碎句化改写的典型副产物），
  // 视为回退：拒收本轮、回滚上一轮底稿并停止（风格回退无法靠下一轮修复，
  // 实测第 2 轮"碎句化"修订把 cv 拉回 AI 特征带）。
  let prevFingerprintIssues: Set<string> = new Set();

  /**
   * 交付收口：两条返回路径（竞争段提前收手 / 主循环收场）**都必须**走这里。
   *
   * v0.9.14 补的洞：此前只有后者做收稿终审，即"首轮就达标"的稿子反而不过终审——
   * 把好区收手接上提前 return 之后，这个不对称会被放大，所以统一到一个出口。
   * 顺序：严格保真终审（发现编造即否决，抛 FabricationVetoError）→ 达标线说明 → 未达标提示。
   *
   * 为什么还要一次终审：每候选的编造复核有漏判率（实测 s1 竞争稿的"见效最快/比拍脑袋准"
   * 漏网，修订轮同内容才被抓到），前移复核不能完全替代收稿检查。v0.9.13 之前这里只警告不
   * 拦截，结果是 s2 带着三处新增断言照发——本版把"显式警告"升级为"拒绝交付"。
   */
  const deliver = async (hit: boolean): Promise<DeepResult> => {
    let finalNote = note;
    if (cfg.strictFidelity) {
      try {
        const fabs = await fabricationReview(text, bestText, cfg);
        if (fabs.length) throw new FabricationVetoError(fabs);
      } catch (e) {
        if (e instanceof FabricationVetoError) throw e; // 否决不能被"通道异常"吞掉
        // 复核通道本身异常不阻断交付（不把通路打死），但**必须说出来**：
        // 静默跳过等于让用户以为稿子过了事实核查，而它根本没查。
        finalNote = appendNote(
          finalNote,
          `⚠️ 编造复核未能完成（${(e as Error).message.slice(0, 40)}），本次未做否决——交付稿未经事实核查`,
        );
      }
    }
    finalNote = appendNote(finalNote, targetHint());
    if (!hit && roundScores.length > 0) {
      finalNote = appendNote(
        finalNote,
        `仅完成 ${roundScores.length} 轮，未达目标 ≤${effTarget()} 分，结果可能仍偏 AI（可重试或换改写模型）`,
      );
    }
    return {
      text: bestText,
      roundScores,
      hitTarget: hit,
      note: finalNote,
      qcPassed,
      qcIssues: qcIssuesByDraft.get(bestText) ?? [],
      targetUsed: effTarget(),
      shrinkRatio: shrinkRatioOf(text, bestText),
    };
  };

  // v0.5.1 双改写器竞争：主模型与备选模型各写一版第一稿，交叉评分择优当底稿。
  // 依据 A/B 实测：glm-5.2 改写被 deepseek 判 35，deepseek 改写被 glm 判 75（两样本一致）——
  // 不同模型的改写强项差异巨大，让它们赛一场比押注单模型稳。
  // v0.8.9 扩展：未配 altModel 时，可用同一模型多采样竞争（cfg.contestSamples ≥ 2）。
  // 依据：实测同一 temperature=0.9 的改写稿质量在 20~88 分之间横跳（极差 89），
  // 而评判尺子极稳（同文本重复评判极差 2）——瓶颈是改写采样的运气，多采几稿取最优最直接。
  const alt = cfg.altModel.trim();
  const contestants: string[] = [];
  // v0.9.5 竞争段自适应：长文赛马实测必超时（1200 字 420s 零产出），自动降级
  // 为仅主力模型首稿；短文保持赛马（pro 在小说等体裁有真收益，s6: 14 vs 39）
  const longText = text.replace(/\s+/g, "").length > ADAPTIVE_CONTEST_CHARS;
  if (alt && alt !== cfg.model && !longText) {
    contestants.push(cfg.model, alt);
  } else if (!longText) {
    const n = Math.max(1, Math.min(5, Math.floor(cfg.contestSamples ?? 1)));
    for (let i = 0; i < n; i++) contestants.push(cfg.model);
  } else {
    contestants.push(cfg.model);
  }
  const multiContest = contestants.length > 1;
  // v0.9.5：长文单候选路径的可见化说明（竞争段块内不会执行，在此预置 note，
  // 后续主循环的锚点/预算 note 均为追加式，不会被覆盖丢失）
  if (!multiContest && longText) {
    note = `长文自适应（>${ADAPTIVE_CONTEST_CHARS} 字）：跳过多模型赛马，仅主力模型改写`;
  }
  if (multiContest) {
    const contestInfo: string[] = [];
    // v0.9.13 候选并发。此前逐个 await：本网关实测单次调用 30~40s、每候选约 5~7 次调用，
    // 3 候选串行 ≈9 分钟，直接撞满 maxWaitSeconds——s4 实测 16 次调用 / 521 秒 / 只跑完
    // 1 轮（目标 ≤15 分，拿到 42 分收场），"多轮迭代"在真实延迟下结构性不可能发生。
    // 并发不减一次调用，只把墙钟从 Σ 降到 ceil(N/上限)，同一预算才换得来真正的多轮。
    // 上限 3 与 Key 池容量对齐：再高会加剧 429，反而更慢。
    type ContestResult =
      | { kind: "none" }
      | { kind: "info"; why: string }
      | {
          kind: "cand";
          qcPass: boolean;
          score: number | null;
          text: string;
          critique: string[];
          model: string;
          issues: string[];
        };
    const results: ContestResult[] = new Array(contestants.length).fill({ kind: "none" });
    await mapLimited(contestants, CONTEST_MAX_PARALLEL, async (m, ci) => {
      const tag = `${m}#${ci + 1}`;
      // v0.8.6 竞争段接入调用预算：每个竞争者开跑前检查（与主循环"轮间检查"同语义），
      // 超预算不再发起竞争调用——此前竞争段计入计数却不受约束，极小预算配置下
      // 会先烧穿 maxApiCalls 才轮到主循环首次检查
      if (isOverBudget()) {
        results[ci] = { kind: "info", why: `${tag}:预算已耗尽跳过` };
        return;
      }
      try {
        // v0.8.9：竞争段同样走空响应降级重试；altModel 传空——本段已是多候选竞争，
        // 不再嵌套"换模型"档，避免调用数不可控
        const r = await chatNonEmpty(
          cfg,
          [
            { role: "system", content: buildSystemPrompt(cfg, intensity, text) },
            { role: "user", content: text },
          ],
          { temperature: cfg.temperature, maxTokens: 8000, model: m },
          "",
          isOverBudget,
        );
        if (!r.content) {
          results[ci] = { kind: "info", why: `${tag}:空输出` };
          return;
        }
        const cand = await processCandidate(text, r.content, cfg, intensity);
        results[ci] = {
          kind: "cand",
          qcPass: cand.qc.pass,
          score: cand.score,
          text: cand.shuffled,
          critique: cand.critique,
          model: m,
          issues: cand.qc.issues,
        };
      } catch {
        results[ci] = { kind: "info", why: `${tag}:调用失败` };
      }
    });
    // 聚合严格按候选序号：并发的完成顺序不得改变 qcPassed/roundScores 的序列，
    // 否则同一份输入两次跑结果不同，可复现性就没了
    for (let ci = 0; ci < contestants.length; ci++) {
      const tag = `${contestants[ci]}#${ci + 1}`;
      const res = results[ci];
      if (res.kind === "info") {
        contestInfo.push(res.why);
        continue;
      }
      if (res.kind !== "cand") continue;
      qcPassed.push(res.qcPass);
      qcIssuesByDraft.set(res.text, res.issues);
      if (!res.qcPass) {
        contestInfo.push(`${tag}:质检未过`);
        continue;
      }
      roundScores.push(res.score ?? -1);
      // 定锚交给循环结束后的 bestScore（= 各有效分里的最低分）：此前这里按候选序号
      // 抢先锚定"首个过检分"，与下方 v0.8.9 注释写明的意图相反。打桩实测两份合格稿
      // 判 46 与 15：抢先锚到 46 → 目标 round(46×0.35)=16 → 15 分稿反而"不达标" → 再白开一轮
      // 修订（正是本版要省掉的那种轮次）。单行回退该行即红 expected 16 to be 15。
      contestInfo.push(`${tag}:${res.score ?? "?"}`);
      const sc = res.score ?? 999;
      if (sc < bestScore) {
        bestScore = sc;
        bestText = res.text;
        lastCritique = res.critique;
        writerModel = res.model;
      }
      onProgress?.(1, res.score, `竞争 ${tag} `);
    }
    note = `双模型竞争（${contestInfo.join("，")}）`;
    // v0.8.9：竞争段有多个有效分时，锚点取<b>最优（最低）</b>分而非首个——首个分只是
    // "第一次采样的运气"，用它标定宽严会把达标线抬松。实测三候选 85/70/70，
    // 用首个分定锚 → 达标线 ≤30；用最优分 70 定锚 → ≤24，才反映真实可达水平。
    if (anchorScore === null && bestScore < 999) anchorScore = bestScore;
    if (bestText && bestScore <= effTarget()) {
      return await deliver(true);
    }
  }

  const startRound = bestText ? 2 : 1;
  for (let round = startRound; round <= maxRounds; round++) {
    // 预算控制：超时或超调用次数，带当前最优结果收场
    if (isOverBudget()) {
      if (bestText) {
        note = `${budgetReason()}，返回第 ${round - 1} 轮最优结果`;
      } else {
        note = `${budgetReason()}，无可用结果`;
      }
      break;
    }
    // 单轮失败（限流耗尽/网络）不丢掉已完成成果：有 bestText 就带结果收场
    let content: string;
    let retryVia: string | undefined; // v0.8.9：记录本轮靠哪档降级重试拿到的内容（undefined=未重试）
    try {
      const userMsg = bestText
        ? buildRevisionPrompt(
            bestText,
            bestScore > 100 ? 50 : bestScore, // 无分底稿（999）按 50 计；失败标记/-1 不进提示词
            effTarget(),
            lastCritique,
          )
        : text; // 没有可用底稿（如前轮质检全挂）就重新改写原文
      // v0.8.9 P0：空响应不再直接放弃，走降级重试（token 预算翻倍 / 换备选模型）
      const r = await chatNonEmpty(
        cfg,
        [
          { role: "system", content: buildSystemPrompt(cfg, intensity, text) },
          { role: "user", content: userMsg },
        ],
      // v0.9.5 能力优化：修订温度递减。旧实现逐轮升温（+0.05）——设计意图是
      // "打不开局面时加大随机性逃逸"，但实测修订是执行痕迹清单的精准任务，
      // 升温加剧横跳（90→90、76→88 的部分根因）。改递减：首轮保持采样多样性，
      // 越往后越收敛，配合"局部修改铁律"把修订稳定在清单执行上。
      {
        temperature: Math.max(0.5, cfg.temperature - (round - 1) * 0.15),
          maxTokens: 8000,
          model: writerModel,
        },
        alt,
        isOverBudget,
      );
      content = r.content;
      retryVia = r.via;
    } catch (e: unknown) {
      if (bestText) {
        note = `第 ${round} 轮调用失败（${errMsg(e)}），返回已有最优结果`;
        break;
      }
      throw e;
    }
    if (!content && bestText) {
      // v0.8.9：带痕迹清单的修订 prompt 长度与指令复杂度都远高于首轮，是空响应高发区。
      // 降级重试仍为空时，退回"纯原文重改写"（不带 critique）再给一次机会——
      // 拿到内容就继续闭环，拿不到才带已有最优结果收场。
      const fb = await chatNonEmpty(
        cfg,
        [
          { role: "system", content: buildSystemPrompt(cfg, intensity, text) },
          { role: "user", content: text },
        ],
        { temperature: cfg.temperature, maxTokens: 8000, model: writerModel },
        alt,
        isOverBudget,
      );
      if (fb.content) {
        content = fb.content;
        retryVia = retryVia ? `${retryVia}+纯原文重改写` : "纯原文重改写";
      }
    }
    if (!content) {
      if (!bestText) {
        throw new Error("模型返回空内容（思考型模型 token 预算耗尽，可重试或换非思考型模型）");
      }
      // v0.8.9：已走完降级重试仍为空才放弃，并把重试情况写进 note 让 UI 可见
      note = `第 ${round} 轮模型返回空内容${retryVia ? `（已重试：${retryVia}）` : "（降级重试亦为空）"}，返回已有最优结果`;
      break;
    }

    const cand = await processCandidate(text, content, cfg, intensity);
    qcPassed.push(cand.qc.pass);
    // 按稿归属：这一稿自己的质检结论，只有它真被交付时才对外报
    qcIssuesByDraft.set(cand.shuffled, cand.qc.issues);

    if (!cand.qc.pass) {
      // 弃用本轮，并把质检问题喂给下一轮修订（优先保义再降 AI 味）
      lastCritique = cand.qc.issues;
      if (!bestText && round === maxRounds) {
        throw new Error(`各轮质检均未通过（${cand.qc.issues[0] ?? "原因未知"}），已回退本地引擎`);
      }
      continue;
    }

    // v0.9.6 未改进即停·L2（风格回退守卫）：修订候选若引入上一轮最优稿没有的
    // 本地硬指纹（句长节奏过平等——LLM 碎句化修订的典型副产物），判为风格回退：
    // 拒收本轮、保留上一轮底稿并停止（风格回退不是下一轮能修好的，实测第 2 轮
    // "碎句化"修订把节奏拉回 AI 特征带）。仅修订轮生效（round ≥ 2），竞争段豁免。
    if (round >= 2 && bestText) {
      const fpNow = new Set(
        fingerprintCheck(cand.shuffled)
          .issues.filter((i) => i.name !== "AI 套话残留" && i.name !== "段首过渡词残留")
          .map((i) => i.name),
      );
      const newIssues = [...fpNow].filter((n) => !prevFingerprintIssues.has(n));
      if (newIssues.length > 0) {
        note =
          (note ? `${note}；` : "") +
          `第 ${round} 轮风格回退：修订引入新指纹「${newIssues[0]}」，保留上一轮最优稿，停止后续轮次`;
        break;
      }
    }

    const score = cand.score;
    if (score !== null && score >= 0) {
      if (anchorScore === null) anchorScore = score;
      roundScores.push(score);
      lastCritique = cand.critique;

      // v0.9.6 未改进即停·L1（痕迹收敛守卫）：合议庭模式下，本轮交叉定罪与
      // 上一轮的重合度 ≥2 项 → 定向修订没有消除目标痕迹，继续轮次只是白烧。
      // 依据（panel-revision 实验）：痕迹可精确消除（虚构事例 ✅），但总分被
      // "地板噪声"（句长/收尾类风格偏好）托底，75→75 不动。分数单指标看不出来，
      // 必须比对痕迹集合。仅修订轮生效（round ≥ 2），竞争段豁免。
      const fpForL1 = fingerprintCheck(cand.shuffled);
      const prev = prevCrimes;
      if (round >= 2 && prev !== null && prev.size > 0) {
        const overlap = cand.critique.filter((c) => prev.has(c)).length;
        if (overlap >= 2) {
          const stuck = cand.critique.filter((c) => prev.has(c)).slice(0, 2);
          note =
            (note ? `${note}；` : "") +
            `第 ${round} 轮痕迹收敛守卫：${overlap} 项上轮定罪痕迹未消除（${stuck.join("、")}），定向修订无效，停止后续轮次`;
          break;
        }
      }
      // 更新基准（在守卫判定之后、bestText 更新之前——本轮定罪清单是下一轮的靶子）
      if (cand.critique.length) {
        prevCrimes = new Set(cand.critique);
      }
      if (fpForL1.issues.length) {
        // 非统计软项才进回退基准（节奏类是趋势信号，会随切句波动）
        prevFingerprintIssues = new Set(
          fpForL1.issues
            .filter((i) => i.name !== "AI 套话残留" && i.name !== "段首过渡词残留")
            .map((i) => i.name),
        );
      }
    } else {
      roundScores.push(-1); // 评分失败不阻断流程，标记 -1
    }
    onProgress?.(round, score);

    if (score !== null && score >= 0) {
      // 达标优先：本轮达标即收，若同时是最低分则更新底稿
      if (score <= effTarget()) {
        hitTarget = true;
        // 达标即最优（后续不再更新），直接落底稿后退出
        if (score < bestScore) {
          bestText = cand.shuffled;
        }
        break;
      }
      // v0.8.9 未改进即停：本轮分数不优于当前最优 = 修订没带来收益，立即收手。
      // 实测修订轮频繁反向优化（76→88；三候选底稿 70、修订后 89），继续只会白烧预算。
      // 早前版本按"高于上一轮"判定，但上一轮基线不含竞争段最优分，
      // 于是出现"竞争稿 70、修订稿 89"仍继续跑下一轮的情况。改用 bestScore 作基线：
      // 初值 999（哨兵）保证首轮必然优于它，不会误停。
      if (score >= bestScore) {
        // v0.9.5：追加式而非覆盖——保留竞争段的"长文自适应"等前置说明
        note =
          (note ? `${note}；` : "") +
          `第 ${round} 轮未优于当前最优（${bestScore} → ${score}），修订无收益，停止后续轮次`;
        break;
      }
      bestScore = score;
      bestText = cand.shuffled;
    } else if (!bestText) {
      // 评分失败但质检已过，兜底保留；分数记 999（劣于一切真实分），
      // 不能用 -1 —— 那会让后续真实分数永远赢不了它（best-of 被哨兵污染）
      bestText = cand.shuffled;
      bestScore = 999;
    }
  }

  // 零轮完成（预算耗尽/轮数为 0 且无任何产出）不能把空串当结果：
  // 抛错让上层 runHumanize 回退本地引擎，与单轮空输出守卫对齐
  if (!bestText) {
    throw new Error((note || "深度去味未获得任何可用结果") + "，已回退本地引擎");
  }

  // v0.9.5 能力优化：终审与所有说明统一在 deliver() 里收口（含 v0.9.14 的编造否决）。
  return await deliver(hitTarget);
}
