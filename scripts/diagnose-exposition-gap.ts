// scripts/diagnose-exposition-gap.ts
// 诊断论说体裁「压线 5pp」弱项
import fs from 'fs';
import path from 'path';
import { aiScore, splitSentences } from '../src/engine/humanize';
import { humanize } from '../src/engine/humanize';

// O1/O2/O3 对应 v0.7 旧档 "数字密集型论说文"：
// 这是 O1 原文档（33 分）的典型内容（v0.7 calibration-data 旧档已没存文本，按原始数字密集论说文风格复刻）
const EXPO_O1_RAW = `在今天这个快速发展的时代背景下，数字化转型已经成为了各行各业不可逆转的必然趋势。根据国家统计局最新发布的《2025 年数字经济发展白皮书》显示，我国数字经济规模在去年已经突破了 56.7 万亿元人民币，占 GDP 的比重达到了 41.8%，较上一年度同比提升了 2.3 个百分点。值得注意的是，这一增长速度已经连续八年保持在 15% 以上，充分体现了数字经济作为国民经济核心增长引擎的强大动力与韧性。
综上所述，企业如果想要在激烈的市场竞争中保持自身的优势地位，就必须加快推进数字化转型的战略布局。具体来说，可以从以下三个方面入手：首先，企业需要加大在云计算、大数据、人工智能等新一代信息技术领域的研发投入，根据相关调研数据显示，2025 年全球企业数字化研发预算平均占比已经达到了营收的 8.9%，而国内领先企业这一数字更是高达 12.3%；其次，企业需要重视数据资产的治理与运营，建立完善的数据采集、存储、分析、应用全链路管理体系，目前国内仅有不到 23% 的企业真正实现了数据资产化运营，这意味着绝大多数企业在这一领域还有非常大的提升空间；最后，也是最为重要的一点，企业需要培养和引进既懂业务又懂技术的复合型数字化人才，根据人社部发布的最新人才缺口报告显示，到 2027 年我国数字化人才缺口预计将超过 2500 万，人才争夺战正在进入前所未有的白热化阶段。
最后我想说，数字化转型并不是一蹴而就的简单工程，而是一场需要长期坚持、持续投入、系统推进的深刻变革。只有那些真正把数字化战略上升到企业核心战略层面，并脚踏实地、一步一个脚印去落地执行的企业，才能在未来十年甚至更长的时间周期里，始终立于不败之地，创造出属于自己的辉煌业绩。`;

// v2 JSON 直读
const V2_JSON = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts', 'calibration-data-v2-genres.json'), 'utf-8'));
const N3_TEXT = (V2_JSON.find((x:any)=>x.genre==='叙事' && x.level.includes('朱雀档')) as any)?.text;
const D3_TEXT = (V2_JSON.find((x:any)=>x.genre==='对话' && x.level.includes('朱雀档')) as any)?.text;
const H0_TEXT = (V2_JSON.find((x:any)=>x.genre==='纯人写稿' && x.level==='纯人写稿(无处理)') as any)?.text;

function dump(label: string, text: string) {
  const s = aiScore(text);
  const sens = splitSentences(text);
  const lens = sens.map(t => t.replace(/\s/g,'').length);
  const lensSorted = [...lens].sort((a,b)=>a-b);
  // 句首字去重率：前 N 句首字不同的数量 / N
  const firsts = sens.slice(0, Math.min(10, sens.length)).map(t => t.trim().replace(/[\s"“‘《（(【\-—·\d.]/g,'').charAt(0)).filter(Boolean);
  const uFirst = new Set(firsts).size;
  const firstDiversity = firsts.length === 0 ? 0 : uFirst / firsts.length;
  // 列举硬编号
  const enumMatches = text.match(/[（(]?\s*\d+\s*[）)、\s.]?\s*[^，。；：\n]{2,20}[：:；。]/g) || [];
  const enumHard = enumMatches.length;
  // 首先/其次/最后/值得注意的是/综上所述 等论说专用模式
  const expoMarkers = ['首先','其次','再次','最后','综上所述','值得注意的是','具体来说','具体而言','从以下几个方面','研究表明','数据显示','报告显示','白皮书显示','根据.*显示','调查数据显示'];
  const expoHits = expoMarkers.reduce((n,p)=>n + (text.match(new RegExp(p,'g'))?.length || 0), 0);
  // 段首句长方差（段的第一句）
  const paraFirstSentLens: number[] = [];
  const paras = text.split(/\n+/).filter(p => p.trim().length > 5);
  for (const p of paras) {
    const s1 = splitSentences(p)[0];
    if (s1) paraFirstSentLens.push(s1.replace(/\s/g,'').length);
  }
  const pMean = paraFirstSentLens.length? paraFirstSentLens.reduce((a,b)=>a+b,0)/paraFirstSentLens.length : 0;
  const pStd = paraFirstSentLens.length ? Math.sqrt(paraFirstSentLens.reduce((s,n)=>s+(n-pMean)**2,0)/paraFirstSentLens.length) : 0;
  const pCV = pMean ? pStd/pMean : 0;
  console.log(`\n━━ ${label} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`text len(chars)=${text.replace(/\s/g,'').length}  sentences=${sens.length}`);
  console.log(`aiScore=${s.score}  formulaicHits=${s.formulaicHits}  burstiness=${s.burstiness}  avgLen=${s.avgLen}`);
  console.log(`句长分布 (字)：min=${lensSorted[0]??0}  p25=${lensSorted[Math.floor(lensSorted.length*0.25)]??0}  med=${lensSorted[Math.floor(lensSorted.length*0.5)]??0}  p75=${lensSorted[Math.floor(lensSorted.length*0.75)]??0}  max=${lensSorted[lensSorted.length-1]??0}`);
  console.log(`句首模式（前10句首字）：多样性=${(firstDiversity*100).toFixed(0)}% (${uFirst}/${firsts.length}个不同) —— 朱雀非常敏感这个`);
  console.log(`硬编号列举 (1./2./(1)/(2) 后跟冒号句号)：${enumHard}处 —— 论说文高频重灾区`);
  console.log(`论说模板词（首先/其次/最后/综上所述/值得注意的是/数据显示…）：${expoHits}处 —— 论说专属指纹`);
  console.log(`段首句长变异系数 CV=${pCV.toFixed(2)} (均值${pMean.toFixed(0)}字，σ=${pStd.toFixed(0)}) —— AI 写段首句长一致`);
  return { s, label, lensSorted, firstDiversity, enumHard, expoHits, pCV };
}

type DumpResult = ReturnType<typeof dump>;
function compareGap(base: DumpResult, target: DumpResult, label: string) {
  console.log(`\n   ↳ 与【${target.label}】差距 (${label})：`);
  console.log(`     aiScore 差：${base.s.score} − ${target.s.score} = ${(base.s.score-target.s.score)} 分（要压下去这个数）`);
  console.log(`     套话命中差：${base.s.formulaicHits} − ${target.s.formulaicHits} = ${base.s.formulaicHits-target.s.formulaicHits}（每差1个≈6 aiScore 分）`);
  console.log(`     burstiness 差：${target.s.burstiness} − ${base.s.burstiness} = ${(target.s.burstiness-base.s.burstiness).toFixed(2)}（越高越好，每 0.06 ≈ 3 aiScore 分）`);
  console.log(`     句首多样性差：${(target.firstDiversity*100).toFixed(0)}% − ${(base.firstDiversity*100).toFixed(0)}% = ${((target.firstDiversity-base.firstDiversity)*100).toFixed(0)}%`);
  console.log(`     硬编号列举差：${base.enumHard} − ${target.enumHard} = ${base.enumHard-target.enumHard}`);
  console.log(`     论说模板词差：${base.expoHits} − ${target.expoHits} = ${base.expoHits-target.expoHits}（这一项只在论说有）`);
  console.log(`     段首句长 CV 差：${(target.pCV-base.pCV).toFixed(2)}`);
}

console.log('========== 论说压线诊断：O2(官45%) vs N3(官18%) vs D3(官25%) vs H0(官15%) vs 补强后 O2_0.9_zhuque ==========');
dump('O1 论说·原文（0.7档官方没测，参照基准）', EXPO_O1_RAW);
const O2_TEXT = humanize(EXPO_O1_RAW, { intensity: 0.7, zhuqueMode: false });
const o2 = dump('O2 论说·本地引擎 0.7（关朱雀 · 官方实测 45% · 差5pp压线 ✅诊断主对象）', O2_TEXT);
const O3_TEXT = humanize(EXPO_O1_RAW, { intensity: 0.9, zhuqueMode: true });
const o3 = dump('O3 论说·深度闭环模拟（intensity 0.9 + 开朱雀增强 · 预期官方~30%）', O3_TEXT);
const n3 = dump('N3 叙事·朱雀档 0.9（官方实测 18% ✅ 最佳样本标杆）', N3_TEXT);
dump('D3 对话·朱雀档 0.9（官方实测 25% ✅ 宽松标杆）', D3_TEXT);
const h0 = dump('H0 纯人写·无处理（官方实测 15% ✅ 误杀地板标杆）', H0_TEXT);

console.log('\n\n========== 差距解读：O2 相对 N3(标杆) 还缺什么 ==========');
compareGap(o2, n3, '论说-最佳叙事标杆');
compareGap(o2, h0, '论说-人写标杆');
compareGap(o3, o2, 'O3(开增强0.9) vs O2(0.7关) —— 「开朱雀增强」能补多少');

// 最后做"能让 O2 从官45%降到≤30%"的目标 aiScore 反推：
// 论说线 y=2.008x+19.2 ≤ 30 → x ≤ (30-19.2)/2.008=5.38 → x≤5
// 论说线 y≤40 → x≤10.4（现在 O2 x=10，刚好压线）
console.log('\n\n========== 目标反推 ==========');
console.log('论说线 y=2.008x + 19.2：');
console.log('  y≤40 (过人线) → x ≤ 10.4    O2 实测 x=10  → 刚好压线，所以官=45% 差 5pp 是 10/10.4 这 0.4 的边界效应');
console.log('  y≤30 (深绿稳过) → x ≤ 5.4   O2 现在 x=10 → 还差至少 5 分的 aiScore 下降空间');
console.log('  y≤35 (稳健过人) → x ≤ 7.9');
console.log('\n【P3 论说专项补强建议】（按上述 gap 拆解对症下药）：');
console.log('  ① 套话命中再 -4 → aiScore -24 → 但现在 hits 本来就不多，说明主要不是词；瓶颈是结构：');
console.log('  ② 句首多样性从 60%→80%（前10句首字不同）→ burstiness +0.1 → aiScore -5');
console.log('  ③ 硬编号列举 0 处 → expoHits（首先/其次/最后）减半 → aiScore -4');
console.log('  ④ 段首句长 CV 从 0.1→0.4+ → burstiness +0.15 → aiScore -7.5');
console.log('  ⑤ 每篇插入 2 句第一人称经验句（"我自己做过""我在项目里碰到过"）→ 降低官方对"冰冷学术腔"的判定权重 ~+5 分效果（非 aiScore，直接官分）');
