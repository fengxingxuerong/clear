// scan-bugs.ts 顶层工具：违规聚合 + 摘要输出 + 样例落盘。
// 用途：让 525 行 `❌` 变成 CI 上一眼能读的"签名×强度×次数×样例"表格，
//      并把每个签名的首个失败样本写到 artifacts/scan-bugs/<signature>__<intensity>__seed<N>.txt，
//      供人肉复现（不用重跑 30 种子）。
// 使用：文件末尾调用 reportAll(violations) 汇总输出。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface Violation {
  /** 组名，例如 "v5.2" / "v6.0" / "anti-fp" */
  group: string;
  /** 签名名，例如 "高危套话" / "公文书面腔回潮" */
  signature: string;
  /** 强度；无强度场景（忠实度/级联）用 null */
  intensity: number | null;
  /** 种子号；无种子场景（忠实度/级联）用 null */
  seed: number | null;
  /** 命中的正则或诊断描述 */
  pattern?: string;
  /** 违规所在输出片段（截断到 200 字） */
  snippet?: string;
  /** 违规前的原文输入片段（用于复现） */
  input?: string;
  /** 该签名的失败次数增量；默认 1 */
  count?: number;
}

interface AggRow {
  group: string;
  signature: string;
  total: number;
  byIntensity: Map<number, number>;
  bySeed: number[];
  firstViolation: Violation;
}

export function reportAll(
  violations: Violation[],
  opts: { artifactsDir?: string; summaryOnly?: boolean } = {},
): void {
  const total = violations.reduce((s, v) => s + (v.count ?? 1), 0);
  if (total === 0) {
    console.log("\n✅ 全部回归通过（0 违规）");
    return;
  }

  // 聚合：group × signature
  const map = new Map<string, AggRow>();
  for (const v of violations) {
    const key = `${v.group} :: ${v.signature}`;
    let row = map.get(key);
    if (!row) {
      row = {
        group: v.group,
        signature: v.signature,
        total: 0,
        byIntensity: new Map(),
        bySeed: [],
        firstViolation: v,
      };
      map.set(key, row);
    }
    row.total += v.count ?? 1;
    if (v.intensity !== null) {
      row.byIntensity.set(v.intensity, (row.byIntensity.get(v.intensity) ?? 0) + (v.count ?? 1));
    }
    if (v.seed !== null) row.bySeed.push(v.seed);
  }

  // 排序：按 total 降序
  const rows = [...map.values()].sort((a, b) => b.total - a.total);

  // 终端摘要
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].length));
  console.log("\n=== scan-bugs 摘要 ===");
  console.log(`总违规次数: ${total}，独立签名: ${rows.length}`);
  console.log("");
  console.log(
    pad("组", 8) +
      pad("签名", 24) +
      pad("次数", 8) +
      pad("强度分布", 20) +
      pad("种子范围", 16),
  );
  console.log("-".repeat(80));
  for (const r of rows) {
    const intensities = [...r.byIntensity.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => `${i.toFixed(1)}×${c}`)
      .join(", ");
    const seedRange =
      r.bySeed.length === 0
        ? "-"
        : `${Math.min(...r.bySeed)}~${Math.max(...r.bySeed)}/${r.bySeed.length}`;
    console.log(
      pad(r.group, 8) +
        pad(r.signature, 24) +
        pad(String(r.total), 8) +
        pad(intensities, 20) +
        pad(seedRange, 16),
    );
  }

  // artifact 落盘
  if (!opts.summaryOnly) {
    const dir = opts.artifactsDir ?? defaultArtifactsDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const r of rows) {
        const v = r.firstViolation;
        const baseName = `${v.group}__${slug(v.signature)}__i${v.intensity ?? "0"}__seed${v.seed ?? "0"}.txt`;
        const p = path.join(dir, baseName);
        const content =
          `# group: ${v.group}\n# signature: ${v.signature}\n# total_count: ${r.total}\n` +
          `# intensity: ${v.intensity ?? "n/a"}\n# seed: ${v.seed ?? "n/a"}\n` +
          `# pattern: ${v.pattern ?? "(no regex)"}\n` +
          (v.input ? `\n## INPUT\n${v.input.slice(0, 500)}\n\n## OUTPUT\n` : `\n## OUTPUT\n`) +
          (v.snippet ?? "").slice(0, 500) +
          `\n`;
        fs.writeFileSync(p, content, "utf8");
      }
      console.log(`\n样例落盘: ${dir}/`);
    } catch (e) {
      console.log(`\n⚠️ artifact 落盘失败: ${(e as Error).message}`);
    }
  }
}

function slug(s: string): string {
  return s.replace(/[\s/\\:*?"<>|]+/g, "_");
}

function defaultArtifactsDir(): string {
  // scan-bugs.ts 在 scripts/ 下，artifacts/ 放项目根
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "artifacts", "scan-bugs");
}
