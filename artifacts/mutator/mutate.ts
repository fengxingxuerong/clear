/**
 * mutator/mutate.ts —— 变异器：把**真人写的文字**反向改写成 AI 腔，产出标注对
 *
 * 用法：npx tsx artifacts/mutator/mutate.ts
 *
 * ## 为什么这条路线比"LLM 当裁判"值钱
 *
 * 裁判路线有个绕不过的死结：**裁判本身有没有偏**（本项目 check:publish 18 点
 * 认证 0/18 就是这个问题）。而变异器产出的是**带真值的数据**：
 *
 *     人写原文        → 真值「像人」   （来自人工标定的棘轮样本，不是引擎产物）
 *     变异后的 AI 化稿 → 真值「像机器」 （LLM 人工注入了 AI 腔）
 *
 * 有了真值对，就能直接问一个**可客观验证**的问题：
 *
 *     aiScore 能不能把这两类分开？（单调性 / 区分力）
 *
 * 这不需要任何裁判的主观判断——aiScore 是本地确定性函数，跑一万次结果一样。
 *
 * ## 输入口径（关键，别搞错）
 *
 * 只用 `scripts/calibration-data-v2-genres.json` 里 level="原文" 且
 * genre ∈ {narrative, dialogue, humanHand} 的段落——它们是被人工标定过的
 * **真人文本**。engine 产出的稿子不能当"人写"真值（那等于自己给自己发证书）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chat } from "../../src/api/llm-chat.ts";
import type { ApiConfig } from "../../src/api/llm-config.ts";

const MODEL = process.env.MUT_MODEL || "deepseek-v4-flash";
const TEMP = Number(process.env.MUT_TEMP || "0.7");
const CONCURRENCY = Math.max(1, parseInt(process.env.MUT_CONCURRENCY || "2", 10));
const GAP_MS = Math.max(0, parseInt(process.env.MUT_GAP_MS || "1000", 10));
/**
 * 多次采样：把「变异档位」和「采样随机性」两个因素分开。
 *
 * 首轮每档只跑 1 次（temp=0.7），得到 9 对里 4 对方向反转——但这两种解释无法区分：
 *   ① aiScore 对"AI 化"真的没有稳定响应（尺子有问题）
 *   ② 单次变异恰好改得不够/过头（采样运气）
 * 多采样能分开：同一 (体裁, 档位) 下若方向**稳定反转**，就是 ①。
 *
 * ⚠️ 叫 run 不叫 seed：`chat()` 的 opts 没有 seed 字段（OpenAI 兼容网关也未必支持），
 *    LLM 侧**无法复现**，只能靠落盘留存。能复现的只有本地引擎那部分（humanize 有 seed）。
 */
const RUNS = (process.env.MUT_RUNS || "1")
  .split(",")
  .map((s) => parseInt(s, 10))
  .filter((n) => Number.isFinite(n));

const BASE = `下面是一段真人写的文字。请把它改写成典型的中文 AI 生成文风。

硬性要求（不许违反）：
- 事实、数字、人名、地名、事件一律不许改动，不许新增或删除信息点
- 只输出改写后的正文，不要任何说明、不要 markdown 标题、不要引号包裹`;

const LEVELS: Record<string, string> = {
  light: `${BASE}

改写幅度：**轻度**
- 替换一部分词为 AI 高频书面语（如 重要的是 / 因此 / 显著 / 有效提升）
- 保留大部分具体细节与原句节奏
- 篇幅与原文相当`,
  medium: `${BASE}

改写幅度：**中度**
- 较多使用 AI 套话：值得注意的是、不仅…而且…、综上所述、与此同时、在…的背景下、具有重要意义
- 句式改为工整对称，适度使用平行结构
- 把部分具体细节抽象化、概括化
- 每段开头用概括性总起句
- 去掉个人化表达与口语`,
  heavy: `${BASE}

改写幅度：**重度**
- 通篇使用 AI 套话与抽象名词，几乎不留具体细节（例如把「五块钱一碗」改成「价格较为亲民」）
- 每段严格三句：总起句 + 展开句 + 总结句
- 大量使用「不仅…而且…」「一方面…另一方面…」式平行结构
- 结尾必加「综上所述」式总结
- 彻底去掉个人口吻与情绪`,

  // ---- v2（2026-10-14）：把 heavy 档的**两个冲突目标拆开** ----
  //
  // 观测：27 对里刻度 3/3 非单调（轻 < 中 > 重），而成分表显示 heavy 档的
  // formulaicHits **反而少于 medium**（纯人写稿 0→8→4）。两种解释：
  //   ① aiScore 对"AI 化程度"的刻度本身非单调（尺子的错）
  //   ② heavy 指令里"堆套话"与"每段三句/彻底去个人口吻"**互相冲突**，
  //      LLM 顾此失彼、套话被稀释 ⇒ 非单调是**变异器**造的（不是尺子）
  // 拆法：造两个新档，让「套话」成为唯一变量——
  //   heavyA 只加套话、不碰句式 ⇒ 若 aiScore 随之单调上升，则 ② 成立
  //   heavyB 只改句式、**明令禁套话** ⇒ 若 aiScore 不上升，坐实结构维度是盲区
  heavyA: `${BASE}

改写幅度：**套话加量档**
- 大量注入 AI 高频套话：值得注意的是、不仅…而且…、综上所述、与此同时、在…的背景下、
  具有重要意义、进一步地、需要指出的是、值得注意的是、赋能、闭环
- **保持原有的句子结构、细节与段落划分不变**，只往里塞套话
- 篇幅比原文长 30% 左右`,
  heavyB: `${BASE}

改写幅度：**句式工整档**
- 把句子改得工整对称：多用三句式与「一方面…另一方面…」平行结构，每段收束
- 把口语化表达改成书面表达
- **绝对禁止使用任何套话词**：不得出现 值得注意的是 / 综上所述 / 与此同时 /
  不仅…而且 / 具有重要意义 / 需要指出的是 / 赋能 / 闭环 / 底层逻辑 / 在…的背景下
- 保持事实与具体细节不变`,
};

interface Sample {
  genre: string;
  level: string;
  text: string;
}

const all = JSON.parse(readFileSync("scripts/calibration-data-v2-genres.json", "utf8")) as Sample[];
const humans = all.filter(
  (r) => r.genre === "narrative" || r.genre === "dialogue" || r.genre === "humanHand",
);

// 每个体裁只取 level="原文" / "无处理" 的那一份（humanHand 的原文即"纯人写稿(无处理)"）
const seen = new Set<string>();
const HUMAN_SET: Sample[] = [];
for (const r of humans) {
  if (seen.has(r.genre)) continue;
  if (r.level.includes("原文") || r.level.includes("无处理")) {
    seen.add(r.genre);
    HUMAN_SET.push(r);
  }
}
if (HUMAN_SET.length === 0) {
  console.error(
    `没找到真人原文。可用组合：${[...new Set(humans.map((r) => `${r.genre}|${r.level}`))].join(" / ")}`,
  );
  process.exit(1);
}
console.log(
  `真人文本 ${HUMAN_SET.length} 段：${HUMAN_SET.map((h) => `${h.genre}(${h.text.length}字)`).join("、")}`,
);

/** 只跑指定档位（MUT_LEVELS=heavyA,heavyB）—— 拆因实验时省额度 */
const ONLY = (process.env.MUT_LEVELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const USE_LEVELS = ONLY.length
  ? Object.keys(LEVELS).filter((l) => ONLY.includes(l))
  : Object.keys(LEVELS);
if (USE_LEVELS.length === 0) {
  console.error(
    `MUT_LEVELS=${ONLY.join(",")} 与可用档位无交集。可用：${Object.keys(LEVELS).join(",")}`,
  );
  process.exit(1);
}
console.log(
  `变异档位 ${USE_LEVELS.length}：${USE_LEVELS.join("/")}｜采样 ${RUNS.length} 次/档｜模型=${MODEL} temp=${TEMP}｜共 ${HUMAN_SET.length * USE_LEVELS.length * RUNS.length} 次调用`,
);

const keys = readFileSync("scripts/.sensenova-keys", "utf-8").trim().split(/\s+/).filter(Boolean);
const cfg: ApiConfig = {
  enabled: true,
  baseUrl: "https://token.sensenova.cn/v1",
  apiKey: keys[0],
  apiKeys: keys.join("\n"),
  model: MODEL,
  temperature: TEMP,
  deepMode: false,
  judgeModel: "",
  altModel: "",
  style: "plain",
  maxWaitSeconds: 120,
  maxApiCalls: 0,
};

interface Pair {
  genre: string;
  level: string;
  /** 第几次采样（1 基）。LLM 侧不可复现，仅用于标识与方差分析 */
  run: number;
  human: string;
  variant: string;
  humanLen: number;
  variantLen: number;
  /** 推理型模型的思考长度——空响应的根因诊断（2026-10-14 实测见下） */
  reasoningLen?: number;
  error?: string;
}

/**
 * ⚠️ maxTokens 必须给得宽：本网关（token.sensenova.cn）上的模型是**重推理型**
 * （glm-5.2 / deepseek-v4-flash 实测），指令越细，思考越长。
 * 首次跑 medium/heavy 全 9 条里空 7 条——不是限流（light 档正常返回），
 * 是 4000 额度被 reasoning 吃光，正文一个字都没写。
 * 裁判 v2 那轮同样症状（reasoning 11380~11965 字）。→ 给到 12000，
 * 并把 reasoning 长度落盘，下次再空能直接看是不是同一个原因。
 */
const MAX_TOKENS = Number(process.env.MUT_MAXTOKENS || "12000");

const jobs: { genre: string; level: string; run: number; human: string }[] = [];
for (const h of HUMAN_SET)
  for (const lv of USE_LEVELS)
    for (const rn of RUNS) jobs.push({ genre: h.genre, level: lv, run: rn, human: h.text });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function run(job: (typeof jobs)[number]): Promise<Pair> {
  const p: Pair = {
    genre: job.genre,
    level: job.level,
    run: job.run,
    human: job.human,
    variant: "",
    humanLen: job.human.length,
    variantLen: 0,
  };
  try {
    const r = await chat(
      cfg,
      [
        { role: "system", content: LEVELS[job.level] },
        { role: "user", content: job.human },
      ],
      { temperature: TEMP, maxTokens: MAX_TOKENS },
    );
    p.variant = r.content.trim();
    p.variantLen = p.variant.length;
    p.reasoningLen = r.reasoning?.length ?? 0;
    if (!p.variant) p.error = `空响应（reasoning ${p.reasoningLen} 字）`;
  } catch (e) {
    p.error = e instanceof Error ? e.message : String(e);
  }
  return p;
}

const out = new Array<Pair>(jobs.length);
let i = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (i < jobs.length) {
      const k = i++;
      out[k] = await run(jobs[k]);
      const m = out[k].variant ? "✅" : "❌";
      console.log(
        `  ${m} ${jobs[k].genre}/${jobs[k].level}/r${jobs[k].run}  ${out[k].humanLen}→${out[k].variantLen} 字` +
          `  reasoning=${out[k].reasoningLen ?? 0}${out[k].error ? " ｜" + out[k].error.slice(0, 30) : ""}`,
      );
      if (GAP_MS) await sleep(GAP_MS);
    }
  }),
);

mkdirSync("artifacts/mutator/pairs", { recursive: true });
for (const p of out) {
  if (!p.variant) continue;
  const suffix = RUNS.length > 1 ? `-r${p.run}` : "";
  writeFileSync(
    `artifacts/mutator/pairs/${p.genre}-${p.level}${suffix}.txt`,
    `【人写原文｜真值=像人】\n${p.human}\n\n【AI 化变异｜真值=像机器】(run ${p.run})\n${p.variant}\n`,
  );
}
// ⚠️ 只跑子档时**不能覆盖**已有的 pairs.json（那是 5 档 27 对的数据）：
// 拆因实验的结果单独落一个文件，measure.ts 用 MUT_PAIRS 指定读哪个。
const OUT_JSON = process.env.MUT_OUT || "artifacts/mutator/pairs.json";
writeFileSync(
  OUT_JSON,
  JSON.stringify({ model: MODEL, temp: TEMP, runs: RUNS, levels: USE_LEVELS, pairs: out }, null, 2),
);
const ok = out.filter((p) => p.variant).length;
console.log(`\n产出 ${ok}/${out.length} 对 → ${OUT_JSON}`);
