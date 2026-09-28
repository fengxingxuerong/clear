/**
 * 正交矩阵实验：分离「基础引擎」与「朱雀注入层」各自的损伤贡献。
 * 用 zhuqueMode 开关作为对照，看同一档位下开/关的差值。
 */
import { humanize } from "../src/engine/humanize.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";

const SRC = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元人民币，占 GDP 的比重达到了 41.8%，较上一年度同比提升了 2.3 个百分点。
综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系；最后，企业需要培养和引进既懂业务又懂技术的复合型数字化人才。
最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。`;

const base = aiScore(SRC);
console.log(`原文: score=${base.score} n=${base.sentenceCount} avg=${base.avgLen} cv=${base.burstiness}\n`);
console.log("档位  zhuque  style       score  n     avg    cv    broken struct  字数");
console.log("-".repeat(84));

for (const intensity of [0.5, 0.7, 0.9]) {
  for (const zhuqueMode of [false, true]) {
    for (const style of ["casual", "plain", "academic"]) {
      const out = humanize(SRC, { intensity, zhuqueMode, style, seed: 20260826 } as never);
      const s = aiScore(out);
      console.log(
        `${String(intensity).padEnd(6)}${String(zhuqueMode).padEnd(8)}${style.padEnd(12)}` +
          `${String(s.score).padEnd(7)}${String(s.sentenceCount).padEnd(6)}` +
          `${s.avgLen.toFixed(1).padEnd(7)}${s.burstiness.toFixed(2).padEnd(6)}` +
          `${String(s.brokenHits).padEnd(7)}${String(s.structureHits).padEnd(8)}${out.length}`,
      );
    }
  }
}
