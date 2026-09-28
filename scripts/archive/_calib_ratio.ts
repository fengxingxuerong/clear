/**
 * 改用「句级污染率」口径：被污染的句子数 / 总句数。
 *
 * 理由：密度（每百字词数）对长文本不公平——M5/M6 是长文本，
 * 垫词绝对数少、被稀释后密度低于阈值，但"被污染的句子"占比其实不低。
 *
 * 同时把三类污染合并计一句（垫词/语气词/碎片），只要一句中任一命中即算污染。
 */
import { ALL_SAMPLES } from "./_calib_corpus.ts";

const PAD = [
  "说真的", "其实", "说实话", "老实讲", "讲真", "说白了", "你别说", "要我说",
  "平心而论", "客观讲", "往实了说", "不瞒你说", "按我的经验", "话又说回来",
  "说到底", "总的来说", "具体来说", "换句话说", "简单说", "总体而言",
  "坦白讲", "说句实在话", "你懂的", "差不多得了", "就这样", "是啊", "哦对",
];
const PARTICLES = ["嗯", "啊", "哦", "嗨", "咳", "呣", "啧", "诶", "哈", "嗼", "呵"];


/** 句级污染率 */
function sentPollution(text: string) {
  // 切句（保留分隔符位置信息用不上，只统计比例）
  const sents = text.split(/(?<=[。！？])|\n+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const total = sents.length;
  let polluted = 0;
  const detail: string[] = [];
  for (const s of sents) {
    const hasHeadPad = new RegExp(`^${PAD.join("|")}[，,]`).test(s) || PAD.some((p) => s.startsWith(p));
    const hasMidPad = PAD.some((p) => s.length > p.length + 2 && s.includes(`${p}，`) && !s.startsWith(p));
    const hasStack = PAD.some((a) => PAD.some((b) => s.includes(`${a}，${b}`)));
    const hasParticle = PARTICLES.some((p) => new RegExp(`[\\u4e00-\\u9fa5]${p}[。！？，]`).test(s));
    const isFrag = s.replace(/\s/g, "").length <= 6 && PAD.some((p) => s.includes(p));
    if (hasHeadPad || hasMidPad || hasStack || hasParticle || isFrag) {
      polluted++;
      detail.push(s.slice(0, 24));
    }
  }
  return { total, polluted, ratio: total ? Number((polluted / total).toFixed(3)) : 0, detail };
}

console.log("ID".padEnd(24), "类型", "总句", "污染句", "污染率");
console.log("-".repeat(66));
const rows = ALL_SAMPLES.map((s) => {
  const r = sentPollution(s.text);
  console.log(
    s.id.padEnd(22),
    s.expect === "human" ? "人写" : "引擎",
    String(r.total).padStart(4),
    String(r.polluted).padStart(6),
    String(r.ratio).padStart(7),
  );
  return { id: s.id, expect: s.expect, ...r };
});

const H = rows.filter((r) => r.expect === "human");
const M = rows.filter((r) => r.expect === "machine");
console.log("\n阈值扫描（污染率 >= T 判为引擎）：");
console.log("阈值".padEnd(8), "人写误伤", "引擎命中", "综合错判");
console.log("-".repeat(48));
for (const T of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
  const hErr = H.filter((r) => r.ratio >= T).length;
  const mHit = M.filter((r) => r.ratio >= T).length;
  console.log(
    `>= ${T}`.padEnd(8),
    String(hErr).padStart(7),
    `${mHit}/${M.length}`.padStart(8),
    String(hErr + (M.length - mHit)).padStart(8),
  );
}

console.log("\nH 组污染率明细（用于确认误伤边界）：");
for (const r of H) console.log(`  ${r.id.padEnd(22)} ratio=${r.ratio}  污染句: ${r.detail.join(" | ") || "无"}`);
console.log("\nM 组污染率明细（用于确认漏判）：");
for (const r of M) console.log(`  ${r.id.padEnd(22)} ratio=${r.ratio}  污染句: ${r.detail.slice(0, 3).join(" | ") || "无"}`);
