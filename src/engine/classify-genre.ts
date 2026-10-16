/**
 * v3 自动体裁识别（BenchmarkPanel OLS 公式自动选曲用，也可给引擎做 P3 门控前置）
 *
 * 三分法输出：main(论说) / narrative(叙事) / dialogue(对话)，另外 "human" 纯人写不自动选
 *   → 理由：纯人写稿 vs 去味后的 AI 稿在表层特征上高度重合，自动选容易误判；
 *     只有用户明确勾选「这是纯人写原稿」时才切换到 human 负斜率公式。
 *
 * 启发式特征（无需训练、毫秒级）：
 *   (A) Dialogue 对话信号
 *     - dlgQuoteRatio  每100字中「」或""包裹的发言次数（「小明：好呀」/「他说"行"」）
 *     - dlgColonRatio  句子开头 "1~8字角色名 + [：:]" 的占比（小明：我去 / 主持人：各位好）
 *     - dlgShortTurn   句长 ≤5 的独立短句子占比（"嗯。"/"好。"/"为什么？"——对话体天然多）
 *   (B) Expository 论说信号
 *     - expoScore      classifyExpositionScore 的结果（≥0.55 = 论说文置信度高，P3 用的同一个指标）
 *   (C) Narrative 叙事信号
 *     - narPastRatio   每100字「了/过/已经/曾/曾经/刚刚/刚才」等过去时词汇
 *     - narSceneRatio  每100字「在…里/旁/中/家/学校/路上/房间/办公室/城市/国家」等场景指示
 *
 * 决策顺序（有优先级，先判高信度体裁再回落）：
 *   1. IF dlgQuoteRatio ≥ 0.05  OR  dlgColonRatio ≥ 0.15  →  dialogue（对话体）
 *   2. IF expoScore ≥ 0.55  →  main（论说文）
 *   3. IF narPastRatio ≥ 0.025  AND  narSceneRatio ≥ 0.018  AND  expoScore < 0.50  →  narrative（叙事文）
 *   4. 否则 回落  expoScore ≥ 0.35 ? main : narrative
 *
 * 返回 { genre, confidence, rawFeatures }，BenchmarkPanel 用 genre 选下拉、confidence 展示徽章。
 */
import { classifyExpositionScore } from "./humanize-shuffle.ts";
import { isSpecTableParagraph } from "./anti-fingerprint.ts";
import { guardFor } from "./text-shield";

export type AutoGenre = "main" | "narrative" | "dialogue";

export interface GenreFeatures {
  /** 每 1 字单位的发言引号数（「」/ ""）*/
  dlgQuoteRatio: number;
  /** 每句的「角色名(+职称括号) + 冒号」开头占比 (0~1) — 兼容「小明：/张总（项目经理）：/李工_前端：：」等剧本格式 */
  dlgColonRatio: number;
  /** 句长 ≤5 字的独立句占比 (0~1) */
  dlgShortTurn: number;
  /** 剧本场景块的密度 (【…】中含「场景/人物/地点/时间」关键字的次数/字) */
  dlgSceneBlockRatio: number;
  /** classifyExpositionScore (0~1) 论说文指标，≥0.55=高置信 */
  expoScore: number;
  /** 每 1 字单位的过去时词汇数（了/过/曾/已经…）*/
  narPastRatio: number;
  /** 每 1 字单位的场景指示词汇数（在…里/旁/中等结构）*/
  narSceneRatio: number;
  /** 纯字字符数（不含标点），用于归一化 */
  pureChars: number;
  /** 句子总数 */
  sentCount: number;
}

export interface GenreResult {
  genre: AutoGenre;
  /** 0~1 的启发式置信度，用于徽章展示 */
  confidence: number;
  /** 命中的规则编号，可调试 */
  ruleHit: 1 | 2 | 3 | 4;
  /** 所有原始特征值（可用于调试面板展开）*/
  features: GenreFeatures;
}

/** 极简中文分句子（避免对 splitSentences 的循环依赖，分类器要能单独使用）*/
function splitSentencesLight(text: string): string[] {
  if (!text) return [];
  // v0.9.25：跳过落在 URL/邮箱内部的切点（与 humanize-text.ts 同一判据）。
  //
  // ⚠️ **收益有限，如实登记**：含 URL 段落此前会多切出一句，修复后句数 5→4，
  // 但端到端 `classifyGenre` 的**输出未变**（探针 `artifacts/_probe-splitsent-fork.ts`
  // 实测样本1 修复前后同为 `dialogue/0.615`）——该样本的体裁由引号/短句特征决定，
  // 句数只是分母。同理 detector 侧 detectAI 17→16。
  // 探针表里「原样 vs 把 URL 整体删掉」的大差异（genre → narrative/0.750）
  // 主要来自 **URL 字符本身**（文本变短、pureChars 变小），不是切句贡献，别算在这条账上。
  // 保留此修改的理由是**统计口径正确 + 消除四份切句的分叉**，不是它能修体裁误判。
  const guard = guardFor(text);
  // 先在标点处切开，保留结尾标点
  const pieces: string[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if (!guard(i) && ("。！？!?".includes(ch) || ch === "…")) {
      // 再吸收可能的叠词（……、！！、？？）
      let j = i + 1;
      while (j < text.length && "。！？!?…".includes(text[j])) {
        buf += text[j];
        j++;
      }
      i = j - 1;
      pieces.push(buf);
      buf = "";
    }
  }
  if (buf.trim().length > 0) pieces.push(buf);
  return pieces.filter((s) => s.trim().length > 0);
}

function pureLen(s: string): number {
  return (s.match(/[\u4e00-\u9fa5A-Za-z0-9]/g) ?? []).length;
}

export function classifyGenre(text: string): GenreResult {
  const empty = (): GenreFeatures => ({
    dlgQuoteRatio: 0,
    dlgColonRatio: 0,
    dlgShortTurn: 0,
    dlgSceneBlockRatio: 0,
    expoScore: 0,
    narPastRatio: 0,
    narSceneRatio: 0,
    pureChars: 0,
    sentCount: 0,
  });
  if (!text || text.trim().length < 30) {
    return { genre: "main", confidence: 0.3, ruleHit: 4, features: empty() };
  }

  const sents = splitSentencesLight(text);
  const pure = pureLen(text);
  const f: GenreFeatures = {
    dlgQuoteRatio: 0,
    dlgColonRatio: 0,
    dlgShortTurn: 0,
    dlgSceneBlockRatio: 0,
    expoScore: classifyExpositionScore(text),
    narPastRatio: 0,
    narSceneRatio: 0,
    pureChars: pure,
    sentCount: sents.length,
  };

  if (pure < 20) return { genre: "main", confidence: 0.35, ruleHit: 4, features: f };

  // —— (A) Dialogue 特征 ——
  // 「…」发言匹配 + "…"发言（英文双引号内中文 ≥2 字）
  const cornerQuotes = (text.match(/「[^」]{2,60}」/g) ?? []).length;
  const dblQuotes = (text.match(/"[^"]{2,60}"/g) ?? []).length;
  f.dlgQuoteRatio = (cornerQuotes + dblQuotes) / Math.max(1, pure);

  // 冒号台词开头：
  //  v2 归档对话剧本式：「张总（项目经理）：」「李工（前端负责人）：」
  //  聊天式：「小明：」「主持人_小A：」
  //  放宽：句首 1~24 字符，允许中英文、数字、下划线、中英文括号，最后一个字符是冒号/全角冒号
  // v0.9.24 修（探针实证）：字符类尾部原写作 `（）()【】[]]`，其中裸的 `[` 让字符类
  // **提前闭合**，整条正则恒不匹配——实测「阿明：这周汇报」「张总（项目经理）：指标」
  // 「主持人_小A：大家好」全部 false。于是 dlgColonRatio 恒为 0，
  // Rule 1 里 `dlgColonRatio >= 0.06` 这条单特征路径、以及 combo 里的 0.3 权重
  // 都是**从不生效的死分支**；对话体此前只靠场景块/引号/短句占比被救回来。
  // 修法：`[` 写成 `\[`（`]` 位于类尾本就合法，无需转义）。
  //
  // ⚠️ 下面这行的 \[ 会触发 eslint no-useless-escape，**这是误报，不要"顺手清理"**。
  // 探针对照实测（7 个用例）：含 `\[\]` 命中 7/7；裸 `[` 的两种写法（放类中/放类尾）
  // 都是 0/7。eslint 的判定只看到 `\[` 两个字符，不知道在字符类里裸 `[` 会让类
  // **提前闭合**（类内容变成 `…【】` 加一个字面 `]`），于是把整条正则废掉。
  // 这是"静态规则正确、实际行为错误"的典型，处置方式是带理由豁免而不是服从。
  let colonHits = 0;
  // eslint-disable-next-line no-useless-escape -- 字符类里的 \[ 必须转义，否则类提前闭合、正则恒不匹配（见上方注释与测试）
  const colonRe = /^[\u4e00-\u9fa5A-Za-z0-9_\-\s（）()【】\[\]]{1,24}?[：:]/;

  // v0.9.46 真实案例修正（artifacts/realcase）：「台词冒号」此前把三种非台词形态一起数了进去，
  // 于是一篇只出现一两次的正常新闻稿/说明文档被打成 dialogue（引语≈0、场景块=0、短句=0，
  // 却因为冒号密度单项过 0.06 直接触发 Rule 1）。实测样本：
  //   ① 新闻间接引语：「公司首席执行官王建国在发布会上表示：“……”」——陈述动词+冒号，不是台词；
  //   ② URL scheme：「接口地址变更为 https://api.example.com/…」——协议分隔符；
  //   ③ 说明文标签：「本次 API 升级说明如下：」「调用示例：」——说明体例，不是对话。
  // 下方各条排除逐一对应。口径刻意保守：只排除"冒号左边白纸黑字是这些形态"的确定性证据，
  // 不碰阈值本身（动阈值会连带 exposition/narrative 判据的测试基线）。
  const REPORT_VERB_RE =
    /(?:表示|指出|强调|认为|认为|介绍|宣布|透露|补充|解释|说明|总结|写道|宣称|回应|提醒|建议)$/;
  const EXPLAIN_LABEL_RE =
    /(?:如下|示例|例如|举例|步骤|注意|备注|附注|要点|清单|说明|介绍|用法|示例如下)$/;
  const URL_SCHEME_RE = /\b(?:https?|ftp|mailto|file):\/\//i;
  // ④ 诉讼文书判项标签（「上诉请求：」「事实和理由：」「本院认为：」）——法律文书的
  //    固定段落标签，冒号后接判项/事实陈述，不是台词。
  //    v0.9.51 真实案例（C17 判决书）：「某科技公司上诉请求：」「事实和理由：」
  //    两个标签冒号把整篇判决书打成 dialogue（colon=0.286 ≥ 0.06），
  //    正式语体治理层整层失效——句尾语气词「呢/呀/嘛」注入判决书（6/13 seed），
  //    切句层还把法条引用打散。口径与上面三条排除一致：只排除"冒号左边
  //    白纸黑字是这些形态"的确定性证据，不碰阈值。
  //    注：「本院认为」已被 REPORT_VERB_RE 的「认为」分支覆盖，这里不重复收。
  const LITIGATION_LABEL_RE = /(?:上诉请求|事实和理由|辩称|裁判结果|判决如下|裁决如下|原审认定)$/;
  // ⑤ 条目字段标签（「项目名称：」「招标编号：」）——表格/招标/条款文本的字段名，
  //    冒号后接字段值不是台词。同源：C18 招标参数表被打成 dialogue（colon=0.286）。
  //    刻意不收裸「项目：」——对话里真有人说「项目：预算批了」，字段名必须带
  //    「名称/编号」这类确定性后缀。
  const FIELD_LABEL_RE = /(?:项目名称|项目编号|招标编号|标的|工期|开标时间|投标文件|招标文件)$/;

  for (const s of sents) {
    const trimmed = s.trimStart();
    const m = trimmed.match(colonRe);
    if (!m) continue;
    const upto = trimmed.slice(0, m[0].length); // 含冒号的前缀，例如「王建国在发布会上表示：」
    // ② URL scheme：整句里出现协议分隔符就整句不计（技术文档的 scheme 冒号密度极高）
    if (URL_SCHEME_RE.test(trimmed)) continue;
    const head = upto.slice(0, -1).trim(); // 去掉冒号本身
    // ① 转述动词收尾（"某某表示："这类新闻陈述）
    if (REPORT_VERB_RE.test(head)) continue;
    // ③ 说明性标签收尾（"升级说明如下："、"调用示例："）
    if (EXPLAIN_LABEL_RE.test(head)) continue;
    // ④ 诉讼文书判项标签（"上诉请求："、"事实和理由："）
    if (LITIGATION_LABEL_RE.test(head)) continue;
    // ⑤ 条目字段标签（"项目名称："、"招标编号："）
    if (FIELD_LABEL_RE.test(head)) continue;
    colonHits++;
  }
  f.dlgColonRatio = colonHits / Math.max(1, sents.length);

  // 剧本场景块：【场景：…】/【人物：…】/【地点：…】/【时间：…】类头部关键字
  const sceneBlockRe = /【[^】]{0,40}(?:场景|人物|角色|地点|时间|背景)[^】]{0,40}】/g;
  const sceneBlocks = (text.match(sceneBlockRe) ?? []).length;
  f.dlgSceneBlockRatio = sceneBlocks / Math.max(1, pure);

  // 短句（≤5 字）占比
  let shortHits = 0;
  for (const s of sents) if (pureLen(s) <= 5 && pureLen(s) >= 1) shortHits++;
  f.dlgShortTurn = shortHits / Math.max(1, sents.length);

  // —— (C) Narrative 特征 ——
  // 过去时指示词：作为独立特征做中文词级计数，避免双计"已经了"之类
  // v0.9.1：补"过"——中文两大过去时核心助词是"了"和"过"，原正则漏了"过"，
  // 导致"透过/翻过/驶过/过去了"这类典型叙事过去时不计入，叙事文被误判为论说文。
  // （"过"在"通过/过程/过度"等非过去时用法会产生少量误报，但叙事检测有
  // narSceneRatio 双证据门控，单特征误报不会导致误分类。）
  const pastRe =
    /(过了|过|了|曾|曾经|已经|方才|刚刚|刚才|此前|先前|后来|之后|以前|从前|去年|昨天|前天|前几日|上周|上个月)(?!的话)/g;
  const pastHits = (text.match(pastRe) ?? []).length;
  f.narPastRatio = pastHits / Math.max(1, pure);

  // 场景指示：以「在 / 到 / 从 / 来到」+ 地点结尾词 为骨架
  // v0.9.1：补"边/处/头/角"等常见位置词，并放宽字符上限 12→14（"在客厅里"4字、"在办公室里"5字都应匹配）
  const sceneRe =
    /(?:在|到|从|来到|去到|去了|回了)[\u4e00-\u9fa5A-Za-z0-9]{1,14}?(?:里|外|旁|中|上|下|家|学校|教室|公司|办公室|房间|客厅|卧室|厨房|路上|街|城市|小镇|村庄|国|省|市|区|机场|车站|码头|医院|商店|餐厅|公园|山|河|海边|森林|草原|沙漠|楼|门|口|前|后|边|处|头|角)/g;
  const sceneHits = (text.match(sceneRe) ?? []).length;
  f.narSceneRatio = sceneHits / Math.max(1, pure);

  // —— 决策 ——
  // Rule 1：对话体：优先判（对话体自带强句法特征，误判率低）
  //   · 【剧本场景块】出现 → 对话概率极高（只有剧本/访谈才写【场景：X】【人物：Y】）
  //   · 冒号开头 ≥ 6% 或 引号 ≥ 5%（单特征足够）
  //   · 综合得分：四个对话特征累积加权 ≥ 0.28 也判对话（覆盖短对话碎片）
  const dlgComboScore = Math.min(
    1,
    (f.dlgSceneBlockRatio > 0 ? 0.35 : 0) +
      (f.dlgColonRatio >= 0.06 ? 0.3 : (f.dlgColonRatio / 0.06) * 0.3) +
      (f.dlgQuoteRatio >= 0.05 ? 0.25 : (f.dlgQuoteRatio / 0.05) * 0.25) +
      (f.dlgShortTurn >= 0.25 ? 0.12 : (f.dlgShortTurn / 0.25) * 0.12),
  );
  if (
    f.dlgSceneBlockRatio > 0 ||
    f.dlgQuoteRatio >= 0.05 ||
    f.dlgColonRatio >= 0.06 ||
    dlgComboScore >= 0.28
  ) {
    const conf = Math.min(0.95, dlgComboScore > 0 ? 0.45 + dlgComboScore * 0.55 : 0.6);
    return { genre: "dialogue", confidence: conf, ruleHit: 1, features: f };
  }

  // Rule 2：论说文：用已有 classifyExpositionScore ≥ 0.55（P3 门控阈值，已验证）
  if (f.expoScore >= 0.55) {
    const conf = Math.min(
      0.92,
      0.5 + (f.expoScore - 0.55) * 2 + (f.narPastRatio < 0.012 ? 0.08 : 0),
    );
    return { genre: "main", confidence: conf, ruleHit: 2, features: f };
  }

  // Rule 3：叙事文：有"过去时 + 场景"联合证据，且论说分不高
  // v0.9.1：场景阈值 0.018→0.015（115 字叙事文"在地板上/在书中"只凑到 0.0174，差 0.0006 就漏判）
  if (f.narPastRatio >= 0.025 && f.narSceneRatio >= 0.015 && f.expoScore < 0.5) {
    const conf = Math.min(
      0.9,
      0.35 +
        Math.min(0.25, (f.narPastRatio - 0.025) * 6) +
        Math.min(0.2, (f.narSceneRatio - 0.015) * 8) +
        (f.dlgQuoteRatio < 0.02 ? 0.08 : 0),
    );
    return { genre: "narrative", confidence: conf, ruleHit: 3, features: f };
  }

  // Rule 4：回落——论说分偏低 (<0.35) 且 过去时略多 → 叙事，否则默认论说（最安全的选择）
  //
  // v0.9.5 修：正式公文会被这条规则误判为叙事文。原因是公文里大量出现
  // 「完成了 / 提高了 / 推动了 / 下降了」这类**完成体**"了"，被 narPastRatio
  // （中文"了/过"同时承担完成体与过去时，无法靠单字区分）计成叙事过去时；
  // 而公文几乎不含论说特征词，expoScore 又偏低 —— 两个条件同时满足，回落到了叙事。
  //
  // 后果是会连锁的：humanize.ts 的正式语体门控按 genre==="main" 判定
  // （formalRegister = effectiveGenre === "main" || style === "academic"），
  // 公文一旦被判成叙事，FORMAL_RESTORE 整层就完全不生效 —— 实测一份公文
  // 被注入了「死磕以问题为导向」「根本摆平」「不断完善→一直弄全吧」。
  //
  // 这里用公文体自身的特征（正式套语 + 分条序数）作为否决条件：命中足够密度时
  // 回落改判论说。叙事文不含这类套语，不受影响（s6 故事样本 officialRatio = 0）。
  const OFFICIAL_RE =
    /(现将|根据[《\w]|按照|为了|关于|特此|各单位|各部门|上级部门|认真贯彻|工作目标|工作总结|总结如下|汇报如下|报告如下|主责主业|狠抓|筑牢|下一步|工作总基调|在肯定成绩的同时|清醒地认识到)/g;
  const officialRatio = (text.match(OFFICIAL_RE) ?? []).length / Math.max(1, pure);
  const fallNarrative = f.expoScore < 0.35 && f.narPastRatio >= 0.012 && officialRatio < 0.006;
  const genre: AutoGenre = fallNarrative ? "narrative" : "main";
  const confBase =
    genre === "main"
      ? Math.max(0.4, 0.35 + f.expoScore * 0.4)
      : Math.max(0.4, 0.35 + f.narPastRatio * 8 + f.narSceneRatio * 6);
  return { genre, confidence: Math.min(0.75, confBase), ruleHit: 4, features: f };
}

/** 给 UI 用的中文名字映射 */
export const GENRE_ZH: Record<AutoGenre, string> = {
  main: "论说文",
  narrative: "叙事文",
  dialogue: "对话体",
};

/* ------------------------------------------------------------------
   v0.9.49 文档体裁签名（自问自答注入门控用）
   ------------------------------------------------------------------
   背景：自问自答（「是不是只有这一种解释？未必，但这一种最直接。」）是
   口语修辞装置，落在公文/总结/学术摘要/致辞里是语体崩。真实案例实测
   （scripts/realcase，默认设置 0.9 档）：
     C1 季度工作总结 → 注入 1 处（缺陷，findings 未修第 5 项）
     C6 学术摘要     → 20/20 seed 全部注入（本轮新发现）
     C20 大会致辞    → 5/13 seed「为什么呢？」+ 2/13「是不是只有这一种解释？未必」
       （v0.9.51 第三批语料新发现；致辞是 main 但签名另立，见 SPEECH_DOC_RE）
     C2 公众号观点文 → 注入正是设计意图（人味装置），必须保留
   而 C1/C2/C6/C20 自动体裁**同为 main**，getGenreKnobs 的体裁旋钮分不开它们
   （实测 classifyGenre：C1/C2/C4/C6/C9/C20 全判 main）⇒ 需要签名级判据。

   三个签名都从项目自己的分类学里长出来，不发明新启发式：
   · OFFICIAL_DOC_RE 是 Rule 4 的 OFFICIAL_RE 的**严格子集**——
   删掉「为了/关于/按照/下一步/根据」五个在非公文散文里也高频的词。
   Rule 4 用的是「密度 ≥0.006 才否决」（防叙事误判），门控要的是
   「一命中就够」：实测 10 篇案例里严格子集只命中 C1（清醒地认识到），
   C2~C10 零命中。
   · ACADEMIC_DOC_RE 收学术/技术论文的不含糊标记（本文/实验结果表明/
   消融实验/基线模型…）。刻意**不收**「验证了/探讨了/阈值/算法」——
   那几个词观点文也用，收了会把 C2 一起误拦。实测只命中 C6（7 处）。
   · SPEECH_DOC_RE（v0.9.51）收致辞/开幕词的场合套语（尊敬的/值此/谨代表/
   预祝…）。与公文签名零重叠——实测 C20 不命中 OFFICIAL_DOC_RE。

   方向与 v0.9.45 的语气词门控一致：宁可少注入，不可错注入。
   误伤的代价是少一处人味装置；漏放的代价是正式稿里出现辩论句式。
------------------------------------------------------------------ */

/** 公文/总结签名（OFFICIAL_RE 严格子集，去除了非公文散文也高频的五个词） */
export const OFFICIAL_DOC_RE =
  /(现将|特此|各单位|各部门|上级部门|认真贯彻|工作目标|工作总结|总结如下|汇报如下|报告如下|主责主业|狠抓|筑牢|工作总基调|在肯定成绩的同时|清醒地认识到)/;

/** 学术/技术文档签名（刻意收紧：只收论文不改写就用、观点文不会用的标记） */
export const ACADEMIC_DOC_RE = /(本文档?|本研究|实验结果表明|消融实验|基线模型|提出了?一种|数据集)/;

/**
 * 致辞/讲话签名（v0.9.51，C20 大会致辞实测新增）。
 *
 * 背景：自问自答在致辞里同样是语体崩——「值此大会召开之际，为什么呢？」
 * 「是不是只有这一种解释？未必」落在开幕词上是事故（实测 5/13 + 2/13 seed）。
 * 致辞与公文的共同点是**场合正式**，但套语系统不同（「尊敬的/谨代表/预祝」
 * 是致辞专属，公文签名一个都不命中）。
 *
 * 方向与另两个签名一致：宁可少注入，不可错注入。误伤的代价是少一处人味装置；
 * 漏放的代价是正式场合的稿子出现辩论句式。
 * 刻意不收「首先/最后/回顾/展望」——观点文（C2）也用，收了会把 C2 一起误拦。
 */
export const SPEECH_DOC_RE =
  /(尊敬的|各位领导|各位来宾|各位同志|值此|谨代表|预祝|表示衷心的感谢|热烈的欢迎|谢谢大家)/;

/**
 * 诉讼文书签名（v0.9.51，C17 判决书实测新增）。
 *
 * 背景：判决书被注入「撤销一审判决，依法改判驳回李某的全部诉讼请求，
 * **这意味着什么？往下看会更清楚。**」——判项后面挂辩论句式，在法律文书里
 * 是事故（13 seed 实测该 seed 命中）。判决书没有致辞套语也没有学术标记，
 * 三个签名都不覆盖 ⇒ 用诉讼文书自己的专属词立签名。
 * 刻意不收「法院/律师/合同」——观点文和新闻也用，收了会误伤 C2/C5。
 */
export const LITIGATION_DOC_RE =
  /(上诉人|被上诉人|民事判决|劳动争议|诉讼请求|本院认为|判决书|裁定书|起诉状)/;

/**
 * 自问自答注入的体裁门控（v0.9.49）：公文/总结/学术摘要/致辞/参数表/诉讼文书
 * 返回 true（不注入）。
 * 判据取**原始输入文本**——签名词可能被管线中途改写（虽然这几个签名里的词
 * 都不在 VOCAB 里，用原文是最稳的），且注入决策本就该看"用户给的是什么稿"。
 */
export function suppressSelfQA(text: string): boolean {
  return (
    OFFICIAL_DOC_RE.test(text) ||
    ACADEMIC_DOC_RE.test(text) ||
    SPEECH_DOC_RE.test(text) ||
    LITIGATION_DOC_RE.test(text) ||
    isSpecTableParagraph(text)
  );
}
