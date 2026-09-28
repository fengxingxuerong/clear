/**
 * scripts/_v098_final.ts —— v0.9.8 P0 收敛最终验收（临时）
 *
 * 覆盖本轮全部改动：
 *   1) 默认风格 casual → plain
 *   2) SOFT_ENDINGS 剔除「哈」
 *   3) plain 自问自答走克制池（原 isCasual 误锁）
 *   4) VOCAB 中「说到底」替身（4 处）改写为安全词
 * 指标：去味成功率 / 污染上界 / 叙事零劣化 / 红线
 */
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";

console.log("═".repeat(76));
console.log("一、去味成功率（默认档 plain，改后 < 29 为通过）");
console.log("═".repeat(76));
const AIS: Array<{ id: string; text: string }> = [
  { id: "A-公众号议论文", text: "在当今数字化浪潮席卷全球的时代背景下，数字化转型已经成为了企业发展的必由之路。首先，数字化转型能够显著提升企业的运营效率。通过引入先进的信息技术，企业可以实现流程的自动化与智能化，从而大幅降低人力成本。其次，数字化转型有助于企业精准把握市场需求。借助大数据分析，企业能够深入了解用户行为，进而制定更加精准的营销策略。最后，数字化转型还是企业实现可持续发展的关键支撑。综上所述，数字化转型不仅是提升竞争力的重要举措，更是顺应时代潮流的战略选择。" },
  { id: "B-工作总结", text: "过去一年，在公司领导的正确指导下，我认真履行岗位职责，努力完成各项工作任务。一是加强理论学习，不断提升自身素质。二是注重团队协作，积极配合同事完成项目。三是强化责任意识，确保工作质量。总的来说，这一年在各方面都取得了进步，但也存在不足。今后我将继续努力，争取更大成绩。" },
  { id: "C-产品介绍", text: "本产品采用了业内领先的核心技术，具备高效、稳定、安全的特点。首先，在性能方面，它能够满足各种复杂场景的需求。其次，在体验方面，它提供了简洁友好的操作界面。此外，在服务方面，我们提供全天候的技术支持。可以说，本产品是您的不二之选。" },
  { id: "D-议论文长文", text: "教育公平是社会公平的重要基础。值得注意的是，当前我国教育资源配置仍存在区域不平衡的问题。然而，随着国家对教育投入的持续加大，这一状况正在逐步改善。因此，我们应当保持理性和耐心。总的来说，教育公平的实现需要全社会的共同努力，绝非一朝一夕之功。" },
];
for (const t of AIS) {
  const before = aiScore(t.text).score;
  const arr: number[] = [];
  for (const it of [0.6, 0.7, 0.8, 0.9]) {
    for (let seed = 1; seed <= 20; seed++) {
      arr.push(aiScore(humanize(t.text, { intensity: it, seed, genre: "main", zhuqueMode: true })).score);
    }
  }
  const ok = arr.filter((x) => x < 29).length;
  const avg = arr.reduce((x, y) => x + y, 0) / arr.length;
  console.log(`  ${t.id.padEnd(16)} 原文${String(before).padStart(3)}  →  通过 ${ok}/80  均值 ${avg.toFixed(1)}  最高 ${Math.max(...arr)}  ${ok === 80 && Math.max(...arr) < 29 ? "✅" : "❌"}`);
}

console.log("");
console.log("═".repeat(76));
console.log("二、污染上界（原文已污染的文本，改后不应升高）");
console.log("═".repeat(76));
const POLL: Array<{ id: string; text: string }> = [
  { id: "垫词堆叠", text: "说白了，这个问题的本质其实就是利益分配。你懂的，大家都不傻。说到底，还是要看谁能扛住压力。话说回来，这事儿也不是一天两天了。说白了，谁都不想吃亏。" },
  { id: "连接词堆叠", text: "今天我们来讲讲这个话题。值得注意的是，这个问题很复杂。然而，我们不能忽视它。因此，我们需要认真对待。总的来说，这很重要。" },
];
for (const t of POLL) {
  const before = aiScore(t.text).score;
  let up = 0;
  let max = -1;
  for (const it of [0.6, 0.7, 0.8, 0.9]) {
    for (let seed = 1; seed <= 20; seed++) {
      const a = aiScore(humanize(t.text, { intensity: it, seed, genre: "main", zhuqueMode: true })).score;
      if (a > before + 1) up++;
      if (a > max) max = a;
    }
  }
  console.log(`  ${t.id.padEnd(12)} 原文${String(before).padStart(3)}  升高 ${up}/80  最高 ${max}  ${up <= 3 ? "✅" : "⚠️"}`);
}

console.log("");
console.log("═".repeat(76));
console.log("三、叙事/人写零劣化（原文 0 分，改后必须仍 0 分）");
console.log("═".repeat(76));
const NARR: Array<{ id: string; genre: "narrative" | "humanHand"; text: string }> = [
  { id: "叙事", genre: "narrative", text: "那是一个阳光明媚的下午，我漫步在熟悉的街道上。街道两旁的老树依然挺立。我不知不觉走到了那家老书店门前。店主是一位慈祥的老人。" },
  { id: "人写", genre: "humanHand", text: "昨儿个下大雨，我懒得出门，就窝在沙发上翻旧相册。看着看着，想起小时候跟姥姥去赶集的事。那会儿一块钱能买一堆糖，甜得我直咧嘴。" },
];
for (const t of NARR) {
  let max = -1;
  for (const it of [0.6, 0.7, 0.8, 0.9]) {
    for (let seed = 1; seed <= 20; seed++) {
      const a = aiScore(humanize(t.text, { intensity: it, seed, genre: t.genre, zhuqueMode: true })).score;
      if (a > max) max = a;
    }
  }
  console.log(`  ${t.id.padEnd(8)} 最高 ${max}  ${max === 0 ? "✅ 零劣化" : "❌"}`);
}
