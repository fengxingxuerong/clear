/**
 * scripts/_ceiling.ts —— 当前引擎各体裁"污染上限"探测（临时）
 *
 * 目的：M6/M7 两条 ENGINE-REAL 失效（论说最高 5 分、叙事恒 0 分），
 * 说明旧样本不再代表引擎行为。但失效方向有二：
 *   (a) 引擎变好了（污染真的被压下去了）→ 语料陈旧，重新摘录即可
 *   (b) 窗口收窄：某些特定输入 × 特定 seed 才会爆分 → 语料不能删，要补
 * 本脚本用「高 AI 味原文 + 最强档 + 多 seed」找出当前引擎的爆分样本，
 * 看是否还能造出 >=29 分的引擎真实输出。
 */
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";

type G = "main" | "narrative" | "dialogue" | "humanHand";

/** 强 AI 味原文（多段落、含套话、长句、排比） */
const SAMPLES: Array<{ id: string; genre: G; text: string }> = [
  {
    id: "论说-强AI味",
    genre: "main",
    text: `在当今数字化浪潮席卷全球的时代背景下，数字化转型已经成为了企业发展的必由之路。首先，数字化转型能够显著提升企业的运营效率。通过引入先进的信息技术，企业可以实现流程的自动化与智能化，从而大幅降低人力成本。其次，数字化转型有助于企业精准把握市场需求。借助大数据分析，企业能够深入了解用户行为，进而制定更加精准的营销策略。最后，数字化转型还是企业实现可持续发展的关键支撑。综上所述，数字化转型不仅是提升竞争力的重要举措，更是顺应时代潮流的战略选择。`,
  },
  {
    id: "叙事-强AI味",
    genre: "narrative",
    text: `那是一个阳光明媚的下午，我漫步在熟悉的街道上，心中充满了对往事的回忆。街道两旁的老树依然挺立，斑驳的树影洒在地面上，仿佛在诉说着岁月的故事。我不知不觉走到了那家老书店门前，推开门的瞬间，一股淡淡的书香扑面而来。店主是一位慈祥的老人，他微笑着向我点头示意。我在书架间徘徊，突然被一本泛黄的书吸引住了目光。翻开书页，熟悉的文字映入眼帘，勾起了我无数美好的回忆。`,
  },
  {
    id: "论说-垫词友好",
    genre: "main",
    text: `说白了，这个问题的本质其实就是利益分配。你懂的，大家都不傻。说到底，还是要看谁能扛住压力。话说回来，这事儿也不是一天两天了。怎么讲呢，反正就是这么个情况。说白了，谁都不想吃亏。`,
  },
];

for (const s of SAMPLES) {
  console.log(`\n===== ${s.id}（genre=${s.genre}）=====`);
  console.log(`  原文分 = ${aiScore(s.text).score.toFixed(1)}`);
  let max = 0;
  let maxSeed = 0;
  let maxIt = 0;
  for (const it of [0.6, 0.7, 0.8, 0.9, 1.0]) {
    const row: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const out = humanize(s.text, { intensity: it, seed, genre: s.genre, zhuqueMode: true });
      const sc = aiScore(out).score;
      row.push(sc.toFixed(0));
      if (sc > max) {
        max = sc;
        maxSeed = seed;
        maxIt = it;
      }
    }
    console.log(`  i=${it.toFixed(2)} 20seed分值: ${row.join(" ")}`);
  }
  console.log(`  ★ 最高 = ${max.toFixed(1)}（i=${maxIt}, seed=${maxSeed}）${max >= 29 ? " [仍可爆分]" : " [无法爆分]"}`);
  if (max >= 29) {
    console.log(`  [爆分样本输出]\n  ${humanize(s.text, { intensity: maxIt, seed: maxSeed, genre: s.genre, zhuqueMode: true })}`);
  }
}
