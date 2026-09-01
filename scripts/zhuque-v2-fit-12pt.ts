// scripts/zhuque-v2-fit-12pt.ts
// 2026-08-25 v2 体裁扩充标定：9 个官方新点 + 旧 3 主线锚点 + (可选)NB/NC 拼接点
// 做：
//   A. 全 12 点（9新+旧3）OLS + 残差排序 → 找异常
//   B. 剔除残差最大的 1~2 个点 → 稳健 11/10 点 OLS
//   C. 3 个体裁各自 OLS（叙事 N1~N3 / 对话 D1~D3 / 人写 H0~H2）→ 判差异大不大
//   D. 主线新推荐公式 + 过人阈值 + 饱和点
import fs from 'fs';
import path from 'path';

type Pt = { id: string; genre: string; x: number; y: number; src: string };

// 9 新点（v2 官方回传）
const NEW_V2: Pt[] = [
  { id: 'N1', genre: '叙事', x: 47, y: 99, src: 'v2送检' },
  { id: 'N2', genre: '叙事', x: 0,  y: 22, src: 'v2送检' },
  { id: 'N3', genre: '叙事', x: 0,  y: 18, src: 'v2送检' },
  { id: 'D1', genre: '对话', x: 81, y: 98, src: 'v2送检' },
  { id: 'D2', genre: '对话', x: 6,  y: 28, src: 'v2送检' },
  { id: 'D3', genre: '对话', x: 7,  y: 25, src: 'v2送检' },
  { id: 'H0', genre: '人写', x: 10, y: 15, src: 'v2送检·人写基线' },
  { id: 'H1', genre: '人写', x: 0,  y: 19, src: 'v2送检·人写去味对照' },
  { id: 'H2', genre: '人写', x: 0,  y: 17, src: 'v2送检·人写去味对照' },
];

// 旧 3 锚点（v0.7 单篇数字密集论说文）
const OLD_3: Pt[] = [
  { id: 'O1', genre: '论说', x: 33, y: 85, src: 'v0.7原档' },
  { id: 'O2', genre: '论说', x: 10, y: 45, src: 'v0.7原档' },
  { id: 'O3', genre: '论说', x: 8,  y: 30, src: 'v0.7原档' },
];

// NB/NC：本轮 v1 A/B/C 拼接送检中，与旧主线完美吻合（残差 0.1/0.2）的 2 个交叉验证点
//   - 但含桥接段偏倚，先默认不进主线拟合，最后"拟合 A++"再试并入看 R² 涨幅
const NBCROSS: Pt[] = [
  { id: 'NB', genre: '论说·拼', x: 28.23, y: 76, src: 'v1拼接交叉(残差+0.1)' },
  { id: 'NC', genre: '论说·拼', x: 21.93, y: 63, src: 'v1拼接交叉(残差-0.2)' },
];
const NAFULL: Pt[] = [...NEW_V2, ...OLD_3]; // 12 点

function ols(P: Pt[], label: string) {
  const N = P.length;
  const sx = P.reduce((s,p)=>s+p.x,0); const sy = P.reduce((s,p)=>s+p.y,0);
  const sxx = P.reduce((s,p)=>s+p.x*p.x,0);   const sxy = P.reduce((s,p)=>s+p.x*p.y,0);
  const denom = N*sxx - sx*sx;
  const a = (N*sxy - sx*sy)/denom;
  const b = (sy - a*sx)/N;
  const ym = sy/N;
  let ssr=0, sst=0;
  const rows = P.map(p=>{
    const yh = a*p.x+b; const e = p.y-yh;
    ssr += e*e; sst += (p.y-ym)**2;
    return { id:p.id, genre:p.genre, x:p.x, y:p.y, yH:yh, e, apct: Math.abs(e)/Math.max(1,p.y)*100 };
  }).sort((x,y)=>Math.abs(y.e)-Math.abs(x.e));
  const R2 = 1 - ssr/sst;
  const sigma = Math.sqrt(ssr/Math.max(1,N-2));
  const x40 = (40-b)/a;
  const x50 = (50-b)/a;
  const x30 = (30-b)/a;
  const sat = (100-b)/a; // 预测饱和到 100% 的 x 下限
  return { label, N, a, b, R2, sigma, x30, x40, x50, sat, rows };
}

function printFit(f: ReturnType<typeof ols>) {
  console.log(`\n==== ${f.label}  n=${f.N} ====`);
  console.log(`公式:  y(朱雀%) = ${f.a.toFixed(3)} × aiScore + ${f.b.toFixed(3)}`);
  console.log(`R²=${f.R2.toFixed(4)}   S.E.=${f.sigma.toFixed(2)}个百分点`);
  console.log(`反推阈值(aiScore ≤ ? → 官方朱雀% ≤ 目标):`);
  console.log(`  ≤30% → x ≤ ${f.x30>=0?f.x30.toFixed(1)+'  ✅':'⚠️无(截距>'+(f.a*0+f.b).toFixed(1)+')'}`);
  console.log(`  ≤40% (过人线) → x ≤ ${f.x40>=0?f.x40.toFixed(1)+'  ✅':'⚠️ 无解（即使 aiScore=0 预测>'+(f.a*0+f.b).toFixed(1)+'% >40%）'}`);
  console.log(`  ≤50% → x ≤ ${f.x50>=0?f.x50.toFixed(1)+'  ✅':'⚠️ 无解'}`);
  console.log(`  x ≥ ${f.sat.toFixed(1)} → 预测饱和到 100%（物理上限官方实际≈98~99，可直接判 🔴）`);
  console.log(`\n残差表（按|e|从大到小）:`);
  console.log('id  体裁  x      y官  y预    e    相对%');
  for (const r of f.rows) {
    console.log(`${r.id.padEnd(3)} ${r.genre.padEnd(5)} ${r.x.toFixed(2).padStart(5)} ${r.y.toFixed(1).padStart(5)} ${r.yH.toFixed(1).padStart(5)} ${r.e>0?'+':''}${r.e.toFixed(1).padStart(5)}  ${r.apct.toFixed(1)}%`);
  }
  return f;
}

// A. 全 12 点
const fA = printFit(ols(NAFULL, 'A · 全12点 (9新+旧3 论说·叙事·对话·人写 四体裁混合)'));

// A*. 全 12 + NB/NC (14 点，NB/NC 是含桥接段的拼接点，先试看)
const fAplus = printFit(ols([...NAFULL, ...NBCROSS], 'A+· 14点 (12 + NB/NC拼接交叉)'));

// B. 剔除 A 中残差最大的 1 个点 → 稳健 11 点
const worst1 = fA.rows[0].id;
const fB = printFit(ols(NAFULL.filter(p=>p.id!==worst1), `B · 稳健11点 (剔除最大残差 ${worst1})`));

// C. 继续剔除次大残差 → 稳健 10 点
const worst2 = fB.rows[0].id;
const fC = printFit(ols(NAFULL.filter(p=>p.id!==worst1 && p.id!==worst2), `C · 稳健10点 (再剔除 ${worst2})`));

// D. 三体裁分层（叙事/对话/人写），另加 论说 旧 3 单独跑
function split(name: string, cond: (p:Pt)=>boolean) {
  const sub = NAFULL.filter(cond);
  if (sub.length < 2) return null;
  return ols(sub, `D·体裁分线·${name}  n=${sub.length}`);
}
const genres = ['论说','叙事','对话','人写'];
const fGenres: (ReturnType<typeof ols>|null)[] = genres.map(g => split(g, p=>p.genre===g));

console.log('\n\n============  横向对比：推荐哪一种作为新主线？  ============\n');
console.log('方案'.padEnd(48)+' n    a      b       R²      x40(过人)  x≥?饱和  最大残差%');
function summaryLine(f: ReturnType<typeof ols>) {
  return `${f.label.padEnd(48)} ${String(f.N).padEnd(4)} ${f.a.toFixed(3).padEnd(6)} ${f.b.toFixed(2).padEnd(7)} ${f.R2.toFixed(4).padEnd(7)} ${f.x40>=0?('≤'+f.x40.toFixed(1)).padEnd(9):'无解   '.padEnd(9)} ${f.sat.toFixed(1).padEnd(7)} ${f.rows[0].apct.toFixed(1)}%`;
}
console.log(summaryLine(fA));
console.log(summaryLine(fAplus));
console.log(summaryLine(fB));
console.log(summaryLine(fC));
for (const f of fGenres) if (f) console.log(summaryLine(f));

// 判断建议
console.log('\n\n============  决策建议  ============\n');
console.log('判断规则：');
console.log('  - 若 各体裁分层斜率相差 ≤30% 且 截距相差 ≤8  →  推荐合并单主线 + 剔除残差最大 1 点');
console.log('  - 若斜率或截距跨体裁显著差异(>40%)  →  推荐 UI 加体裁下拉，切换分层公式');
console.log('');
const slopes:Record<string,number> = {};
const inters:Record<string,number> = {};
for (const f of fGenres) if (f) { slopes[f.label]=f.a; inters[f.label]=f.b; }
const slopeArr = Object.values(slopes);
const interArr = Object.values(inters);
const slopeRange = (Math.max(...slopeArr)-Math.min(...slopeArr))/Math.min(...slopeArr)*100;
const interRange = Math.max(...interArr)-Math.min(...interArr);
console.log(`各体裁斜率差异 = ${slopeRange.toFixed(0)}%  (${slopeArr.map(x=>x.toFixed(3)).join(' / ')})`);
console.log(`各体裁截距差 = ${interRange.toFixed(1)}个百分点  (${interArr.map(x=>x.toFixed(2)).join(' / ')})`);
console.log('');

let verdict: string;
if (slopeRange <= 35 && interRange <= 10) {
  verdict = `✅ 推荐 合并单主线：斜率差异仅 ${slopeRange.toFixed(0)}%，截距差仅 ${interRange.toFixed(1)} 个百分点，四体裁可共用一条映射。`;
  if (fC.R2 > fB.R2 + 0.02 || fB.R2 - fA.R2 > 0.04) {
    verdict += fB.R2 - fA.R2 > 0.04 ? ` 选 B(11点)：剔除 ${worst1} 后 R² 提高 ${(fB.R2-fA.R2).toFixed(3)}。` : ` 选 C(10点)：剔除 ${worst1}+${worst2} 后 R² 提高 ${(fC.R2-fA.R2).toFixed(3)}。`;
  } else verdict += ` 选 A(全12点)：R²=${fA.R2.toFixed(3)} 已够用，不主动剔除点。`;
} else {
  verdict = `⚠️ 推荐 体裁分层：斜率差异 ${slopeRange.toFixed(0)}% / 截距差 ${interRange.toFixed(1)} 个百分点，跨体裁不共用一条线。UI 增加体裁下拉切换分层公式。`;
}
console.log(verdict);

// 输出 JSON 给后续文档更新脚本读
const result = {
  ts: new Date().toISOString(),
  input: { new_v2: NEW_V2.map(p=>({id:p.id,x:p.x,y:p.y})), old3: OLD_3.map(p=>({id:p.id,x:p.x,y:p.y})) },
  fits: {
    A: { label:fA.label,n:fA.N,a:fA.a,b:fA.b,R2:fA.R2,sigma:fA.sigma,x30:fA.x30,x40:fA.x40,x50:fA.x50,sat:fA.sat, residuals:fA.rows.map(r=>({id:r.id,x:r.x,y:r.y,yH:r.yH,e:r.e})) },
    Aplus:{ label:fAplus.label,n:fAplus.N,a:fAplus.a,b:fAplus.b,R2:fAplus.R2,sigma:fAplus.sigma,x30:fAplus.x30,x40:fAplus.x40,x50:fAplus.x50,sat:fAplus.sat,residuals:fAplus.rows.map(r=>({id:r.id,x:r.x,y:r.y,yH:r.yH,e:r.e})) },
    B:{ label:fB.label,n:fB.N,a:fB.a,b:fB.b,R2:fB.R2,sigma:fB.sigma,x30:fB.x30,x40:fB.x40,x50:fB.x50,sat:fB.sat,residuals:fB.rows.map(r=>({id:r.id,x:r.x,y:r.y,yH:r.yH,e:r.e})) },
    C:{ label:fC.label,n:fC.N,a:fC.a,b:fC.b,R2:fC.R2,sigma:fC.sigma,x30:fC.x30,x40:fC.x40,x50:fC.x50,sat:fC.sat,residuals:fC.rows.map(r=>({id:r.id,x:r.x,y:r.y,yH:r.yH,e:r.e})) },
    genres: fGenres.filter((f):f is ReturnType<typeof ols>=>!!f).map(f=>({label:f.label,n:f.N,a:f.a,b:f.b,R2:f.R2,x40:f.x40,sat:f.sat})),
  },
  diagnostic: { slopeRangePct: slopeRange, interDiffPct: interRange },
  verdict,
};
const outPath = path.join(process.cwd(),'scripts','zhuque-v2-fit-result.json');
fs.writeFileSync(outPath, JSON.stringify(result,null,2),'utf-8');
console.log('\n✅ 结果 JSON 已写入:', outPath);
