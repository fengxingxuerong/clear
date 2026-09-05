/**
 * scripts/check-vocab-hygiene.ts
 * 词表卫生检查：VOCAB 替身本身不得是高危套话/官方腔/探针黑名单词。
 * 否则引擎"替换套话"的输出仍然是套话——v5.2 指纹残留 / v6.0 公文腔回潮的直接来源。
 * 用法：npx tsx scripts/check-vocab-hygiene.ts   （exit 0=干净 1=有违规）
 */
import { VOCAB } from "../src/engine/humanize-vocab";
import { FORMULAIC_EXTRA } from "../src/engine/humanize-vocab-extra";

// 与 scan-bugs v5.2 killerIntro / v6.0 OFFICIALESE 保持一致的 prohibiting 集合
const KILLER_INTRO = [
  "值得注意的是", "值得一提的是", "毋庸置疑", "毋庸讳言", "不可否认", "众所周知",
  "归根结底", "归根到底", "综上所述", "总而言之", "总的说来", "总的来说",
  "简而言之", "一言以蔽之", "由此可见",
];
const OFFICIALESE = [
  "总体设计", "按图推进", "长期坚持", "夯实根基", "守牢防线", "加深优势", "盘活资产",
  "填平缺口", "拉长长板", "做亮招牌", "排忧解难", "拓宽路子", "架起平台", "顶层规划", "凑成共识",
];
const FORBIDDEN = new Set([...KILLER_INTRO, ...OFFICIALESE, ...FORMULAIC_EXTRA]);

let bad = 0;
for (const [from, tos] of Object.entries(VOCAB)) {
  for (const to of tos) {
    if (FORBIDDEN.has(to)) {
      console.log(`❌ ${from} → "${to}"（替身本身是套话/官方腔）`);
      bad++;
    }
  }
}
console.log(bad === 0 ? "✅ 词表卫生检查通过：无替身落入黑名单" : `❌ 共 ${bad} 条替身落入黑名单`);
if (bad > 0) process.exit(1);
