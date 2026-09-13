/**
 * scripts/_deep-api-test.ts —— LLM 深度模式（humanizeViaApiDeep）批量实测脚本（临时）
 *
 * 用法（项目根目录）：
 *   npx tsx scripts/_deep-api-test.ts                # 跑全部 4 篇
 *   npx tsx scripts/_deep-api-test.ts s4             # 只跑文件名含 s4 的（连通性 smoke）
 *
 * 说明：baseUrl 直连真实网关（绕过 vite 代理），Key 池自动从 scripts/.sensenova-keys 加载。
 * 模型矩阵对齐使用说明推荐：deepseek-v4-flash 主力 / deepseek-v4-pro 备选 / glm-5.2 交叉评判。
 */
import fs from "fs";
import path from "path";
import { humanizeViaApiDeep } from "../src/api/llm-humanize";
import { DEFAULT_API, loadPresetKeys, effectiveKeys } from "../src/api/llm-config";
import { detectAI } from "../src/engine/detector";
import { resetApiCallCount, getApiCallCount } from "../src/api/llm-chat";

const SAMPLES = "C:/Users/Admin（无密码）/Documents/Loomy Workspace/QuAiWei去AI味测试/samples";
const OUT = "C:/Users/Admin（无密码）/Documents/Loomy Workspace/QuAiWei去AI味测试/out-deep";

const cfg = {
  ...DEFAULT_API,
  enabled: true,
  baseUrl: "https://token.sensenova.cn/v1",
  apiKey: "",
  apiKeys: loadPresetKeys().join("\n"),
  model: "deepseek-v4-flash",
  altModel: "deepseek-v4-pro",
  judgeModel: "glm-5.2",
  deepMode: true,
  temperature: 0.9,
  style: "casual" as const,
  maxWaitSeconds: 300,
  maxApiCalls: 24,
  contestSamples: 1,
  strictFidelity: true,
};

async function main() {
  const keys = effectiveKeys(cfg);
  if (!keys.length) {
    console.error("Key 池为空：检查 scripts/.sensenova-keys 或环境变量 SENSENOVA_KEYS");
    process.exit(1);
  }
  const filter = process.argv[2] || "";
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs
    .readdirSync(SAMPLES)
    .filter((f) => f.toLowerCase().endsWith(".txt") && f.includes(filter))
    .sort();
  console.log(
    `深度模式实测 | Key 池 ${keys.length} 个 | 主力 ${cfg.model} + 备选 ${cfg.altModel} | 评判 ${cfg.judgeModel} | 严格保真 ${cfg.strictFidelity ? "开" : "关"} | 预算 ${cfg.maxApiCalls} 次/${cfg.maxWaitSeconds}s 每篇`,
  );
  console.log("=".repeat(72));

  let ok = 0, fail = 0;
  for (const f of files) {
    const name = path.basename(f);
    const raw = fs.readFileSync(path.join(SAMPLES, f), "utf-8");
    if (!raw.trim()) continue;
    resetApiCallCount();
    const t0 = Date.now();
    try {
      const res = await humanizeViaApiDeep(raw, cfg, (round, score, stage) => {
        console.log(`   [${name}] R${round} ${stage ?? ""} score=${score ?? "-"}`);
      });
      const ms = Date.now() - t0;
      const before = detectAI(raw);
      const after = detectAI(res.text);
      fs.writeFileSync(path.join(OUT, name.replace(/\.txt$/i, "") + ".deep.txt"), res.text, "utf-8");
      console.log(
        `✅ ${name}: 自检 ${before.probability}→${after.probability} | 轮分 [${res.roundScores.join(" → ")}] 达标线 ${res.targetUsed}${res.hitTarget ? "(达标)" : ""} | 质检 [${res.qcPassed.map((p) => (p ? "✓" : "✗")).join(",")}] | 调用 ${getApiCallCount()} 次 | ${Math.round(ms / 1000)}s${res.note ? " | " + res.note : ""}`,
      );
      if (res.qcIssues.length) console.log(`   未修复质检项: ${res.qcIssues.join("；")}`);
      ok++;
    } catch (e) {
      console.error(`❌ ${name}: ${(e as Error).message}（${Date.now() - t0}ms，调用 ${getApiCallCount()} 次）`);
      fail++;
    }
  }
  console.log("=".repeat(72));
  console.log(`完成：${ok} 成功 / ${fail} 失败 → ${OUT}`);
  if (fail > 0) process.exit(1);
}

main();
