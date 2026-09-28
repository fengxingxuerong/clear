/**
 * 特征探测：找出能真正区分 HUMAN 与 MACHINE 的量化指标。
 * 不预设结论，先量出来再定检测器。
 */
import { ALL_SAMPLES } from "./_calib_corpus.ts";

const PAD = [
  "说真的", "其实", "说实话", "老实讲", "讲真", "说白了", "你别说", "要我说",
  "平心而论", "客观讲", "往实了说", "不瞒你说", "按我的经验", "话又说回来",
  "说到底", "总的来说", "具体来说", "换句话说", "简单说", "总体而言",
  "坦白讲", "说句实在话", "你懂的", "差不多得了", "就这样", "是啊", "哦对",
];

const PARTICLES = ["嗯", "啊", "哦", "嗨", "咳", "呣", "啧", "诶", "哈", "嗼", "呵"];

/** 统计每个特征在样本里的出现密度（每百字） */
function feats(text: string) {
  const len = text.length;
  const per100 = (n: number) => Number(((n / len) * 100).toFixed(2));

  // 1) 垫词总数
  let padTotal = 0;
  for (const p of PAD) padTotal += (text.split(p).length - 1);

  // 2) 垫词紧邻堆叠（垫词A，垫词B）
  let padStack = 0;
  for (const a of PAD) {
    for (const b of PAD) {
      if (text.includes(`${a}，${b}`) || text.includes(`${a},${b}`)) padStack++;
    }
  }

  // 3) 句中垫词（非句首位置出现的垫词，后面跟逗号）
  const PAD_MID_RE = new RegExp(`[^。！？\\n]{4,}(${PAD.join("|")})[，,]`, "g");
  const padMid = (text.match(PAD_MID_RE) ?? []).length;

  // 4) 碎片句：长度 <= 6 且独立成句
  const frags = text.split(/[。！？]/).filter((s) => {
    const t = s.replace(/\s/g, "");
    return t.length > 0 && t.length <= 6;
  }).length;
  const totalSent = text.split(/[。！？]/).filter((s) => s.trim()).length;

  // 5) 语气词在句中/句尾（后跟标点）
  const PART_RE = new RegExp(`[\\u4e00-\\u9fa5](${PARTICLES.join("|")})[。！？，]`, "g");
  const partInline = (text.match(PART_RE) ?? []).length;

  // 6) 语气词总量
  let partTotal = 0;
  for (const p of PARTICLES) partTotal += (text.split(p).length - 1);

  return {
    len,
    padTotal,
    padPer100: per100(padTotal),
    padStack,
    padMid,
    frags,
    totalSent,
    fragRatio: totalSent ? Number((frags / totalSent).toFixed(2)) : 0,
    partInline,
    partTotal,
    partPer100: per100(partTotal),
  };
}

console.log(
  "ID".padEnd(24), "类型", "垫词", "密度", "堆叠", "句中", "碎片比", "语气句", "语气密",
);
console.log("-".repeat(100));
for (const s of ALL_SAMPLES) {
  const f = feats(s.text);
  console.log(
    s.id.padEnd(22),
    s.expect === "human" ? "人写" : "引擎",
    String(f.padTotal).padStart(4),
    String(f.padPer100).padStart(5),
    String(f.padStack).padStart(4),
    String(f.padMid).padStart(4),
    String(f.fragRatio).padStart(6),
    String(f.partInline).padStart(5),
    String(f.partPer100).padStart(6),
  );
}

/* ---- 分离度汇总 ---- */
const H = ALL_SAMPLES.filter((s) => s.expect === "human").map((s) => feats(s.text));
const M = ALL_SAMPLES.filter((s) => s.expect === "machine").map((s) => feats(s.text));
const stat = (arr: number[]) => ({
  max: Math.max(...arr),
  min: Math.min(...arr),
  avg: arr.reduce((a, b) => a + b, 0) / arr.length,
});
const keys: (keyof ReturnType<typeof feats>)[] = [
  "padTotal", "padPer100", "padStack", "padMid", "fragRatio", "partInline", "partPer100",
];
console.log("\n特征分离度（H=人写组, M=引擎组）");
console.log("特征".padEnd(14), "H最大", "H均值", "M最小", "M均值", "可分");
console.log("-".repeat(70));
for (const k of keys) {
  const h = stat(H.map((x) => x[k] as number));
  const m = stat(M.map((x) => x[k] as number));
  const separable = h.max < m.min;
  console.log(
    k.padEnd(12),
    String(h.max).padStart(6),
    h.avg.toFixed(2).padStart(6),
    String(m.min).padStart(6),
    m.avg.toFixed(2).padStart(6),
    separable ? "  ✅ 完全可分" : (h.avg < m.avg ? "  ~ 均值可分" : "  ❌ 无效"),
  );
}
