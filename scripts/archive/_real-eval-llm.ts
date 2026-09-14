/**
 * scripts/_real-eval-llm.ts — 真实去 AI 能力实测（LLM 深度闭环，真实 API 调用）
 * 用 SenseNova 常驻 Key 池（deepseek-v4-flash 主力 × glm-5.2 交叉评判）跑深度闭环
 */
import { humanizeViaApiDeep } from "../src/api/llm-humanize";
import { SENSENOVA_PRESET, effectiveKeys, type ApiConfig } from "../src/api/llm-config";
import { aiScore } from "../src/engine/humanize-metrics";

const TEXT = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据相关数据显示，我国数字经济规模已经突破了五十万亿元人民币，占GDP的比重达到了百分之四十以上，充分体现了数字经济作为国民经济核心增长引擎的强大动力与韧性。
综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系；最后，也是最为重要的一点，企业需要培养和引进既懂业务又懂技术的复合型数字化人才。
总而言之，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有那些真正把数字化战略上升到企业核心战略层面的企业，才能在未来的竞争中立于不败之地。`;

const cfg: ApiConfig = {
  enabled: true,
  baseUrl: "https://token.sensenova.cn/v1", // vite 代理 /sensenova → token.sensenova.cn，Node 直连用绝对地址
  apiKey: "",
  apiKeys: SENSENOVA_PRESET.keys.join("\n"),
  model: "deepseek-v4-flash",
  temperature: 0.9,
  deepMode: true,
  judgeModel: "glm-5.2",
  altModel: "deepseek-v4-pro",
  style: "casual",
  maxWaitSeconds: 300,
  maxApiCalls: 12,
};

async function main() {
  const keys = effectiveKeys(cfg);
  console.log(`Key 池: ${keys.length} 个 | 主力=${cfg.model} 评判=${cfg.judgeModel} 备选=${cfg.altModel}`);
  const before = aiScore(TEXT);
  console.log(`原文 aiScore(本地代理)=${before.score}，开始深度闭环（≤4轮，目标分≤10）...`);
  const t0 = Date.now();
  try {
    const r = await humanizeViaApiDeep(TEXT, cfg, (round, score, stage) => {
      console.log(`  [进度] 轮${round} ${stage ?? ""} score=${score ?? "?"} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n=== 深度闭环完成（耗时 ${secs}s，达标=${r.hitTarget}，note=${r.note || "无"}）===`);
    console.log(`各轮 LLM 评分: [${r.roundScores.join(", ")}]  质检: [${r.qcPassed.map((p) => (p ? "✓" : "✗")).join(", ")}]`);
    if (r.qcIssues.length) console.log(`遗留质检问题: ${r.qcIssues.join("; ")}`);
    const after = aiScore(r.text);
    console.log(`本地代理分: ${before.score} → ${after.score}`);
    console.log(`\n--- 最终稿全文 ---\n${r.text}`);
  } catch (e) {
    console.error(`\n❌ 深度闭环失败: ${e instanceof Error ? e.message : String(e)}`);
    console.log("（用完了 Key 池或网关不可达——这就是 UI 上「API 失败自动回退本地引擎」的场景）");
    process.exit(1);
  }
}
main();
