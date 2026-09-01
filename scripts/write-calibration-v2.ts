// scripts/write-calibration-v2.ts
import fs from 'fs';
import path from 'path';
const r = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts', 'zhuque-v2-fit-result.json'), 'utf-8'));
const { input } = r;

function olsLine(pts: Array<{x:number;y:number}>){
  const N = pts.length;
  const sx = pts.reduce((s,p)=>s+p.x,0); const sy = pts.reduce((s,p)=>s+p.y,0);
  const sxx = pts.reduce((s,p)=>s+p.x*p.x,0);   const sxy = pts.reduce((s,p)=>s+p.x*p.y,0);
  const denom = N*sxx - sx*sx;
  const a = (N*sxy - sx*sy)/denom;
  const b = (sy - a*sx)/N;
  const ym = sy/N; let ssr=0, sst=0;
  for (const p of pts){ const yh = a*p.x+b; ssr += (p.y-yh)**2; sst += (p.y-ym)**2; }
  const R2 = 1 - ssr/sst;
  const sigma = Math.sqrt(ssr/Math.max(1, N-2));
  return { a, b, R2, sigma, x40: (40-b)/a, sat: (100-b)/a };
}

const pointsAll: Array<{id:string;x:number;y:number;genre:string}> = [
  ...input.old3.map((p:any)=>({ ...p, genre: '论说' })),
  ...input.new_v2.map((p:any)=>({
    ...p,
    genre: p.id.startsWith('N') ? '叙事'
         : p.id.startsWith('D') ? '对话'
         : p.id.startsWith('H') ? '人写' : '?'
  })),
];
const meta: Record<string,[string,string]> = {
  O1:['论说','数字密集原文(v0.7旧)'],
  O2:['论说','本地引擎0.7(v0.7旧)'],
  O3:['论说','深度闭环(v0.7旧)'],
  N1:['叙事','叙事文·原文'],
  N2:['叙事','叙事文·基础档0.6'],
  N3:['叙事','叙事文·朱雀档0.9'],
  D1:['对话','对话体·原文(饱和81)'],
  D2:['对话','对话体·基础档0.6'],
  D3:['对话','对话体·朱雀档0.9'],
  H0:['人写','纯人写·无处理(误杀基线★)'],
  H1:['人写','纯人写·基础档0.6(对照)'],
  H2:['人写','纯人写·朱雀档0.9(对照)'],
};
const lines: string[] = [];
lines.push('朱雀分标定 · v2 体裁分层档案  2026-08-25');
lines.push('回传值: H0=15, N1=99, N2=22, N3=18, D1=98, D2=28, D3=25, H1=19, H2=17');
lines.push('=======================================================================================');
lines.push('');
lines.push('【一】数据总表（12 点）');
lines.push('id   体裁  档位                     x=aiScore  y=官%  备注');
for (const p of pointsAll) {
  const m = meta[p.id] || ['?','?'];
  lines.push(String(p.id).padEnd(4)+' '+m[0].padEnd(5)+' '+m[1].padEnd(24)+' '+String(p.x).padStart(5)+'    '+String(p.y).padStart(4));
}
lines.push('');
lines.push('【二】四条体裁分层独立 OLS 拟合结果（本项目推荐方案 ✅）');
const genres = [
  ['论说','O1,O2,O3'],
  ['叙事','N1,N2,N3'],
  ['对话','D1,D2,D3'],
  ['人写','H0,H1,H2'],
] as const;
for (const [name, ids] of genres) {
  const idsArr = ids.split(',');
  const pts = pointsAll.filter(p => idsArr.includes(p.id));
  const { a, b, R2, sigma, x40, sat } = olsLine(pts);
  lines.push('');
  lines.push(name + '线  n=' + pts.length + ':');
  lines.push('  公式 y = clamp( ' + a.toFixed(3) + ' * x + ' + b.toFixed(3) + ' , 0, 100 )');
  lines.push('  R²=' + R2.toFixed(4) + '   S.E.=' + sigma.toFixed(2) + '个百分点');
  lines.push('  过人线 (y≤40%) 反推: x ≤ ' + (x40 >= 0 ? x40.toFixed(1) + ' (aiScore)' : '天然已过（截距本身<40，纯人写H0=15%本来就稳过）'));
  lines.push('  饱和下界   (y≥98%) 反推: x ≥ ' + (sat >= 0 && sat < 1e9 ? sat.toFixed(1) + ' (aiScore → y饱和100%)' : '斜率为负，越高越安全，无饱和概念'));
  lines.push('  残差:');
  for (const p of pts) {
    const yh = Math.max(0, Math.min(100, a*p.x + b));
    const e = p.y - yh;
    lines.push('    ' + String(p.id).padEnd(3) + '  x=' + String(p.x).padEnd(5) + '  y官=' + String(p.y).padEnd(4) + '  y预=' + yh.toFixed(1) + '  e=' + (e>0?'+':'') + e.toFixed(1) + '  |e/y官|=' + (Math.abs(e)/p.y*100).toFixed(1) + '%');
  }
}
lines.push('');
lines.push('【三】四体裁诊断：为何必须分层？（关键证据）');
lines.push('  (1) 斜率差: 论说2.008 / 叙事1.681 / 对话0.959 / 人写-0.300');
lines.push('      → 最大差 2.308 (比例差异 109%，远超合并阈值40%)');
lines.push('  (2) 同 x=10 对照: O2(论说10,45%) vs H0(人写10,15%)');
lines.push('      → y差 30 个百分点，同 aiScore 因体裁不同官分差整整 1 倍！');
lines.push('  (3) 反直觉验证: H0(不去味 15%) → H1(去味0.6 19%) → H2(去味0.9 17%)');
lines.push('      → 3 点 OLS 斜率 = -0.3，纯人写越去味越像 AI！');
lines.push('  (4) 对话斜率 0.96 = 论说 2.008 的 48%');
lines.push('      → 对话过人门槛 aiScore≤20.6，比论说≤10.4 放宽近 1 倍');
lines.push('  (5) 四条线截距: 19.20 / 20.00 / 20.28 / 18.00');
lines.push('      → 差 ≤2.3 pp，说明 19~20 这个"误杀地板区"稳定跨体裁');
lines.push('  (6) H0真值 15% vs 旧主线原预测 2.008*10+19.2 = 39.3%');
lines.push('      → 旧主线对纯人写高估 24.3 个百分点 → 截距 19.2 对纯人写体裁偏高');
lines.push('');
lines.push('【四】合并方案对照（v2 不推荐合并，仅作参考）');
const A = { n:12, a:1.197, b:21.61, R2:0.831, sigma:14.09, x40:15.4, sat:65.5, label:'A 全12点 9新+旧3', residMaxPct:28.1 };
const B = { n:11, a:1.132, b:20.43, R2:0.862, sigma:12.17, x40:17.3, sat:70.3, label:'B 稳健11点 剔除O1', residMaxPct:25.6 };
const C = { n:10, a:0.969, b:19.88, R2:0.914, sigma:7.76,  x40:20.8, sat:82.7, label:'C 稳健10点 剔除O1+N1', residMaxPct:34.3 };
const Aplus = { n:14, a:1.235, b:23.46, R2:0.807, sigma:14.54, x40:13.4, sat:62.0, label:'A+ 14点 12+NB/NC拼接', residMaxPct:26.1 };
for (const f of [A,B,C,Aplus]) {
  lines.push('  * ' + (''+f.label).padEnd(24) + '  n=' + f.n + '  y=' + f.a.toFixed(3)+'x+' + f.b.toFixed(2) + '  R²=' + f.R2.toFixed(3) + '  σ=' + f.sigma.toFixed(2) + '  x40≤' + (f.x40>=0?f.x40.toFixed(1):'无解') + '  饱和x≥' + f.sat.toFixed(1) + '  最大相对残差=' + f.residMaxPct.toFixed(1) + '%');
}
lines.push('');
lines.push('【五】决策与产物');
lines.push('  · 推荐: 四体裁分层制（BenchmarkPanel 下拉切换）');
lines.push('  · 已更新: docs/fingerprint-and-zhuque-calibration.md §3');
lines.push('  · 已更新: src/components/BenchmarkPanel.tsx （v2体裁下拉 + 纯人写警示横幅）');
lines.push('  · 复现脚本: scripts/zhuque-v2-fit-12pt.ts → scripts/zhuque-v2-fit-result.json');
const out = path.join(process.cwd(), 'scripts', 'zhuque-calibration-v2.txt');
fs.writeFileSync(out, lines.join('\n'), 'utf-8');
console.log('OK 写好了:', out, ' 共', lines.length, '行');
