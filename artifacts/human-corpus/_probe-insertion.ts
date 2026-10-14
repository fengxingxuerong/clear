/**
 * human-corpus/_probe-insertion.ts —— 重验「凭空添加内容」
 *
 * 用法：npx tsx artifacts/human-corpus/_probe-insertion.ts
 *
 * ## 为什么重验
 *
 * 2026-10-14 17:50 的引擎行为审计里报过「凭空添加 433 处」，但**当场就标注了
 * 「检测法有误伤，需重验」**——那个判据是 `!prose.includes(t.slice(0, 10))`，
 * 它会把**切句造成的重复**也算进去：
 *   原文「北京市，简称京…」被切成「北京市。北京市，简称京…」⇒ 第二句开头
 *   10 字在原文里能找到，但它自己确实是新增的一句。
 * 两者混在一起 ⇒ 数字不可信。
 *
 * ## 这次的判据（精确）
 *
 * 用引擎**自带的 diff**（`explainChanges`）：它的 `ExplainItem` 明确区分
 *   · `before` 非空 → **改写**（原句被换成新句）
 *   · `before` 为空 → **纯新增**（原文里没有对应删除项）
 * 只有后者才是「凭空添加」。
 */
import { readFileSync } from "node:fs";
import { humanize } from "../../src/engine/humanize.ts";
import { explainChanges } from "../../src/engine/explain.ts";

const DIR = "artifacts/human-corpus";
const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8")) as {
  items: { genre: string; title: string; file: string; chars: number }[];
};

const SEED = 20260905;
const INTENSITY = 0.9;

/** 归一化：去标点空白，只留实词字符 */
const norm = (s: string) => s.replace(/[\s，。！？、；：""''「」『』（）()·…—\-,.;:?!]/g, "");

let totalIns = 0;
let totalRewrites = 0;
const insSamples: { title: string; text: string; reason: string }[] = [];
const perTitle: { title: string; chars: number; ins: number; rw: number }[] = [];

for (const it of manifest.items) {
  const prose = readFileSync(it.file, "utf8").split("\n\n").slice(1).join("\n\n");
  const out = humanize(prose, { intensity: INTENSITY, seed: SEED });
  const changes = explainChanges(prose, out);

  const ins = changes.filter((c) => !c.before.trim() && c.after.trim());
  const rw = changes.filter((c) => c.before.trim() && c.after.trim());
  totalIns += ins.length;
  totalRewrites += rw.length;
  perTitle.push({ title: it.title, chars: it.chars, ins: ins.length, rw: rw.length });

  for (const c of ins) {
    if (insSamples.length < 12) {
      insSamples.push({
        title: it.title,
        text: c.after.trim().slice(0, 40),
        reason: c.reason.slice(0, 34),
      });
    }
  }
}

console.log(`纯新增 vs 改写（explainChanges 精确判定）｜${manifest.items.length} 篇\n`);
console.log("条目        字数   纯新增   改写    新增/千字");
console.log("─".repeat(58));
for (const p of perTitle.sort((a, b) => b.ins - a.ins)) {
  if (!p.ins) continue;
  console.log(
    `${p.title.padEnd(12)} ${String(p.chars).padStart(5)} ${String(p.ins).padStart(7)} ${String(p.rw).padStart(7)} ${((p.ins / p.chars) * 1000).toFixed(2).padStart(9)}`,
  );
}

console.log(`\n合计：纯新增 ${totalIns} 处｜改写 ${totalRewrites} 处`);
console.log(`此前用字符串匹配报的「433 处」—— 对照差值 ${433 - totalIns}`);

console.log(`\n━━━ 纯新增样例（这是真正的"凭空添加"）━━━`);
for (const s of insSamples) console.log(`  [${s.title}] 「${s.text}」 — ${s.reason}`);

/**
 * 第二步：判定这些新增是**问题**还是**设计行为**。
 * 判据：新增内容是否
 *   ① 携带原文没有的**事实/数字/专名** → 真问题（改变了语义）
 *   ② 只是口语碎片/语气词（无新信息） → 设计内的人味注入
 */
const FACT = /\d|公元|年|倍|百分之|元|万|亿|先生|女士|教授|主任|经理|博士/;
let risky = 0;
const riskyList: string[] = [];
for (const it of manifest.items) {
  const prose = readFileSync(it.file, "utf8").split("\n\n").slice(1).join("\n\n");
  const out = humanize(prose, { intensity: INTENSITY, seed: SEED });
  for (const c of explainChanges(prose, out)) {
    if (c.before.trim() || !c.after.trim()) continue;
    const a = c.after.trim();
    if (!FACT.test(a)) continue;
    // 数字/专名是否原文本来就有？
    const nums = a.match(/\d+[\d.]*|[一-龥]{2,4}(?:大学|学院|公司|医院|银行)/g) ?? [];
    const novel = nums.filter((n) => !prose.includes(n));
    if (novel.length) {
      risky++;
      if (riskyList.length < 8)
        riskyList.push(`[${it.title}] 「${a.slice(0, 30)}」 引入新实体 ${novel.join(",")}`);
    }
  }
}
console.log(`\n━━━ 引入原文没有的实体/数字（真·语义改变）━━━`);
console.log(`  ${risky} 处`);
riskyList.forEach((r) => console.log("  " + r));
if (risky === 0) console.log("  ✅ 没有一处把原文没有的事实/专名写进产出");
