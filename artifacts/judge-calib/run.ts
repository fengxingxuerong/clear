/**
 * judge-calib/run.ts —— 裁判校准：量 LLM 当"病句裁判"的召回率与误报率
 *
 * 用法：
 *   npx tsx artifacts/judge-calib/run.ts                          # 默认 v2（逐句编号）
 *   JUDGE_VARIANT=v1 npx tsx artifacts/judge-calib/run.ts          # 首轮的开放发现版
 *   JUDGE_VARIANT=v1-loose npx tsx artifacts/judge-calib/run.ts    # 宽松指令
 *   JUDGE_MODEL=deepseek-v4-flash npx tsx artifacts/judge-calib/run.ts
 *   JUDGE_CONCURRENCY=2 JUDGE_GAP_MS=1200 npx tsx artifacts/judge-calib/run.ts
 *
 * ## v1 → v2 的改动理由（不是为了"调 prompt 调高分"）
 *
 * v1 的两个结构性缺陷，实测暴露：
 *   ① **判定靠字符串模糊匹配**：裁判复述原句时改了标点或被截断就判不中；
 *      更糟的是"定位偏移"（发现了问题但指到相邻句）会被当成漏报丢掉。
 *   ② **开放发现 = 只挑明显的**：单句读着通顺的结构性缺陷（承前省略、指代悬空）
 *      它一条都不报——因为"扫一眼找别扭"这个动作天然看不见它们。
 *
 * v2 的两个对应修法：
 *   ① 输入**逐句编号**，裁判只需回答"第几句有问题" ⇒ 判定变成编号对齐，定位偏移
 *      能被正确识别为"报错句号"而不是"漏报"。
 *   ② 给**通用编辑学六维清单**（成分/搭配/语体/指代/标点/冗余）并要求逐句给结论
 *      ⇒ 强制覆盖每一句。⚠️ 清单刻意用通用编辑学维度、**不列我们的探针名**——
 *      列了就等于把答案喂进去，测出来的是"分类能力"而非"发现能力"。
 *
 * ## 判据
 *
 *   · defect（22 条）：v2 看 issues 里是否点到缺陷句号；v1 看引用句与 frag 的
 *     最长公共子串（阈值随 frag 长度自适应，见下方注释）
 *   · clean（6 条）：issues 为空 → 正确；报了 → 误报（比漏报更危险）
 *
 * Key 只从 scripts/.sensenova-keys 读入内存，**绝不打印**（含前缀/长度/指纹）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chat } from "../../src/api/llm-chat.ts";
import type { ApiConfig } from "../../src/api/llm-config.ts";
import { CASES, analyze, normalize, type Case } from "./cases.ts";

const MODEL = process.env.JUDGE_MODEL || "glm-5.2";
const VARIANT = process.env.JUDGE_VARIANT || "v2";
const CONCURRENCY = Math.max(1, parseInt(process.env.JUDGE_CONCURRENCY || "3", 10));
const GAP_MS = Math.max(0, parseInt(process.env.JUDGE_GAP_MS || "500", 10));

const PROMPT_V1_STRICT = `你是中文文字编辑，现在要审一段稿子。这段文字可能是机器改写后的产物，也可能完全是人写的，两种都可能。

请逐句检查：有没有读起来不顺、成分残缺、搭配不当、语义重复、或者明显不像人写的句子。

规则：
1. 只报你确信有问题的句子。不确定的不要报，宁可漏报，不要凑数。
2. 整段没有问题就返回空数组，这是完全正常的回答。
3. sentence 字段必须是原文中的句子，逐字复制，不许改写、不许拼接。
4. type 用 2~8 字的简短标签，自拟。reason 一句话说明。

只输出 JSON，不要任何其他文字：
{"issues":[{"sentence":"...","type":"...","reason":"..."}]}`;

const PROMPT_V1_LOOSE = `你是中文文字编辑，现在要审一段稿子。这段文字可能是机器改写后的产物，也可能完全是人写的。

请把所有读起来不顺、成分残缺、搭配不当、语义重复、或明显不像人写的句子都找出来。

规则：
1. sentence 字段必须是原文中的句子，逐字复制，不许改写。
2. type 用 2~8 字的简短标签，自拟。reason 一句话说明。
3. 没有问题的段落返回空数组。

只输出 JSON，不要任何其他文字：
{"issues":[{"sentence":"...","type":"...","reason":"..."}]}`;

const PROMPT_V2 = `你是资深中文文字编辑，现在要审一段稿子。稿子已经按句切好并编了号。这段文字可能是机器改写后的产物，也可能完全是人写的，两种都可能。

【审查方法】逐句过一遍，对每一个编号都给出结论。检查这六个维度：

1. 成分完整——缺主语 / 缺谓语 / 缺宾语。
   特别注意：**后一句如果必须依赖前一句的主语才能读懂，它本身就是缺主语**。
2. 搭配成立——动词与宾语、修饰语与中心语是否搭得上。
3. 语体统一——口语词、网络语、公文套话是否与全篇语体冲突。
4. 指代明确——其 / 这 / 该 / 此 有没有清楚的先行词。
5. 标点规范——引语收尾、顿号与逗号的区别、句号是否切断了本该连在一起的成分。
6. 冗余重复——叠字、同义反复、刻意堆出来的平行结构。

【输出】严格按这个 JSON 结构，不要任何其他文字：
{"checks":[{"i":1,"ok":true},{"i":2,"ok":false}],"issues":[{"i":2,"type":"缺主语","reason":"一句话理由"}]}

要点：
- checks 必须覆盖每一个编号，一个都不能漏。
- ok=false 的句子必须在 issues 里出现，且 i 必须是该句编号。
- type 用 2~6 字。reason 一句话。
- 整段没问题时 checks 全 true、issues 为空数组，这是完全正常的回答。`;

const PROMPT =
  VARIANT === "v1" ? PROMPT_V1_STRICT : VARIANT === "v1-loose" ? PROMPT_V1_LOOSE : PROMPT_V2;

/** 最长公共**连续**子串长度（去标点空白后比较）——v1 的判定用 */
function lcs(a: string, b: string): number {
  const s = normalize(a);
  const t = normalize(b);
  if (!s || !t) return 0;
  let best = 0;
  const dp = new Array<number>(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i++) {
    let prev = 0;
    for (let j = 1; j <= t.length; j++) {
      const cur = dp[j];
      dp[j] = s[i - 1] === t[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = cur;
    }
  }
  return best;
}

/** LLM 常把 JSON 包在 ```json 里或加解释——取第一个平衡的 {...} 块 */
function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const keys = readFileSync("scripts/.sensenova-keys", "utf-8").trim().split(/\s+/).filter(Boolean);
console.log(
  `[judge-calib] 模型=${MODEL} 变体=${VARIANT} 并发=${CONCURRENCY} 间隔=${GAP_MS}ms 夹具=${CASES.length} 条`,
);
if (keys.length === 0) {
  console.error("没读到 Key（scripts/.sensenova-keys）");
  process.exit(1);
}

const cfg: ApiConfig = {
  enabled: true,
  baseUrl: "https://token.sensenova.cn/v1",
  apiKey: keys[0],
  apiKeys: keys.join("\n"),
  model: MODEL,
  temperature: 0,
  deepMode: false,
  judgeModel: MODEL,
  altModel: "",
  style: "plain",
  maxWaitSeconds: 120,
  maxApiCalls: 0,
};

interface Row {
  id: string;
  kind: "defect" | "clean";
  probe?: string;
  /** v2 用：缺陷句编号（1 基） */
  defectIdx?: number | null;
  reported: number;
  hit: boolean | null;
  /** v2：裁判报出的句号列表；v1：最佳 LCS */
  pointedIdx?: number[];
  lcsBest?: number;
  sample: string;
  raw: string;
  error?: string;
}

const isV2 = VARIANT === "v2";
const buildInput = (c: Case, sentences: string[]) =>
  isV2 ? sentences.map((s, i) => `${i + 1}. ${s}`).join("\n") : c.text;

async function judgeOne(c: Case): Promise<Row> {
  const { sentences, defectIdx } = analyze(c);
  const row: Row = {
    id: c.id,
    kind: c.kind,
    probe: c.probe,
    defectIdx,
    reported: 0,
    hit: null,
    pointedIdx: [],
    lcsBest: 0,
    sample: "",
    raw: "",
  };
  try {
    const r = await chat(
      cfg,
      [
        { role: "system", content: PROMPT },
        { role: "user", content: buildInput(c, sentences) },
      ],
      // v2 要输出"覆盖每句的 checks + issues"，比 v1 的纯 issues 长得多。
      // 实测 3000 时 4/28 条返回**空 content**（raw 长度 0，不是 JSON 格式错）——
      // 推理开销吃光了额度，正文还没开始写就结束了。给到 8000。
      { temperature: 0, maxTokens: 8000 },
    );
    row.raw = r.content;
    if (!r.content.trim()) {
      row.error = `空响应（reasoning ${r.reasoning?.length ?? 0} 字，疑被 maxTokens 截断）`;
      return row;
    }
    const parsed = extractJson(r.content);
    if (!parsed) {
      row.error = "JSON 解析失败";
      return row;
    }
    const issues = (Array.isArray(parsed.issues) ? parsed.issues : []) as {
      i?: number;
      sentence?: string;
      type?: string;
      reason?: string;
    }[];
    row.reported = issues.length;
    row.pointedIdx = issues.map((x) => x.i).filter((x): x is number => typeof x === "number");

    if (c.kind === "clean") {
      row.hit = issues.length === 0;
      if (issues.length) row.sample = (issues[0].sentence ?? `第${issues[0].i}句`).slice(0, 34);
      return row;
    }
    if (isV2) {
      row.hit = defectIdx != null && row.pointedIdx.includes(defectIdx);
      if (!row.hit && issues.length) row.sample = `报了第 ${row.pointedIdx.join(",")} 句`;
    } else {
      const frag = c.frag ?? "";
      for (const it of issues) {
        const best = Math.max(
          lcs(it.sentence ?? "", frag),
          lcs(it.reason ?? "", frag),
          lcs(it.type ?? "", frag),
        );
        if (best > (row.lcsBest ?? 0)) {
          row.lcsBest = best;
          row.sample = (it.sentence ?? "").slice(0, 40);
        }
      }
      // ⚠️ 阈值随 frag 长度自适应：固定 ≥4 时「看看看」「首先。」去标点只有 2~3 字，
      //    永远达不到 ⇒ 裁判明明报对了却被判漏报（2026-10-14 首轮实测，3 条假阴性）。
      row.hit = (row.lcsBest ?? 0) >= Math.min(4, normalize(frag).length);
    }
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
  }
  return row;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pool<T, R>(
  items: T[],
  n: number,
  fn: (x: T) => Promise<R>,
  gap: number,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
        if (gap) await sleep(gap);
      }
    }),
  );
  return out;
}

const t0 = Date.now();
const rows = await pool(CASES, CONCURRENCY, judgeOne, GAP_MS);

const defects = rows.filter((r) => r.kind === "defect");
const cleans = rows.filter((r) => r.kind === "clean");
const dErr = defects.filter((r) => r.error).length;
const cErr = cleans.filter((r) => r.error).length;
const dOk = defects.length - dErr;
const cOk = cleans.length - cErr;
const recall = defects.filter((r) => r.hit).length;
const cleanOk = cleans.filter((r) => r.hit === true).length;
const falseAlarm = cleans.filter((r) => r.hit === false).length;

console.log(`\n━━━ 缺陷案召回 ${recall}/${defects.length} ━━━`);
for (const r of defects) {
  const mark = r.error ? "ERR" : r.hit ? "✅" : "❌";
  const detail = isV2
    ? `缺陷句=${r.defectIdx ?? "?"} 裁判报=${r.pointedIdx?.length ? r.pointedIdx.join(",") : "无"}`
    : `LCS=${r.lcsBest}`;
  console.log(`  ${mark} ${r.id.padEnd(22)} ${detail} ｜ ${r.sample}`);
}
console.log(`\n━━━ 干净稿对照 ${cleanOk}/${cOk} 未误报 ━━━`);
for (const r of cleans) {
  const mark = r.error ? "ERR" : r.hit ? "✅" : "⚠️误报";
  console.log(
    `  ${mark} ${r.id.padEnd(22)} 报${r.reported}条${r.sample ? ` ｜「${r.sample}」` : ""}`,
  );
}
// ⚠️ 分母要扣掉 ERR：调用失败既不是命中也不是漏报，混进去会把"接口没回话"
//    读成"裁判能力差"（v0.9.44 首跑就踩了：误报被算成 1/6，实际是 1 条空响应）。
console.log(
  `\n汇总：召回 ${recall}/${dOk}（${dOk ? ((recall / dOk) * 100).toFixed(0) : "-"}%，含 ERR ${dErr} 条不计）｜` +
    `误报 ${falseAlarm}/${cOk}（含 ERR ${cErr} 条不计）｜耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
const errs = rows.filter((r) => r.error);
if (errs.length)
  console.log(
    `⚠️ 调用失败 ${errs.length} 条：\n  ${errs.map((r) => r.id + "：" + (r.error ?? "").slice(0, 46)).join("\n  ")}`,
  );

mkdirSync("artifacts/judge-calib/results", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = `artifacts/judge-calib/results/${stamp}-${MODEL}-${VARIANT}.json`;
writeFileSync(
  outFile,
  JSON.stringify(
    {
      model: MODEL,
      variant: VARIANT,
      prompt: PROMPT,
      recall,
      total: defects.length,
      cleanOk,
      cleanTotal: cleans.length,
      rows,
    },
    null,
    2,
  ),
);
console.log(`\n原始响应已落盘：${outFile}`);
