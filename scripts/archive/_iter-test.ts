/**
 * scripts/_iter-test.ts —— 多轮迭代测试（临时）
 *
 * 模式：
 *   local  <文件> [轮数=5]   本地引擎串联迭代：输出作为下一轮输入，跟踪自检分/垫词/字数
 *   repeat <文件> [次数=3]   深度模式重复稳定性：同一输入跑 N 次，看分数方差
 *   chain  <文件> [轮数=2]   深度模式串联迭代：上一轮输出作为下一轮输入
 *
 * 用法：npx tsx scripts/_iter-test.ts local "路径" 5
 */
import fs from "fs";
import path from "path";
import { humanize } from "../src/engine/humanize";
import { detectAI } from "../src/engine/detector";
import { runHumanize } from "../src/api/llm";
import { DEFAULT_API, loadPresetKeys } from "../src/api/llm-config";

const OUT_ROOT = "C:/Users/Admin（无密码）/Documents/Loomy Workspace/QuAiWei去AI味测试/out-iter";

/** 每轮关键指标：自检分 + 垫词密度 + 语气词 + 字数（去空白） */
function metrics(text: string) {
  const filler = [
    "你懂的","说白了","就这样","差不多得了","好吧","哦对","有一说一","要我说","说起来",
    "按我的经验","先说一个","据我观察","客观讲","老实讲","话又说回来","不瞒你说","不吹不黑",
    "讲道理","凭啥","真的假的","插一句","这有什么要紧的","要紧的在后头","为啥这么说",
  ];
  let fillerCount = 0;
  for (const f of filler) {
    let i = 0;
    while ((i = text.indexOf(f, i)) !== -1) { fillerCount++; i += f.length; }
  }
  const particles = (text.match(/(?:哦|呵|啧|呣|诶|呀|嘛)[。！？；，]/g) || []).length;
  const chars = text.replace(/\s+/g, "").length;
  return { score: detectAI(text).probability, fillerCount, particles, chars };
}

async function localChain(file: string, rounds: number) {
  const dir = path.join(OUT_ROOT, "local-chain");
  fs.mkdirSync(dir, { recursive: true });
  let text = fs.readFileSync(file, "utf-8");
  const name = path.basename(file, ".txt");
  console.log(`实验A：本地引擎串联迭代 ×${rounds}（0.9 + 朱雀，seed 20260905）`);
  console.log("轮次 | 自检分 | 垫词 | 语气词 | 字数");
  const m0 = metrics(text);
  console.log(`原文 | ${m0.score} | ${m0.fillerCount} | ${m0.particles} | ${m0.chars}`);
  for (let r = 1; r <= rounds; r++) {
    text = humanize(text, { intensity: 0.9, seed: 20260905, zhuqueMode: true, style: "casual" });
    const m = metrics(text);
    console.log(`第${r}轮 | ${m.score} | ${m.fillerCount} | ${m.particles} | ${m.chars}`);
    fs.writeFileSync(path.join(dir, `${name}.r${r}.txt`), text, "utf-8");
  }
}

function deepCfg() {
  return {
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
}

async function deepRepeat(file: string, times: number) {
  const dir = path.join(OUT_ROOT, "deep-repeat");
  fs.mkdirSync(dir, { recursive: true });
  const text = fs.readFileSync(file, "utf-8");
  const name = path.basename(file, ".txt");
  console.log(`实验B：深度模式重复稳定性 ×${times}（同一输入）`);
  const rows: number[] = [];
  for (let i = 1; i <= times; i++) {
    const t0 = Date.now();
    try {
      const r = await runHumanize(text, 0.7, deepCfg());
      const m = metrics(r.text);
      rows.push(m.score);
      fs.writeFileSync(path.join(dir, `${name}.try${i}.txt`), r.text, "utf-8");
      console.log(`第${i}次 | 自检 ${m.score} | 字数 ${m.chars} | ${Math.round((Date.now() - t0) / 1000)}s | ${r.note.slice(0, 60)}`);
    } catch (e) {
      console.log(`第${i}次 | 失败：${(e as Error).message.slice(0, 80)}`);
    }
  }
  if (rows.length >= 2) {
    const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
    const sd = Math.sqrt(rows.reduce((a, b) => a + (b - mean) ** 2, 0) / rows.length);
    console.log(`稳定性：n=${rows.length} 均值 ${mean.toFixed(0)} 标准差 ${sd.toFixed(1)} 极差 ${Math.max(...rows) - Math.min(...rows)}`);
  }
}

async function deepChain(file: string, rounds: number) {
  const dir = path.join(OUT_ROOT, "deep-chain");
  fs.mkdirSync(dir, { recursive: true });
  let text = fs.readFileSync(file, "utf-8");
  const name = path.basename(file, ".txt");
  console.log(`实验C：深度模式串联迭代 ×${rounds}（上一轮输出作为下一轮输入）`);
  const m0 = metrics(text);
  console.log(`原文 | 自检 ${m0.score} | 字数 ${m0.chars}`);
  for (let r = 1; r <= rounds; r++) {
    const t0 = Date.now();
    try {
      const res = await runHumanize(text, 0.7, deepCfg());
      text = res.text;
      const m = metrics(text);
      fs.writeFileSync(path.join(dir, `${name}.c${r}.txt`), text, "utf-8");
      console.log(`第${r}轮 | 自检 ${m.score} | 字数 ${m.chars}（压缩率 ${(100 - (m.chars / m0.chars) * 100).toFixed(0)}%） | ${Math.round((Date.now() - t0) / 1000)}s | ${res.note.slice(0, 70)}`);
    } catch (e) {
      console.log(`第${r}轮 | 失败：${(e as Error).message.slice(0, 80)}`);
      break;
    }
  }
}

async function main() {
  const mode = process.argv[2] || "";
  const file = process.argv[3] || "";
  const n = Number(process.argv[4] || 0) || (mode === "repeat" ? 3 : mode === "chain" ? 2 : 5);
  if (!mode || !file || !fs.existsSync(file)) {
    console.error("用法: npx tsx scripts/_iter-test.ts local|repeat|chain <文件路径> [轮数]");
    process.exit(1);
  }
  if (mode === "local") await localChain(file, n);
  else if (mode === "repeat") await deepRepeat(file, n);
  else if (mode === "chain") await deepChain(file, n);
  else console.error("未知模式:", mode);
}

main();
