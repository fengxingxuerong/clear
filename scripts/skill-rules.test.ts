/**
 * skill 规则文档双向锁测试（v0.9.39）
 *
 * 锁两件事：
 *  1. **引擎 ↔ 文档一致**：generateSkillRules() 的输出与 skills/humanizer-rules/ 磁盘
 *     逐字相同——引擎改了词表/旋钮忘重新生成、或有人手改文档，都红。
 *  2. **内容健全**：VOCAB 每个键、FORMULAIC 每条、四体裁 knob 值、六类病句
 *     都必须出现在文档里（防渲染函数静默丢内容——比如 items.map 崩成空这种）。
 *
 * 另测 --check 模式（CI 用）：子进程跑 tsx gen-skill-rules.ts --check 期望 exit 0。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { generateSkillRules } from "./gen-skill-rules.ts";
import { VOCAB, FORMULAIC } from "../src/engine/humanize-vocab.ts";
import { getGenreKnobs } from "../src/engine/humanize.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "skills", "humanizer-rules");

const files = generateSkillRules();
const readOne = (rel: string) => files.get(rel) ?? "";

describe("skill 规则文档 · 磁盘一致性", () => {
  it("生成输出与磁盘逐字相同（引擎更新忘重新生成 → 红）", () => {
    for (const [rel, content] of files) {
      const abs = path.join(OUT_DIR, rel);
      expect(fs.existsSync(abs), `${rel} 应存在`).toBe(true);
      expect(fs.readFileSync(abs, "utf8"), `${rel} 与生成输出不一致`).toBe(content);
    }
  });

  it("磁盘上没有多出来的文件（防手添游离文件绕过锁）", () => {
    const onDisk = new Set<string>();
    const walk = (dir: string, prefix = "") => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? path.join(prefix, e.name) : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else onDisk.add(rel);
      }
    };
    walk(OUT_DIR);
    const generated = new Set([...files.keys()]);
    expect([...onDisk].filter((f) => !generated.has(f))).toEqual([]);
  });
});

describe("skill 规则文档 · 内容健全", () => {
  it("VOCAB 每个套话键都出现在 vocab.md（渲染不许静默丢词）", () => {
    const doc = readOne(path.join("rules", "vocab.md"));
    const missing = Object.keys(VOCAB).filter((k) => !doc.includes(k));
    expect(missing).toEqual([]);
  });

  it("FORMULAIC 每条签名都出现在 formulaic.md", () => {
    const doc = readOne(path.join("rules", "formulaic.md"));
    const missing = FORMULAIC.filter((f) => !doc.includes(f));
    expect(missing).toEqual([]);
  });

  it("四体裁 knob 数值都出现在 genres.md（23/28/32/36、burst、0.48 上限）", () => {
    const doc = readOne(path.join("rules", "genres.md"));
    for (const g of ["main", "narrative", "dialogue", "humanHand"] as const) {
      const k = getGenreKnobs(g);
      expect(doc, `avgLenTarget ${g}=${k.avgLenTarget}`).toContain(String(k.avgLenTarget));
      expect(doc, `burstTarget ${g}=${k.burstTarget}`).toContain(String(k.burstTarget));
    }
    expect(doc).toContain("0.48"); // humanHand 强度硬顶
  });

  it("六类病句模式都在 guards.md", () => {
    const doc = readOne(path.join("rules", "guards.md"));
    for (const name of [
      "引述动词+语气词",
      "纯标点段误合并",
      "从属从句残句",
      "引述结构收尾",
      "方向修饰语动词撞车",
      "目的连词残句",
    ]) {
      expect(doc).toContain(name);
    }
  });

  it("SKILL.md frontmatter 合法（name + description，供 agent skill 系统识别）", () => {
    const doc = readOne("SKILL.md");
    expect(doc.startsWith("---\n")).toBe(true);
    expect(doc).toMatch(/^name: humanizer-rules$/m);
    expect(doc).toMatch(/^description: .+$/m);
    // 入口必须索引到全部五个规则文件
    for (const r of ["vocab.md", "formulaic.md", "materials.md", "genres.md", "guards.md"]) {
      expect(doc).toContain(r);
    }
  });

  it("每个生成文件都带「由生成器产出」头注（防被当手写文档随意改）", () => {
    for (const [rel, content] of files) {
      if (rel === "SKILL.md") continue; // 入口是手写模板
      expect(content, rel).toContain("gen-skill-rules");
    }
  });
});

describe("skill 规则文档 · --check 模式", () => {
  it("子进程 --check 退出 0（漂移时退出 1，CI 可拦）", async () => {
    const tsxBin = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      [tsxBin, path.join(ROOT, "scripts", "gen-skill-rules.ts"), "--check"],
      {
        cwd: ROOT,
        timeout: 90_000,
      },
    );
    expect(stdout).toContain("与引擎一致");
  }, 60_000);
});
