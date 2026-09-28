/**
 * 验证新评分方案（去掉 burstiness 反向项，改由 avgLen + 套话 + 病词 + 句式主导）
 * 是否能在所有已知样本上给出正确排序。
 * 这是改 humanize-metrics.ts 前的"过拟合检查"。
 */
import { sentenceStats } from "../src/engine/humanize-primitives.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";

const HUMAN_SHORT = `昨天下午去楼下那家面馆吃了碗牛肉面，28 块钱，说实话有点贵。面倒是挺筋道的，汤头也还行，就是牛肉切得薄得跟纸片似的，数了数大概就五六片。
老板是个四十来岁的河南人，挺能聊。他说这店开了八年了，之前在前街，后来房租涨得太狠就搬过来了。我问他现在生意咋样，他叹口气说，凑合吧，比以前差远了。
吃完我溜达回家，路上碰见老王遛狗。他家那条柴犬见我就扑，尾巴摇得跟风扇似的。老王说这狗就认我一个人，我心想那是它记着我上次给它喂过香肠。`;

const HUMAN_FORMAL = `各位同事：
根据集团第三季度经营分析会的工作部署，现将本单位本季度重点工作安排通知如下。
一、完成年度预算执行情况中期复核。各部门须于本月二十日前提交预算执行明细，财务部汇总后报总经理办公会审议。
二、推进信息系统等级保护测评整改。技术部牵头，各业务部门配合，务必在十月底前完成整改方案编制。
三、落实安全生产责任制的季度考核。此项工作由安全环保部负责组织，考核结果纳入部门年度绩效。`;

const AI_TYPICAL = `在当今数字化浪潮席卷全球的背景下，企业数字化转型已成为不可逆转的趋势。首先，数字化转型能够显著提升企业的运营效率。通过引入先进的信息技术，企业可以实现业务流程的自动化与智能化，从而大幅降低人力成本。
其次，数字化转型有助于企业更好地洞察市场需求。借助大数据分析技术，企业能够精准把握用户偏好，进而优化产品设计与营销策略，提升市场竞争力。此外，数据驱动的决策模式还能帮助企业快速响应市场变化，增强组织的敏捷性。
综上所述，数字化转型对企业发展具有重要的战略意义。企业应当积极拥抱数字化变革，构建完善的数据治理体系，从而在激烈的市场竞争中占据有利地位。展望未来，唯有持续创新，方能在数字经济时代赢得先机。`;

const ENGINE_BAD = `在今天这个快速发展的时代背景下，占 GDP 的比重达到了 41.8%。较上一年度同比提高了 2.3 个百分点。你懂的。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模再去年已经突破了 56.7 万亿元人民币。说白了。要我说，这一增长速度已经连续八年保持在 15% 以上。
说到底。企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来聊，可以从以下三个方面入手：首先。企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入是啊。不信？那你自己试试就知道了。`;

const SAMPLES: Array<[string, string, "low" | "high"]> = [
  ["人写·口语随笔", HUMAN_SHORT, "low"],
  ["人写·正式公文", HUMAN_FORMAL, "low"],
  ["AI·典型套话", AI_TYPICAL, "high"],
  ["引擎·劣质输出", ENGINE_BAD, "high"],
];

console.log("样本".padEnd(16) + "当前score  期望  CV    STD   avgLen  n");
console.log("-".repeat(70));
let ok = true;
for (const [name, t, want] of SAMPLES) {
  const st = sentenceStats(t);
  const sc = aiScore(t);
  const pass = want === "low" ? sc.score <= 20 : sc.score >= 40;
  if (!pass) ok = false;
  console.log(
    name.padEnd(16) +
      String(sc.score).padEnd(10) +
      want.padEnd(6) +
      st.cv.toFixed(2).padEnd(6) +
      st.std.toFixed(2).padEnd(6) +
      st.avg.toFixed(1).padEnd(8) +
      String(st.count).padEnd(4) +
      (pass ? "✅" : "❌"),
  );
}
console.log(`\n判定标准：人写 ≤20 分 / AI与劣质输出 ≥40 分  → ${ok ? "全部通过" : "有失败项"}`);
