/**
 * A/B 方案实测：默认风格改保守档 vs 调低 casual 激进度，
 * 哪个在不牺牲去味效果的前提下损伤更小？
 *
 * 跑全部 12 样本（4 体裁 × 3 档）在多风格下的分数矩阵。
 */
import { humanize } from "../src/engine/humanize.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";

// 12 样本：与 regression-12samples.ts 同套（体裁 × 档位）
const EXPO_O1 = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元人民币，占 GDP 的比重达到了 41.8%，较上一年度同比提升了 2.3 个百分点。值得注意的是，这一增长速度已经连续八年保持在 15% 以上，充分体现了数字经济作为国民经济核心增长引擎的强大动力与韧性。
综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入，根据相关调研数据显示，2025 年全球企业数字化研发预算平均占比已经达到了营收的 8.9%，而国内领先企业这一数字更是高达 12.3%；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系，目前国内仅有不到 23% 的企业真正实现了数据资产化运营；最后，企业需要培养和引进既懂业务又懂技术的复合型数字化人才，到 2027 年我国数字化人才缺口预计将超过 2500 万。
最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有那些真正把数字化战略上升到企业核心战略层面，并脚踏实地、一步一个脚印去落地执行的企业，才能在未来十年甚至更长的时间周期里，始终立于不败之地。`;

const NARRATIVE = `老城区那条巷子，我小时候天天走。石板路被踩得发亮，墙角长着青苔，一到梅雨季就滑得很。
巷口有家修鞋铺，老师傅姓周，戴副老花镜，手里的锥子来回穿梭。他修一双鞋收五块，从不还价。
后来巷子拆了。周师傅的铺子搬到了三条街外，我去看过一次，门口挂着新招牌，字还是他自己写的。他抬头看我，愣了一下，说，长这么大了。`;

const DIALOGUE = `李工（前端负责人）：张总您好，我这边负责的前端模块目前进展比较顺利。具体来说，所有核心功能页面的开发工作已经完成了百分之九十五以上，剩下的就是一些 UI 细节的微调以及和后端接口的最后联调。
张总（项目总监）：好，那支付模块的重构情况怎么样？这块是今年最大的风险点，我需要一个明确的答复。
李工：支付模块的重构已经完成了百分之八十，主要的技术难点都已经攻克了。不过在压测环节发现了一些性能瓶颈，建议这周安排一次专项压测。`;

const HUMAN = `昨天下午去楼下那家面馆吃了碗牛肉面，28 块钱，说实话有点贵。面倒是挺筋道的，汤头也还行，就是牛肉切得薄得跟纸片似的，数了数大概就五六片。
老板是个四十来岁的河南人，挺能聊。他说这店开了八年了，之前在前街，后来房租涨得太狠就搬过来了。我问他现在生意咋样，他叹口气说，凑合吧，比以前差远了。`;

const SAMPLES: Array<[string, string]> = [
  ["论说·原文", EXPO_O1],
  ["叙事·原文", NARRATIVE],
  ["对话·原文", DIALOGUE],
  ["人写·原文", HUMAN],
];

const STYLES = ["casual", "plain", "academic"];
const INTENSITIES = [0.5, 0.7, 0.9];

console.log("样本".padEnd(12) + "档位  " + STYLES.map((s) => s.padEnd(11)).join("") + "  | 字数变化(casual/plain)");
console.log("-".repeat(92));

const agg: Record<string, number[]> = {};
for (const s of STYLES) agg[s] = [];

for (const [name, text] of SAMPLES) {
  const before = aiScore(text);
  console.log(`\n【${name}】原文 score=${before.score} n=${before.sentenceCount} avg=${before.avgLen.toFixed(1)}`);

  for (const intensity of INTENSITIES) {
    const row: string[] = [];
    const lens: number[] = [];
    for (const style of STYLES) {
      const out = humanize(text, { intensity, zhuqueMode: true, style, seed: 20260826 } as never);
      const sc = aiScore(out);
      agg[style].push(sc.score);
      row.push(`${String(sc.score).padEnd(3)}(${String(sc.brokenHits).padStart(1)}/${String(sc.structureHits).padStart(1)})`.padEnd(11));
      lens.push(out.length);
    }
    console.log(`  ${String(intensity).padEnd(6)}${row.join("")}  | ${lens[0]}/${text.length} → ${lens[1]}/${text.length}`);
  }
}

console.log(`\n${"=".repeat(92)}`);
console.log("汇总（全部 12 次运行）:");
for (const s of STYLES) {
  const arr = agg[s];
  const avgScore = arr.reduce((a, b) => a + b, 0) / arr.length;
  const max = Math.max(...arr);
  const min = Math.min(...arr);
  console.log(`  ${s.padEnd(10)} 均值=${avgScore.toFixed(1).padStart(5)}  最低=${String(min).padStart(3)}  最高=${String(max).padStart(3)}`);
}
