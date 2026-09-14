/// <reference lib="webworker" />
/**
 * 趣AI味 · Web 宿主：WASM 推理跑在 Worker，避免卡 UI 线程。
 *
 * 协议（渲染层 ↔ 本 Worker）：
 *   → { type: "download", mirror? }        ← 进度 { type:"progress", progress }
 *   → { type: "score", windows: string[] }
 *   ← { type: "ok", result } / { type: "error", error }
 * 模型缓存在浏览器 Cache API（transformers.js 默认行为），二次使用离线可用。
 *
 * 打分数学与 Electron 主进程引擎一致：MLM 多位置掩码 + logsumexp，
 * 选点/求值逻辑复用共享内核 scorer-core.ts。
 */
import { MASK_GROUPS, maskGroups, maskedMeanNll, selectTargets } from "./scorer-core.ts";

type Transformers = typeof import("@huggingface/transformers");

interface TokenizeResult {
  input_ids: unknown;
}

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

let lib: Transformers | null = null;

async function getLib(): Promise<Transformers> {
  if (!lib) lib = await import("@huggingface/transformers");
  return lib;
}

interface Ctx {
  model: NonNullable<Awaited<ReturnType<Transformers["AutoModel"]["from_pretrained"]>>>;
  tokenizer: NonNullable<Awaited<ReturnType<Transformers["AutoTokenizer"]["from_pretrained"]>>>;
}

let ctx: Ctx | null = null;

async function ensure(mirror?: string, onProgress?: (p: unknown) => void): Promise<Ctx> {
  if (ctx) return ctx;
  const t = await getLib();
  t.env.remoteHost = mirror || "https://hf-mirror.com";
  t.env.allowLocalModels = true;
  const common = { dtype: "q8" as const, progress_callback: onProgress };
  const model = await t.AutoModel.from_pretrained("Xenova/bert-base-chinese", common);
  const tokenizer = await t.AutoTokenizer.from_pretrained("Xenova/bert-base-chinese", common);
  ctx = { model: model!, tokenizer: tokenizer! };
  return ctx;
}

function toList(x: unknown): number[] | null {
  if (x == null) return null;
  const obj = x as { tolist?: () => unknown[]; data?: ArrayLike<number> };
  if (typeof obj.tolist === "function") {
    const v = obj.tolist();
    return Array.isArray(v) ? (v.flat(Number.POSITIVE_INFINITY) as unknown[]).map(Number) : null;
  }
  if (obj.data != null) return Array.from(obj.data, (n) => Number(n));
  return Array.isArray(x)
    ? ((x as unknown[]).flat(Number.POSITIVE_INFINITY) as unknown[]).map(Number)
    : null;
}

async function scoreWindow(c: Ctx, chars: string[]) {
  const tokenize = c.tokenizer as unknown as (
    s: string,
    o: Record<string, unknown>,
  ) => Promise<TokenizeResult>;
  const encoded = await tokenize(chars.join(""), { add_special_tokens: true });
  const ids = toList(encoded.input_ids);
  if (!ids || ids.length === 0) throw new Error("tokenizer 输出异常");
  const targets = selectTargets(ids);
  if (targets.length === 0) return { meanNll: null, scoredCount: 0 };
  // 分组掩码（镜像 scorer-core.ts 的 MASK_GROUPS/maskGroups）：
  // 组内换 [MASK]、组外保留原文，逐组前向——被掩位置能看见大部分真实上下文，
  // 人机可预测性差异不会被"全掩码"的熵上限抹平；成本是逐位掩码的 1/K。
  const maskId = (c.tokenizer as unknown as { mask_token_id: number }).mask_token_id;
  const TensorCtor = (await getLib()).Tensor;
  let sumNll = 0;
  for (const g of maskGroups(targets, MASK_GROUPS)) {
    const masked = ids.slice();
    for (const tg of g) masked[tg.pos] = maskId;
    const seqLen = masked.length;
    const inputTensor = new TensorCtor("int64", BigInt64Array.from(masked.map((v) => BigInt(v))), [
      1,
      seqLen,
    ]);
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
    const output = (await c.model({
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
  return { meanNll: sumNll / targets.length, scoredCount: targets.length };
}

self.addEventListener("message", (ev: MessageEvent) => {
  const d = ev.data as { type: string; mirror?: string; windows?: string[] };
  (async () => {
    if (d?.type === "download") {
      await ensure(d.mirror, (p) => post({ type: "progress", progress: p }));
      post({ type: "ok", result: { ok: true } });
      return;
    }
    if (d?.type === "score") {
      const wins = Array.isArray(d.windows) ? d.windows : null;
      if (!wins || wins.some((w) => typeof w !== "string")) {
        post({ type: "error", error: "参数必须是字符串数组" });
        return;
      }
      const c = await ensure();
      const results = [];
      for (const w of wins) results.push(await scoreWindow(c, [...w]));
      post({ type: "ok", result: { ok: true, results } });
      return;
    }
    post({ type: "error", error: "未知消息类型：" + String(d?.type) });
  })().catch((e: unknown) => {
    post({ type: "error", error: e instanceof Error ? e.message : String(e) });
  });
});

post({ type: "ready" });
