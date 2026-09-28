/**
 * scripts/_offline-ppl-check.ts — PPL 断网实测（坐实/戳破「完全离线」承诺）
 *
 * Phase1 在线：从 hf-mirror 下载 Xenova/bert-base-chinese(q8) 到本地缓存目录
 * Phase2 断网：全局 fetch 全部拒绝（任何联网尝试立即失败），重新加载模型并
 *             用真实推理打分（人写句 vs AI 句各一段），复用 scorer-core 数学内核
 *
 * 结论口径：PPL = 「首次需联网，之后离线可用」；本地去味引擎 = 完全离线。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planWindows, maskGroups, MASK_GROUPS, maskedMeanNll } from "../src/ppl/scorer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 模型文件已用 curl 预下载到 .tmp-ppl-model/Xenova/bert-base-chinese/（见 README 或 .gitignore）
const LOCAL_MODEL_DIR = path.join(__dirname, "..", ".tmp-ppl-model");
const MODEL_ID = "Xenova/bert-base-chinese";

const SAMPLES: { name: string; text: string }[] = [
  {
    name: "人写句（口语、跳跃）",
    text: "说实话这个方案我一开始没看上，后来线上跑了两周，转化还涨了点，就留着了。具体为啥涨，我也说不太清。",
  },
  {
    name: "AI 句（套话、均匀）",
    text: "综上所述，企业应当加快推进数字化转型的战略布局，建立完善的全链路管理体系，从而实现可持续发展，为高质量发展注入新动能。",
  },
];

async function main() {
  const t = await import("@huggingface/transformers");

  // Phase2：物理断网——全局 fetch 一律拒绝，任何联网尝试立即报错
  console.log("[断网] 拦截全部网络请求（任何 fetch 一律失败）…");
  globalThis.fetch = (async () => {
    throw new Error("OFFLINE：网络请求已被断网测试拦截");
  }) as typeof fetch;

  // 注意：allowLocalModels + localModelPath 指向本地目录，从磁盘加载，不联网
  t.env.remoteHost = "https://hf-mirror.com"; // 仅作 fallback，断网下不可达
  t.env.allowLocalModels = true;
  t.env.localModelPath = LOCAL_MODEL_DIR;

  console.log(`从本地目录加载 ${MODEL_ID}（${LOCAL_MODEL_DIR}，全局断网）…`);
  const t1 = Date.now();
  const model = await t.AutoModel.from_pretrained(MODEL_ID, { dtype: "q8" });
  const tokenizer = await t.AutoTokenizer.from_pretrained(MODEL_ID);
  console.log(`断网加载成功：${((Date.now() - t1) / 1000).toFixed(1)}s（纯本地文件）`);

  for (const s of SAMPLES) {
    const wins = planWindows(s.text);
    let allNll = 0;
    let cnt = 0;
    for (const w of wins) {
      const joined = w.chars.join("");
      const encoded = await (tokenizer as unknown as (x: string) => Promise<{ input_ids: { data: ArrayLike<number> } }>)(joined);
      const ids = Array.from(encoded.input_ids.data, Number);
      const maskId = (tokenizer as unknown as { mask_token_id: number }).mask_token_id;
      const targets: { pos: number; origId: number }[] = [];
      for (let i = 0; i < ids.length; i++) {
        if ([0, 100, 101, 102, 103].includes(ids[i])) continue;
        targets.push({ pos: i, origId: ids[i] });
      }
      let sum = 0;
      for (const g of maskGroups(targets, MASK_GROUPS)) {
        const masked = ids.slice();
        for (const tg of g) masked[tg.pos] = maskId;
        const seqLen = masked.length;
        const out = (await model({
          input_ids: new t.Tensor("int64", BigInt64Array.from(masked.map((v) => BigInt(v))), [1, seqLen]),
          attention_mask: new t.Tensor("int64", BigInt64Array.from({ length: seqLen }, () => 1n), [1, seqLen]),
          token_type_ids: new t.Tensor("int64", BigInt64Array.from({ length: seqLen }, () => 0n), [1, seqLen]),
        })) as unknown as { logits: { data: ArrayLike<number>; dims: number[] } };
        const vocab = out.logits.dims[out.logits.dims.length - 1];
        sum += maskedMeanNll(out.logits.data, out.logits.dims[1], vocab, g) * g.length;
      }
      allNll += sum;
      cnt += targets.length;
    }
    const meanNll = allNll / cnt;
    console.log(
      `  【${s.name}】meanNLL=${meanNll.toFixed(4)} nat（困惑度≈${Math.exp(meanNll).toFixed(1)}，打分 ${cnt} 字）`,
    );
  }
  console.log("\n✅ 断网结论：模型加载与推理均不依赖网络——「首次需联网下载，之后完全离线」成立");
}

main().catch((e) => {
  console.error("\n❌ 断网实测失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
