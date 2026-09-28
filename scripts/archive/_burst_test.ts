/**
 * 验证 burstiness 与"像不像人写"的真实关系：
 * 取多个人写样本 vs AI 样本，看 CV 分布到底是不是"越高越像人"。
 */
import { aiScore } from "../src/engine/humanize-metrics.ts";
import { sentenceStats } from "../src/engine/humanize-primitives.ts";

const HUMAN_LONG = `昨天下午去楼下那家面馆吃了碗牛肉面，28 块钱，说实话有点贵。面倒是挺筋道的，汤头也还行，就是牛肉切得薄得跟纸片似的，数了数大概就五六片。老板是个四十来岁的河南人，挺能聊。他说这店开了八年了，之前在前街，后来房租涨得太狠就搬过来了。我问他现在生意咋样，他叹口气说，凑合吧，比以前差远了。
吃完我溜达回家，路上碰见老王遛狗。他家那条柴犬见我就扑，尾巴摇得跟风扇似的。老王说这狗就认我一个人，我心想那是它记着我上次给它喂过香肠。`;
// 补长一点，模拟人写长文的节奏
const HUMAN_LONG2 = HUMAN_LONG + `
晚上刷手机看到个帖子，说现在年轻人都流行"断亲"，我看了半天没太看懂。亲戚这东西吧，远了近了都别扭，躲不开也躲不干净。我跟我表弟一年到头也说不上两句话，过年见一面，客套几句，然后各回各家。
其实想想，也没啥大不了的。人到中年就明白了，关系这东西是靠处出来的，不靠血缘绑。谁对你好你就对谁好，挺简单个事。`;

const AI_TYPICAL = `在当今数字化浪潮席卷全球的背景下，企业数字化转型已成为不可逆转的趋势。首先，数字化转型能够显著提升企业的运营效率。通过引入先进的信息技术，企业可以实现业务流程的自动化与智能化，从而大幅降低人力成本。
其次，数字化转型有助于企业更好地洞察市场需求。借助大数据分析技术，企业能够精准把握用户偏好，进而优化产品设计与营销策略，提升市场竞争力。此外，数据驱动的决策模式还能帮助企业快速响应市场变化，增强组织的敏捷性。
综上所述，数字化转型对企业发展具有重要的战略意义。企业应当积极拥抱数字化变革，构建完善的数据治理体系，从而在激烈的市场竞争中占据有利地位。展望未来，唯有持续创新，方能在数字经济时代赢得先机。`;

const AI_UNIFORM = `人工智能技术正在深刻改变我们的生活方式。它能够提高工作效率，降低运营成本，优化资源配置。同时，它也在医疗、教育、金融等领域展现出巨大的应用潜力。
然而，人工智能的发展也带来了一些挑战。数据隐私问题日益突出，算法偏见引发社会关注，就业结构调整压力增大。因此，我们需要在拥抱技术进步的同时，建立相应的监管机制。
总体而言，人工智能是一把双刃剑。我们应当理性看待其利弊，既要充分利用其优势，也要防范其风险，从而实现技术与人性的和谐共生。`;

const SAMPLES: Array<[string, string]> = [
  ["人写·口语短", HUMAN_LONG],
  ["人写·口语长", HUMAN_LONG2],
  ["AI·典型套话", AI_TYPICAL],
  ["AI·均匀排比", AI_UNIFORM],
];

console.log("样本".padEnd(14) + "CV    STD   avgLen  score");
console.log("-".repeat(50));
for (const [name, t] of SAMPLES) {
  const st = sentenceStats(t);
  const sc = aiScore(t);
  console.log(
    name.padEnd(14) +
      st.cv.toFixed(2).padEnd(6) +
      st.std.toFixed(2).padEnd(6) +
      st.avg.toFixed(1).padEnd(8) +
      String(sc.score).padEnd(6) +
      `  n=${st.count}`,
  );
}

console.log("\n=== 结论检查 ===");
console.log("若「人写口语」CV 明显低于「AI 均匀排比」，则「CV 低=AI」的假设是错的");
const h = sentenceStats(HUMAN_LONG);
const a = sentenceStats(AI_UNIFORM);
console.log(`人写口语 CV=${h.cv.toFixed(2)}  vs  AI均匀排比 CV=${a.cv.toFixed(2)}`);
