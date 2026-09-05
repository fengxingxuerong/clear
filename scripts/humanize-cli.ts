/**
 * scripts/humanize-cli.ts —— 批量去味 CLI（v0.8.6，竞品对标能力）
 *
 * 竞品（嘎嘎降AI/零感AI/千笔AI）标配「批量上传多文件处理」，本项目此前只有 UI 单篇模式。
 * 本 CLI 补齐：本地批量处理 .txt 文件，纯本地引擎（零成本零上传），输出到指定目录。
 *
 * 用法：
 *   npx tsx scripts/humanize-cli.ts <input-dir-or-file> [--out <dir>] [--intensity 0.9]
 *       [--zhuque] [--style casual|plain|academic] [--suffix .humanized]
 *
 * 示例：
 *   npx tsx scripts/humanize-cli.ts ./docs-txt --out ./out --intensity 0.9 --zhuque
 */
import fs from "fs";
import path from "path";
import { humanize } from "../src/engine/humanize";
import { detectAI } from "../src/engine/detector";

interface Args {
  input: string;
  out: string;
  intensity: number;
  zhuque: boolean;
  style: "casual" | "plain" | "academic";
  suffix: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { input: "", out: "", intensity: 0.9, zhuque: false, style: "casual", suffix: ".humanized" };
  const a = argv.slice(2);
  if (!a[0] || a[0].startsWith("--")) {
    console.error("用法: npx tsx scripts/humanize-cli.ts <input-dir-or-file> [--out <dir>] [--intensity 0.9] [--zhuque] [--style casual|plain|academic] [--suffix .humanized]");
    process.exit(1);
  }
  args.input = a[0];
  for (let i = 1; i < a.length; i++) {
    if (a[i] === "--out") args.out = a[++i] ?? "";
    else if (a[i] === "--intensity") args.intensity = Math.max(0, Math.min(1, parseFloat(a[++i] || "0.9")));
    else if (a[i] === "--zhuque") args.zhuque = true;
    else if (a[i] === "--style") args.style = (a[++i] as Args["style"]) || "casual";
    else if (a[i] === "--suffix") args.suffix = a[++i] ?? ".humanized";
  }
  if (!args.out) args.out = args.input.endsWith(".txt") ? path.dirname(args.input) : args.input;
  return args;
}

function collectTxtFiles(input: string): string[] {
  const st = fs.statSync(input);
  if (st.isFile()) return [input];
  const out: string[] = [];
  for (const f of fs.readdirSync(input)) {
    const p = path.join(input, f);
    if (fs.statSync(p).isFile() && f.toLowerCase().endsWith(".txt")) out.push(p);
  }
  return out.sort();
}

function main() {
  const args = parseArgs(process.argv);
  const files = collectTxtFiles(args.input);
  if (!files.length) {
    console.error("未找到 .txt 文件:", args.input);
    process.exit(1);
  }
  fs.mkdirSync(args.out, { recursive: true });
  console.log(`批量去味：${files.length} 个文件 | 强度 ${args.intensity} | 朱雀增强 ${args.zhuque ? "开" : "关"} | 文风 ${args.style}`);
  console.log("─".repeat(64));

  let ok = 0, fail = 0;
  for (const f of files) {
    const name = path.basename(f);
    try {
      const raw = fs.readFileSync(f, "utf-8");
      if (!raw.trim()) {
        console.log(`⏭  ${name}：空文件，跳过`);
        continue;
      }
      const t0 = Date.now();
      const out = humanize(raw, { intensity: args.intensity, seed: 20260905, zhuqueMode: args.zhuque, style: args.style });
      const ms = Date.now() - t0;
      const before = detectAI(raw);
      const after = detectAI(out);      const dest = path.join(args.out, name.replace(/\.txt$/i, "") + args.suffix + ".txt");
      fs.writeFileSync(dest, out, "utf-8");
      console.log(`✅ ${name}：${before.probability}→${after.probability}（${ms}ms，${raw.length}→${out.length} 字）→ ${path.basename(dest)}`);
      ok++;
    } catch (e) {
      console.error(`❌ ${name}：${(e as Error).message}`);
      fail++;
    }
  }
  console.log("─".repeat(64));
  console.log(`完成：${ok} 成功 / ${fail} 失败 → ${args.out}`);
  if (fail > 0) process.exit(1);
}

main();
