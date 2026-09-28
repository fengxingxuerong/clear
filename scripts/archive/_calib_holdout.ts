/**
 * 权重寻优：把各检测项权重当超参数，在训练集上扫，在验证集上验。
 * 目的：避免逐个样本手调导致的过拟合。
 *
 * 训练集 = _calib_corpus.ts 的样本
 * 验证集 = 下面新写的样本（标定时不参与寻优，只做最终检验）
 */
import { aiScore } from "../src/engine/humanize-metrics.ts";
import { ALL_SAMPLES } from "./_calib_corpus.ts";

// 验证集：与训练集同分布但内容不同，用于检验是否过拟合
const HOLDOUT: [string, "human" | "machine", string][] = [
  ["V1-真人散文", "human", `春天的风带着点土腥味，吹在脸上很舒服。我沿着河边慢慢走，看着柳条在水面上划出一道道波纹。有个老人在钓鱼，一动不动，像尊雕塑。`],
  ["V2-真人随笔（单个垫词）", "human", `说实话，我对这事儿一直没想明白。你说它重要吧，好像也没那么重要；说它不重要吧，又确实影响挺大。`],
  ["V3-真人公文", "human", `根据年度工作安排，现就有关事项通知如下：一、加强组织领导；二、明确责任分工；三、强化督导检查。`],
  ["V4-真人对话", "human", `【场景：办公室】
小王：这版设计你觉得怎么样？
老李：整体可以，就是配色有点跳。`],
  ["V5-引擎垫词堆叠", "machine", `讲真，说白了，这事儿得两面看。老实讲，其实吧，谁都不容易。`],
  ["V6-引擎语气词", "machine", `他昨天来过了诶。说了一会儿话哦。走的时候天已经黑了嗼。`],
  ["V7-引擎碎片句", "machine", `项目延期了。你懂的。客户很不高兴。差不多得了。`],
  ["V8-引擎复合", "machine", `说真的，技术这事儿啊，得慢慢来呣。你懂的。反正就那样。说到底。急也没用呵。`],
];

interface Weights {
  tailParticle: number;
  orphanConn: number;
  typo: number;
  padSentence: number;
  pollutionMid: number;
  pollutionHigh: number;
  pollutionFull: number;
}

const BASE: Weights = {
  tailParticle: 10, orphanConn: 10, typo: 14, padSentence: 9,
  pollutionMid: 12, pollutionHigh: 20, pollutionFull: 30,
};

// 复用 aiScore 的当前实现（已含权重），此处只做"当前配置"的评估
function evaluate(label: string, samples: { id: string; expect: string; text: string }[]) {
  let hErr = 0, mMiss = 0;
  const detail: string[] = [];
  for (const s of samples) {
    const sc = aiScore(s.text).score;
    const ok = s.expect === "human" ? sc < 29 : sc >= 29;
    if (!ok) {
      if (s.expect === "human") hErr++; else mMiss++;
      detail.push(`    ${s.id.padEnd(20)} score=${String(sc).padStart(3)} 期望=${s.expect}`);
    }
  }
  console.log(`\n[${label}] 误伤=${hErr}  漏判=${mMiss}  综合错判=${hErr + mMiss}`);
  if (detail.length) console.log(detail.join("\n"));
  return { hErr, mMiss };
}

console.log("当前权重:", JSON.stringify(BASE));
const train = evaluate("训练集", ALL_SAMPLES);
const hold = evaluate("验证集（不参与标定）", HOLDOUT.map(([id, expect, text]) => ({ id, expect, text })));

console.log("\n验证集逐样本得分：");
for (const [id, expect, text] of HOLDOUT) {
  const sc = aiScore(text).score;
  const ok = expect === "human" ? sc < 40 : sc >= 40;
  console.log(`  ${id.padEnd(22)} ${String(sc).padStart(3)}  期望=${expect}  ${ok ? "✓" : "✗"}`);
}
console.log(`\n总错判 = ${train.hErr + train.mMiss + hold.hErr + hold.mMiss} / ${ALL_SAMPLES.length + HOLDOUT.length}`);
