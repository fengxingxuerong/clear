/**
 * scripts/_style_cost.ts —— 默认风格改 plain 的代价量化（临时）
 *
 * 决策问题：默认 style 从 casual 改成 plain？
 * 收益：污染上限大幅下降（_inj_ab.ts 数据）
 * 代价：去味力度可能下降 —— AI 味浓的文本改完仍被判机器？
 * 本脚本用"高 AI 味真实文本"测两档的**去味成功率**
 * （改后 < 29 分的比例），这是最终看重的指标。
 */
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";

const AI_TEXTS: Array<{ id: string; text: string }> = [
  {
    id: "A-公众号议论文",
    text: "在当今数字化浪潮席卷全球的时代背景下，数字化转型已经成为了企业发展的必由之路。首先，数字化转型能够显著提升企业的运营效率。通过引入先进的信息技术，企业可以实现流程的自动化与智能化，从而大幅降低人力成本。其次，数字化转型有助于企业精准把握市场需求。借助大数据分析，企业能够深入了解用户行为，进而制定更加精准的营销策略。最后，数字化转型还是企业实现可持续发展的关键支撑。综上所述，数字化转型不仅是提升竞争力的重要举措，更是顺应时代潮流的战略选择。",
  },
  {
    id: "B-工作总结",
    text: "过去一年，在公司领导的正确指导下，我认真履行岗位职责，努力完成各项工作任务。一是加强理论学习，不断提升自身素质。二是注重团队协作，积极配合同事完成项目。三是强化责任意识，确保工作质量。总的来说，这一年在各方面都取得了进步，但也存在不足。今后我将继续努力，争取更大成绩。",
  },
  {
    id: "C-产品介绍",
    text: "本产品采用了业内领先的核心技术，具备高效、稳定、安全的特点。首先，在性能方面，它能够满足各种复杂场景的需求。其次，在体验方面，它提供了简洁友好的操作界面。此外，在服务方面，我们提供全天候的技术支持。可以说，本产品是您的不二之选。",
  },
  {
    id: "D-议论文长文",
    text: "教育公平是社会公平的重要基础。值得注意的是，当前我国教育资源配置仍存在区域不平衡的问题。然而，随着国家对教育投入的持续加大，这一状况正在逐步改善。因此，我们应当保持理性和耐心。总的来说，教育公平的实现需要全社会的共同努力，绝非一朝一夕之功。",
  },
];

console.log("去味成功率（改后 < 29 分的比例），4 档 × 20 seed = 80 次/格\n");
console.log("文本".padEnd(18) + "原文  casual成功  casual均值/max  plain成功  plain均值/max");
for (const t of AI_TEXTS) {
  const before = aiScore(t.text).score;
  const res: Record<string, { ok: number; arr: number[] }> = { casual: { ok: 0, arr: [] }, plain: { ok: 0, arr: [] } };
  for (const style of ["casual", "plain"] as const) {
    for (const it of [0.6, 0.7, 0.8, 0.9]) {
      for (let seed = 1; seed <= 20; seed++) {
        const out = humanize(t.text, { intensity: it, seed, genre: "main", style, zhuqueMode: true });
        const a = aiScore(out).score;
        res[style].arr.push(a);
        if (a < 29) res[style].ok++;
      }
    }
  }
  const fmt = (s: "casual" | "plain") => {
    const a = res[s].arr;
    const avg = a.reduce((x, y) => x + y, 0) / a.length;
    return `${String(res[s].ok).padStart(2)}/80   ${avg.toFixed(1).padStart(5)}/${Math.max(...a).toFixed(0).padStart(3)}`;
  };
  console.log(t.id.padEnd(16) + String(before).padStart(4) + "   " + fmt("casual") + "       " + fmt("plain"));
}
