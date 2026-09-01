// scripts/gen-calibration-texts.ts
// 输出 A/B/C 三组样本的 (原文, 基础档, 朱雀档) 共 9 段文本 + aiScore 到 JSON
// 运行: npx tsx scripts/gen-calibration-texts.ts
import { humanize } from '../src/engine/humanize';
import { aiScore } from '../src/engine/humanize-metrics';

const SAMPLE_A = `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。
综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。
然而，技术的变革也带来了一系列值得关注的挑战。
与此同时，如何平衡创新与风险，成为至关重要的课题。
从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。
因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的发展。`;

const SAMPLE_B = `过去一年，我们紧紧围绕总体目标，统筹推进各项重点任务，在全体同仁的共同努力下，各项工作取得了显著成效。
具体来说，第一，我们建立了更加规范的管理制度，确保各项工作有章可循、有据可依。
第二，我们大力推进业务创新，打造了一批具有核心竞争力的特色产品，市场占有率稳步提升。
第三，我们全面加强团队建设，组织多轮专业培训，优化了人才梯队结构，员工能力显著增强。
综上所述，过去的一年是砥砺奋进的一年，也是硕果累累的一年。
展望未来，我们将继续保持战略定力，攻坚克难，锐意进取，努力开创事业发展的新局面。`;

const SAMPLE_C = `今天，我们非常高兴地宣布，公司新一代产品正式发布。
本次发布的产品采用了行业领先的核心技术，全面提升了用户体验，具有里程碑意义。
具体而言，产品在性能上实现了历史性跨越，关键指标相较于上一代提升了百分之五十以上。
在生态建设方面，我们与多家知名合作伙伴达成深度战略合作，共同构建开放共赢的产业生态。
值得一提的是，我们还同步推出了覆盖全流程的客户服务体系，从根本上解决了用户的后顾之忧。
总而言之，本次发布不仅标志着公司发展迈入了新的阶段，也为整个行业的未来发展指明了方向。`;

type Entry = {
  groupId: 'A' | 'B' | 'C';
  groupName: string;
  level: '原文' | '基础档' | '朱雀档';
  intensity: number;
  zhuque: boolean;
  aiScore: number;
  burstiness: number;
  avgLen: number;
  text: string;
};

const groups: Array<{ id: 'A' | 'B' | 'C'; name: string; src: string }> = [
  { id: 'A', name: 'AI综述模板（套话密集）', src: SAMPLE_A },
  { id: 'B', name: '工作总结三段式（总分总+列举）', src: SAMPLE_B },
  { id: 'C', name: '产品发布稿（里程碑/总而言之）', src: SAMPLE_C },
];

const levels: Array<{ k: Entry['level']; intensity: number; zhuque: boolean }> = [
  { k: '原文', intensity: 0, zhuque: false },
  { k: '基础档', intensity: 0.6, zhuque: false },
  { k: '朱雀档', intensity: 0.9, zhuque: true },
];

const out: Entry[] = [];
for (const g of groups) {
  for (const lv of levels) {
    let text = g.src;
    if (lv.k !== '原文') {
      text = humanize(g.src, { intensity: lv.intensity, zhuqueMode: lv.zhuque, seed: 20260825 });
    }
      const breakdown = aiScore(text);
      out.push({
        groupId: g.id,
        groupName: g.name,
        level: lv.k,
        intensity: lv.intensity,
        zhuque: lv.zhuque,
        aiScore: Math.round(breakdown.score * 100) / 100,
        burstiness: Math.round(breakdown.burstiness * 100) / 100,
        avgLen: Math.round(breakdown.avgLen * 10) / 10,
        text,
      });
  }
}

console.log('# 生成标定样本 ' + new Date().toISOString());
console.log('| 组别 | 档位 | 强度 | 朱雀 | aiScore | 套话 | burstiness | 句长 | 字数 |');
console.log('|---|---|---:|---|---:|---:|---:|---:|---:|');
for (const e of out) {
  console.log(`| ${e.groupId}-${e.groupName.split('（')[0]} | ${e.level} | ${e.intensity} | ${e.zhuque ? '开' : '关'} | ${e.aiScore} | ${(e as any).formulaicHits} | ${(e as any).burstiness} | ${(e as any).avgLen} | ${[...e.text].length} |`);
}
console.log('\n# JSON 写入 scripts/calibration-data.json\n');
import fs from 'fs';
import path from 'path';
const outPath = path.join(process.cwd(), 'scripts', 'calibration-data.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');
console.log('OK ->', outPath);
