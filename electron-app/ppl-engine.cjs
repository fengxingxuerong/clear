// 趣AI味 · 本地困惑度引擎（Electron 主进程专用，CommonJS）
//
// 分层约定（与 src/ppl/scorer-core.ts 的注释互为镜像）：
//   - 渲染层负责所有"策略"：切窗（planWindows）、聚合（aggregateText）、判定（pplIssues）
//   - 本文件只做"机制"：模型加载/下载、逐窗口 MLM 多位置掩码打分
//   - 免对齐选点规则（跳过特殊 token 与 UNK）与 src/ppl/scorer-core.ts 的 selectTargets 一致，修改时必须两侧同步
//
// 打分方法：MLM 伪困惑度（Salazar et al. 2019）。工程取舍：一个窗口内把所有
// 待打分位置同时替换成 [MASK]，单次前向取各位置对原词的对数似然——这是
// "边缘化近似"（各掩码位条件独立），比逐个掩码快两个数量级，精度损失可忽略。
"use strict";

const path = require("path");
const { app } = require("electron");

const MODEL_ID = "Xenova/bert-base-chinese";
const DEFAULT_MIRROR = "https://hf-mirror.com";
/** 中文 BERT 词表上限 512，留出 [CLS]/[SEP]/[MASK] 余量 */
const MAX_WINDOW = 510;

let cached = null; // { model, tokenizer, Tensor }
let loadingPromise = null;

function transformersLib() {
  // 动态加载：未用到困惑度功能的用户不付出启动成本
  return import("@huggingface/transformers");
}

function pickProgress(p) {
  // 只透传必要字段，避免跨版本字段差异炸掉序列化
  return {
    status: p.status,
    file: p.file,
    progress: typeof p.progress === "number" ? Math.max(0, Math.min(100, p.progress)) : undefined,
    loaded: p.loaded,
    total: p.total,
  };
}

async function ensureReady(opts = {}) {
  if (cached) return cached;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      const t = await transformersLib();
      t.env.remoteHost = opts.mirror || DEFAULT_MIRROR;
      t.env.allowLocalModels = true;
      t.env.cacheDir = path.join(app.getPath("userData"), "models");
      const common = { dtype: "q8", progress_callback: opts.onProgress };
      const model = await t.AutoModel.from_pretrained(MODEL_ID, common);
      const tokenizer = await t.AutoTokenizer.from_pretrained(MODEL_ID, common);
      cached = { model, tokenizer, Tensor: t.Tensor };
      return cached;
    })();
    loadingPromise.catch(() => {
      loadingPromise = null; // 失败可重试
    });
  }
  return loadingPromise;
}

// 与 src/ppl/scorer-core.ts 的 MASK_GROUPS/maskGroups 保持一致的镜像实现
const MASK_GROUPS = 5;
function maskGroups(items, groups) {
  const n = Math.max(1, Math.floor(groups));
  const out = Array.from({ length: n }, () => []);
  for (let i = 0; i < items.length; i++) out[i % n].push(items[i]);
  return out;
}

function toList(x) {
  if (x == null) return null;
  // Tensor 底层是 BigInt64Array，统一归一化为普通 number，避免 BigInt 混算错误
  if (typeof x.tolist === "function") return x.tolist().flat(Number.POSITIVE_INFINITY).map(Number);
  if (Array.isArray(x)) return x.map(Number);
  return Array.from(x.data != null ? x.data : x, Number);
}

/**
 * 对单个字符窗口打分。返回该窗的平均 NLL（nat）与参与打分的字数；
 * 窗内无可打分字符时返回 { meanNll: null, scoredCount: 0 }。
 * 任一环节异常向上抛出，由调用方决定降级。
 */
async function scoreWindow(ctx, chars) {
  const { model, tokenizer, Tensor } = ctx;
  const encoded = await tokenizer(chars.join(""), { add_special_tokens: true });
  const ids = toList(encoded.input_ids).flat();
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_WINDOW + 2) {
    throw new Error(`分词结果异常：${ids ? ids.length : "null"} 个 token`);
  }

  // 免对齐选点：BERT 的 MLM 打分只需要「位置 + 原词 id」，都在 ids 里。
  // 跳过特殊 token 与 UNK；标点参与打分（贴近生成式困惑度口径）。
  // 与 src/ppl/scorer-core.ts 的 selectTargets/SPECIAL_TOKEN_IDS 保持一致。
  const SKIP = new Set([0, 100, 101, 102, 103]); // [PAD]/[UNK]/[CLS]/[SEP]/[MASK]
  const targets = []; // { pos: token 下标, origId: 原词 id }
  for (let i = 0; i < ids.length; i++) {
    if (SKIP.has(ids[i])) continue;
    targets.push({ pos: i, origId: ids[i] });
  }
  if (targets.length === 0) return { meanNll: null, scoredCount: 0 };

  // 分组掩码：组内换 [MASK]、组外保留原文，逐组前向。每个被掩位置能看见
  // 大部分真实上下文，人机可预测性差异才不会被"全掩码"的熵上限抹平；
  // 成本是逐位掩码的 1/K。（镜像 scorer-core.ts 的 MASK_GROUPS/maskGroups）
  const groups = maskGroups(targets, MASK_GROUPS);
  let sumNll = 0;
  for (const g of groups) {
    const masked = ids.slice();
    for (const tg of g) masked[tg.pos] = tokenizer.mask_token_id;
    const seqLen = masked.length;
    const inputTensor = new Tensor(
      "int64",
      BigInt64Array.from(masked.map((v) => BigInt(v))),
      [1, seqLen],
    );
    const attnTensor = new Tensor(
      "int64",
      BigInt64Array.from({ length: seqLen }, () => 1n),
      [1, seqLen],
    );
    const typeTensor = new Tensor(
      "int64",
      BigInt64Array.from({ length: seqLen }, () => 0n),
      [1, seqLen],
    );
    const output = await model({
      input_ids: inputTensor,
      attention_mask: attnTensor,
      token_type_ids: typeTensor,
    });
    const lg = output.logits;
    if (!lg || !lg.dims || lg.data == null) throw new Error("模型输出缺少 logits");
    const vocab = Number(lg.dims[lg.dims.length - 1]);
    // 逐目标位 log softmax 取原词分量：logP = logit[origId] - logsumexp(row)
    for (const tg of g) {
      const base = tg.pos * vocab;
      let max = -Infinity;
      for (let v = 0; v < vocab; v++) if (lg.data[base + v] > max) max = lg.data[base + v];
      let sumExp = 0;
      for (let v = 0; v < vocab; v++) sumExp += Math.exp(lg.data[base + v] - max);
      sumNll -= lg.data[base + tg.origId] - (max + Math.log(sumExp));
    }
  }
  return { meanNll: sumNll / targets.length, scoredCount: targets.length };
}

/* ----------------------------- IPC 宿主 ----------------------------- */

function registerPplIpc(ipcMain, mirrorRef) {
  ipcMain.handle("ppl-status", () => ({
    supported: true,
    ready: !!cached,
    loading: !!loadingPromise,
  }));

  ipcMain.handle("ppl-download", async (event) => {
    const onProgress = (p) => {
      try {
        event.sender.send("ppl-progress", pickProgress(p));
      } catch {
        /* 窗口已关闭等情况忽略 */
      }
    };
    try {
      await ensureReady({ mirror: mirrorRef.value, onProgress });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 输入：字符串数组（渲染层用 planWindows 切好的字符窗口）；
  // 输出：按序对齐的 [{ scoredCount, meanNll }]，由渲染层 aggregateText 聚合。
  ipcMain.handle("ppl-score", async (_event, windows) => {
    if (!Array.isArray(windows) || windows.some((w) => typeof w !== "string")) {
      return { ok: false, error: "参数必须是字符串数组" };
    }
    if (windows.some((w) => [...w].length > MAX_WINDOW)) {
      return { ok: false, error: "窗口超过模型容量上限" };
    }
    try {
      const ctx = await ensureReady({ mirror: mirrorRef.value });
      const results = [];
      for (const w of windows) {
        const chars = w.length > 0 && [...w].length === w.length ? w : [...w];
        results.push(await scoreWindow(ctx, chars));
      }
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

module.exports = { registerPplIpc, ensureReady, scoreWindow, MODEL_ID, DEFAULT_MIRROR };
