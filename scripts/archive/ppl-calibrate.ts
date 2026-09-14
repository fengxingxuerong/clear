/**
 * 趣AI味 · 第 8 项困惑度阈值标定脚本（真实 ONNX 推理，CI 之外手动运行）
 *
 * 用法：npx tsx scripts/ppl-calibrate.ts
 * 说明：
 *   - 首次运行会从镜像站下载约 100MB 的 int8 模型缓存到 ./.cache，之后离线可用；
 *   - 打分数学与 src/ppl/ppl-worker.ts 同构（MLM 多位置掩码 + logsumexp），
 *     选点/求值复用共享内核 scorer-core.ts；
 *   - 输出人工写作组与 AI 生成组的 meanNll / 窗间σ 分布，
 *     对照 engine/humanize-metrics.ts 中当前常量给出复核结论。
 */
import {
  MASK_GROUPS,
  aggregateText,
  maskGroups,
  maskedMeanNll,
  nllToPerplexity,
  selectTargets,
} from "../src/ppl/scorer-core.ts";
import type { PplWindow } from "../src/ppl/scorer-core.ts";
import {
  PPL_MAX_WIN_STD,
  PPL_MIN_CHARS,
  PPL_MIN_MEAN_NLL,
  PPL_MIN_WINDOWS,
} from "../src/engine/humanize-metrics.ts";

/* ------------- 标定语料：scripts/calibrate/{human,ai}/*.txt，文件名即样本标签 ------------- */
// 想扩充样本直接往对应目录丢 .txt 文件即可，无需改代码；两组样本量不必相等。

import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadCorpus(dirName: string): Array<{ label: string; text: string }> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "calibrate", dirName);
  if (!fsSync.existsSync(dir)) throw new Error(`缺少语料目录: ${dir}`);
  return fsSync
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".txt"))
    .sort()
    .map((f) => ({
      label: f.replace(/\.txt$/i, ""),
      text: fsSync.readFileSync(path.join(dir, f), "utf8").trim(),
    }));
}

const HUMAN = loadCorpus("human");
const AI = loadCorpus("ai");
if (HUMAN.length === 0 || AI.length === 0) {
  throw new Error(`标定语料不足：human=${HUMAN.length} 篇，ai=${AI.length} 篇`);
}

/* ---------------- 推理部分（与 ppl-worker.ts 的 scoreWindow 同构） ---------------- */

interface TokenizeResult {
  input_ids: unknown;
}
type TokenizerLike = (s: string, o: Record<string, unknown>) => Promise<TokenizeResult>;

function toList(x: unknown): number[] | null {
  if (x == null) return null;
  const obj = x as { tolist?: () => unknown[]; data?: ArrayLike<number> };
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

async function scoreWindow(
  model: { (input: unknown): Promise<unknown> },
  tokenize: TokenizerLike,
  maskId: number,
  chars: string[],
): Promise<PplWindow | null> {
  const encoded = await tokenize(chars.join(""), { add_special_tokens: true });
  const ids = toList(encoded.input_ids);
  if (!ids || ids.length === 0) throw new Error("tokenizer 输出异常");
  const targets = selectTargets(ids);
  if (targets.length === 0) return null;
  // 分组掩码（与 scorer-core.ts / 引擎一致）：组内掩、组外保留原文
  const t = await import("@huggingface/transformers");
  const TensorCtor = t.Tensor;
  let sumNll = 0;
  for (const g of maskGroups(targets, MASK_GROUPS)) {
    const masked = ids.slice();
    for (const tg of g) masked[tg.pos] = maskId;
    const seqLen = masked.length;
    const inputTensor = new TensorCtor(
      "int64",
      BigInt64Array.from(masked.map((v) => BigInt(v))),
      [1, seqLen],
    );
    const attnTensor = new TensorCtor(
      "int64",
      BigInt64Array.from({ length: seqLen }, () => 1n),
      [1, seqLen],
    );
    const typeTensor = new TensorCtor(
      "int64",
      BigInt64Array.from({ length: seqLen }, () => 0n),
      [1, seqLen],
    );
    const output = (await model({
      input_ids: inputTensor,
      attention_mask: attnTensor,
      token_type_ids: typeTensor,
    })) as unknown as {
      logits: { dims: number[]; data: ArrayLike<number> };
    };
    const lg = output.logits;
    if (!lg || !lg.dims || lg.data == null) throw new Error("模型输出缺少 logits");
    const vocab = Number(lg.dims[lg.dims.length - 1]);
    // 内核 maskedMeanNll 返回的是"组内均值"；乘回组大小还原为该组贡献的总 NLL，
    // 外层再除以 targets.length 即得按目标数严格加权的全局均值。
    sumNll += maskedMeanNll(lg.data, lg.dims[1], vocab, g) * g.length;
  }
  return {
    charStart: 0,
    charEnd: 0,
    scoredCount: targets.length,
    meanNll: sumNll / targets.length,
  };
}

async function scoreText(
  model: { (input: unknown): Promise<unknown> },
  tokenize: TokenizerLike,
  maskId: number,
  text: string,
) {
  const chars: string[] = [];
  const offsets: Array<[number, number]> = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    chars.push(text[i]);
    offsets.push([i, i + 1]);
  }
  const wins: Array<{ chars: string[] }> = [];
  let start = 0;
  while (start < chars.length) {
    const end = Math.min(start + 384, chars.length);
    wins.push({ chars: chars.slice(start, end) });
    if (end >= chars.length) break;
    start += 320;
  }
  const windows: PplWindow[] = [];
  for (const w of wins) {
    const r = await scoreWindow(model, tokenize, maskId, w.chars);
    if (r) windows.push(r);
  }
  return aggregateText(windows);
}

/* ---------------- 主流程 ---------------- */

interface Row {
  label: string;
  chars: number;
  meanNll: number;
  ppl: number;
  winStd: number;
  windows: number;
}

function summarize(name: string, rows: Row[]) {
  const meanNlls = rows.map((r) => r.meanNll);
  const stds = rows.map((r) => r.winStd);
  const min = Math.min(...meanNlls);
  const max = Math.max(...meanNlls);
  const avg = meanNlls.reduce((a, b) => a + b, 0) / rows.length;
  console.log(`\n【${name}】共 ${rows.length} 篇`);
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(10, "　")} 字数=${String(r.chars).padStart(4)}  窗数=${r.windows}  ` +
        `meanNll=${r.meanNll.toFixed(3)} nat  PPL=${r.ppl.toFixed(1)}  窗间σ=${r.winStd.toFixed(3)}`,
    );
  }
  console.log(
    `  ↳ meanNll 分布 min=${min.toFixed(3)} avg=${avg.toFixed(3)} max=${max.toFixed(3)}；窗间σ max=${Math.max(...stds).toFixed(3)}`,
  );
  return { min, max, avg };
}

async function main() {
  const t = await import("@huggingface/transformers");
  t.env.remoteHost = "https://hf-mirror.com";
  t.env.allowLocalModels = true;
  console.log("加载模型 Xenova/bert-base-chinese（int8）…首次运行会下载约 100MB");
  const common = {
    dtype: "q8" as const,
    progress_callback: (p: unknown) => {
      const o = p as { status?: string; file?: string; progress?: number };
      if (o?.status === "progress" && typeof o.progress === "number" && typeof document === "undefined") {
        process.stdout.write(`\r  下载 ${o.file ?? ""} ${o.progress.toFixed(0)}%        `);
      }
    },
  };
  const model = await t.AutoModel.from_pretrained("Xenova/bert-base-chinese", common);
  const tokenizer = await t.AutoTokenizer.from_pretrained("Xenova/bert-base-chinese", common);
  if (!model || !tokenizer) throw new Error("模型或分词器加载失败");
  console.log("\n模型就绪，开始逐篇打分…\n");

  const maskId = (tokenizer as unknown as { mask_token_id: number }).mask_token_id;
  const tokenize = tokenizer as unknown as TokenizerLike;
  const callModel = (input: unknown) => model(input);

  const humanRows: Row[] = [];
  const aiRows: Row[] = [];
  for (const [group, list, sink] of [
    ["人工写作组", HUMAN, humanRows],
    ["AI 生成组", AI, aiRows],
  ] as const) {
    for (const item of list) {
      const f = await scoreText(callModel, tokenize, maskId, item.text);
      sink.push({
        label: item.label,
        chars: f.scoredChars,
        meanNll: f.meanNll,
        ppl: nllToPerplexity(f.meanNll),
        winStd: f.winStd,
        windows: f.windows.length,
      });
      void group;
    }
  }

  const h = summarize("人工写作组", humanRows);
  const a = summarize("AI 生成组", aiRows);

  console.log("\n=== 阈值复核（当前常量）===");
  console.log(`PPL_MIN_MEAN_NLL = ${PPL_MIN_MEAN_NLL} nat`);
  console.log(`PPL_MAX_WIN_STD  = ${PPL_MAX_WIN_STD}`);
  console.log(`PPL_MIN_CHARS    = ${PPL_MIN_CHARS}`);
  console.log(`PPL_MIN_WINDOWS  = ${PPL_MIN_WINDOWS}`);

  console.log("\n=== 建议通道 ===");
  const gapLow = Math.max(h.min, a.min);
  const gapHigh = Math.min(h.max, a.max);
  if (a.max < h.min) {
    const mid = (a.max + h.min) / 2;
    console.log(`两组完全线性可分：AI 组 max(${a.max.toFixed(3)}) < 人工组 min(${h.min.toFixed(3)})`);
    console.log(`建议 PPL_MIN_MEAN_NLL 取区间中点 ≈ ${mid.toFixed(2)} nat`);
  } else if (gapHigh > gapLow) {
    console.log(
      `两组存在重叠区 [${gapLow.toFixed(2)}, ${gapHigh.toFixed(2)}]，均值阈值取重叠区内并接受少量误报`,
    );
  } else {
    console.log(`两组分布交叉严重，均值通道只能作为弱信号（当前 ${PPL_MIN_MEAN_NLL} nat 是否合适需人工判断）`);
  }
  console.log(
    `窗间σ通道：AI 组 max=${Math.max(...aiRows.map((r) => r.winStd)).toFixed(3)}，人工组 max=${Math.max(...humanRows.map((r) => r.winStd)).toFixed(3)}（样本量小，仅作参考）`,
  );
}

main().catch((e: unknown) => {
  console.error("\n标定失败：", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
