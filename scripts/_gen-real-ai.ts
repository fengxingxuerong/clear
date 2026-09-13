/**
 * scripts/_gen-real-ai.ts —— 生成「真实 AI 基线文本」（临时）
 *
 * 目的：手写 AI 味样本被朱雀判人类（4/4），需要真实 LLM 输出做基线，
 * 验证「朱雀能否抓到真 AI 文本」，后续才能测改写迁移效果。
 * 用 deepseek-v4-flash 默认参数正常写作，不加任何风格指令。
 */
import fs from "fs";
import { chat } from "../src/api/llm-chat";
import { DEFAULT_API, loadPresetKeys, effectiveKeys } from "../src/api/llm-config";

const OUT = "C:/Users/Admin（无密码）/Documents/Loomy Workspace/QuAiWei去AI味测试/out-zhuque";

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const cfg = {
    ...DEFAULT_API,
    enabled: true,
    baseUrl: "https://token.sensenova.cn/v1",
    apiKey: "",
    apiKeys: loadPresetKeys().join("\n"),
    model: "deepseek-v4-flash",
    judgeModel: "",
    temperature: 0.7,
  };
  if (!effectiveKeys(cfg).length) {
    console.error("Key 池为空");
    process.exit(1);
  }
  const prompt =
    "写一篇约 450 字的议论文，题目：数字化转型是企业发展的必由之路。要求：结构完整、论述清晰，符合常规公众号文章水准。只输出正文。";
  const r = await chat(
    cfg,
    [
      { role: "system", content: "你是一名专业的公众号作者。" },
      { role: "user", content: prompt },
    ],
    { temperature: 0.7, maxTokens: 4000 },
  );
  const text = r.content.trim();
  fs.writeFileSync(path.join(OUT, "s1-real-ai.txt"), text, "utf-8");
  console.log(`生成完成：${text.replace(/\s/g, "").length} 字`);
  console.log(text.slice(0, 120) + "…");
}
import * as path from "path";
main();
