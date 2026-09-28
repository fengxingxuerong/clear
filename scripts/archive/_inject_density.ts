/**
 * 量化注入强度：单次正常去味，实际注入多少个垫词/碎片/语气词？
 * 分「注入前」「注入后」「除重后」三个阶段观测。
 */
import { humanize } from "../src/engine/humanize.ts";
import { countPadHeads, PAD_HEADS } from "../src/engine/humanize-primitives.ts";
import {
  PARENTHETICALS, SENTENCE_FRAGMENTS, OPINION_PHRASES, PARENTHETIC_NOTES,
} from "../src/engine/humanize-zhuque.ts";

const SRC = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元人民币，占 GDP 的比重达到了 41.8%，较上一年度同比提升了 2.3 个百分点。
综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系；最后，企业需要培养和引进既懂业务又懂技术的复合型数字化人才。
最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。`;

function countAll(t: string) {
  const r: Record<string, number> = {};
  const add = (k: string, list: string[]) => {
    let n = 0;
    for (const w of list) {
      let i = 0;
      const key = w.replace(/[。！？]+$/g, "");
      while ((i = t.indexOf(key, i)) !== -1) { n++; i += key.length; }
    }
    r[k] = n;
  };
  add("插入语", PARENTHETICALS);
  add("碎片句", SENTENCE_FRAGMENTS);
  add("主观意见", OPINION_PHRASES);
  add("括号自语", PARENTHETIC_NOTES);
  add("垫词句头", PAD_HEADS);
  r["垫词总(countPadHeads)"] = countPadHeads(t);
  r["句子数"] = t.split(/[。！？]/).filter((x) => x.trim()).length;
  return r;
}

console.log("=== 原文 ===");
console.log(JSON.stringify(countAll(SRC), null, 2));

for (const [name, opt] of [
  ["0.5 关朱雀", { intensity: 0.5, zhuqueMode: false }],
  ["0.5 开朱雀", { intensity: 0.5, zhuqueMode: true }],
  ["0.7 开朱雀", { intensity: 0.7, zhuqueMode: true }],
  ["0.9 开朱雀", { intensity: 0.9, zhuqueMode: true }],
] as Array<[string, Record<string, unknown>]>) {
  const out = humanize(SRC, { ...opt, seed: 20260826 } as never);
  const c = countAll(out);
  const injectTotal = (c["插入语"] ?? 0) + (c["碎片句"] ?? 0) + (c["主观意见"] ?? 0) + (c["括号自语"] ?? 0) + (c["垫词句头"] ?? 0);
  console.log(`\n=== ${name}（字数 ${SRC.length}→${out.length}）===`);
  console.log(JSON.stringify(c, null, 2));
  console.log(`  ★ 注入类词条总命中(含重叠): ${injectTotal}   每千字: ${(injectTotal / out.length * 1000).toFixed(1)}`);
}
