import { humanizeWithScore } from "../src/engine/humanize.ts";

const samples: { name: string; text: string }[] = [
  {
    name: "AI 综述模板",
    text: "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。首先，它极大地提升了工作效率；其次，它显著降低了内容生产的门槛；最后，它为各行各业的转型升级注入了新的动能。综上所述，人工智能具有里程碑意义，展望未来，任重而道远。",
  },
  {
    name: "工作总结三段式",
    text: "回顾过去一年，我们在技术创新、市场拓展、团队建设等方面取得了丰硕成果。在技术创新方面，我们攻克了多项核心技术难题，实现了历史性跨越。在市场拓展方面，我们成功打入了多个新兴市场，市场份额稳步攀升。在团队建设方面，我们吸纳了一批优秀人才，队伍结构不断优化。展望未来，我们将继续深耕核心赛道，力争在新的一年里迈上了新的台阶。",
  },
  {
    name: "产品发布稿",
    text: "该产品的问世具有里程碑意义。关键在于，它通过大数据赋能传统产业，从根本上改变了行业格局。与此同时，它也为上下游产业链的协同发展发挥了至关重要的作用。值得注意的是，用户反馈显示产品体验显著提升，留存率持续向好。总而言之，该项目交出了一份满意的答卷。",
  },
];

for (const { name, text } of samples) {
  console.log("\n===== ", name, " =====");
  const before = humanizeWithScore(text, { intensity: 0, seed: 0 });
  const r07 = humanizeWithScore(text, { intensity: 0.7, seed: 42 });
  const r08 = humanizeWithScore(text, { intensity: 0.9, seed: 42 });
  const rzq = humanizeWithScore(text, {
    intensity: 0.9,
    seed: 42,
    zhuqueMode: true,
    style: "casual",
  });
  console.log("  原始 aiScore      :", before.before.score);
  console.log(
    "  强度 0.7 →        :",
    r07.after.score,
    " (降幅",
    before.before.score - r07.after.score,
    ")",
  );
  console.log(
    "  强度 0.9 →        :",
    r08.after.score,
    " (降幅",
    before.before.score - r08.after.score,
    ")",
  );
  console.log(
    "  强度 0.9 + 朱雀 → :",
    rzq.after.score,
    " (降幅",
    before.before.score - rzq.after.score,
    ")",
  );
  console.log(
    "  朱雀输出(首160字):",
    rzq.text.slice(0, 160).replace(/\n/g, "↵"),
  );
  console.log(
    "  仅强度0.9(首160):",
    r08.text.slice(0, 160).replace(/\n/g, "↵"),
  );
}
