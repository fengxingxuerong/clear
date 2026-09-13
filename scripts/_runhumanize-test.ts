/**
 * scripts/_runhumanize-test.ts —— runHumanize 统一分发入口实测（临时）
 *
 * 覆盖：长文分块路径（>1200 字）、小说对话体裁深度改写、超短文边界。
 * 用法：npx tsx scripts/_runhumanize-test.ts [文件名过滤]
 */
import fs from "fs";
import path from "path";
import { runHumanize } from "../src/api/llm";
import { DEFAULT_API, loadPresetKeys, effectiveKeys } from "./../src/api/llm-config";

const SAMPLES = "C:/Users/Admin（无密码）/Documents/Loomy Workspace/QuAiWei去AI味测试/samples-phase2";
const OUT = "C:/Users/Admin（无密码）/Documents/Loomy Workspace/QuAiWei去AI味测试/out-phase2-deep";

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
  maxWaitSeconds: 420,
  maxApiCalls: 40,
  contestSamples: 1,
  strictFidelity: true,
};

async function main() {
  const keys = effectiveKeys(cfg);
  if (!keys.length) {
    console.error("Key 池为空");
    process.exit(1);
  }
  const filter = process.argv[2] || "";
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs
    .readdirSync(SAMPLES)
    .filter((f) => f.toLowerCase().endsWith(".txt") && f.includes(filter))
    .sort();
  console.log(
    `runHumanize 实测 | Key 池 ${keys.length} | 主力 ${cfg.model} | 严格保真 ${cfg.strictFidelity ? "开" : "关"} | 预算 ${cfg.maxApiCalls} 次/${cfg.maxWaitSeconds}s 每篇`,
  );
  console.log("=".repeat(72));

  for (const f of files) {
    const name = path.basename(f);
    const raw = fs.readFileSync(path.join(SAMPLES, f), "utf-8");
    const t0 = Date.now();
    try {
      const r = await runHumanize(raw, 0.7, cfg, (round, score, stage) => {
        console.log(`   [${name}] R${round} ${stage ?? ""} score=${score ?? "-"}`);
      });
      const ms = Math.round((Date.now() - t0) / 1000);
      fs.writeFileSync(
        path.join(OUT, name.replace(/\.txt$/i, ".run.txt")),
        r.text,
        "utf-8",
      );
      const shrink =
        r.shrinkRatio !== undefined ? ` 压缩率 ${Math.round((1 - r.shrinkRatio) * 100)}%` : "";
      console.log(
        `✅ ${name}: usedApi=${r.usedApi} | ${raw.replace(/\s/g, "").length}→${r.text.replace(/\s/g, "").length} 字${shrink} | ${ms}s`,
      );
      console.log(`   note: ${r.note}`);
    } catch (e) {
      console.error(`❌ ${name}: ${(e as Error).message}（${Math.round((Date.now() - t0) / 1000)}s）`);
    }
  }
}

main();
