// scripts/zhuque-refit.ts
// 用法：npx tsx scripts/zhuque-refit.ts --yA 99 --yB 73 --yC 58
//   其中 yA = 原文拼接档官方朱雀分
//         yB = 基础档(0.6关朱雀)拼接官方分
//         yC = 朱雀档(0.9开朱雀)拼接官方分
// 做 6 点线性拟合 y = a*x + b
//   - 3 个新点 (xA=87.25, yA), (xB=28.23, yB), (xC=21.93, yC)
//   - 3 个旧点 (33,85), (10,45), (8,30) （来自 docs/标定原文）
// 输出 R² / 残差 / 新公式 / AI过人阈值（= 求解 40 = a*x + b → x=(40-b)/a）
// 同时把结果写入：
//   - scripts/zhuque-calibration.txt（回填 A/B/C 三组官方分与新拟合公式区）
//   - scripts/zhuque-refit-result.json（机器可读）
import fs from 'fs';
import path from 'path';

// ------------- 参数解析 -------------
function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const yA = Number(args['yA']);
const yB = Number(args['yB']);
const yC = Number(args['yC']);
if (!yA || !yB || !yC || yA <= 0 || yB <= 0 || yC <= 0 || yA > 100 || yB > 100 || yC > 100) {
  console.error('用法: npx tsx scripts/zhuque-refit.ts --yA 99 --yB 73 --yC 58');
  console.error('  三个值必须是 (0, 100] 范围内的官方朱雀 AI 概率%');
  process.exit(1);
}

// ------------- 数据点 -------------
type Pt = { id: string; x: number; y: number; src: string };
const points: Pt[] = [
  { id: 'NEW-A-原文拼接', x: 87.25, y: yA, src: '本轮送检' },
  { id: 'NEW-B-基础档拼接', x: 28.23, y: yB, src: '本轮送检' },
  { id: 'NEW-C-朱雀档拼接', x: 21.93, y: yC, src: '本轮送检' },
  { id: 'OLD-1-原文数字论说文', x: 33, y: 85, src: '标定档案(2026-08)' },
  { id: 'OLD-2-本地引擎0.7', x: 10, y: 45, src: '标定档案(2026-08)' },
  { id: 'OLD-3-LLM深度闭环', x: 8, y: 30, src: '标定档案(2026-08)' },
];

// ------------- OLS 拟合 y = a*x + b -------------
const N = points.length;
const sx = points.reduce((s, p) => s + p.x, 0);
const sy = points.reduce((s, p) => s + p.y, 0);
const sxx = points.reduce((s, p) => s + p.x * p.x, 0);
const syy = points.reduce((s, p) => s + p.y * p.y, 0);
const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
const denom = N * sxx - sx * sx;
const a = (N * sxy - sx * sy) / denom;
const b = (sy - a * sx) / N;
const yMean = sy / N;
let ssRes = 0, ssTot = 0;
const residuals: { id: string; x: number; y: number; yHat: number; err: number; abspct: number }[] = points.map(p => {
  const yHat = a * p.x + b;
  const err = p.y - yHat;
  ssRes += err * err;
  ssTot += (p.y - yMean) ** 2;
  return { id: p.id, x: p.x, y: p.y, yHat: Math.round(yHat * 100) / 100, err: Math.round(err * 100) / 100, abspct: Math.round(Math.abs(err / p.y) * 10000) / 100 };
});
const R2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
const r = sxy === 0 ? 0 : (N * sxy - sx * sy) / Math.sqrt(denom * (N * syy - sy * sy));
const sigma = Math.sqrt(ssRes / (N - 2));
// 求解 a*x0 + b = 40（朱雀官方 40% 作为"过人阈值"）
const x40 = (40 - b) / a;
// 求解 aiScore → 预测朱雀%常用档位
const predMap = [0, 5, 8, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 87].map(x => ({ x, yHat: Math.min(100, Math.max(0, a * x + b)) }));

// ------------- 输出 -------------
const reportLines: string[] = [];
const print = (s = '') => { console.log(s); reportLines.push(s); };
print('=== QuAiWei 朱雀对标 · 6 点最小二乘线性拟合  2026-08-25 ===');
print(`新 3 点 (本轮送检): A x=87.25→y=${yA}%, B x=28.23→y=${yB}%, C x=21.93→y=${yC}%`);
print(`旧 3 点 (标定档案): (33, 85), (10, 45), (8, 30)`);
print('');
print(`✅ 新拟合公式: y(朱雀%) = ${a.toFixed(3)} × aiScore + ${b.toFixed(3)}`);
print(`   - Pearson r  = ${r.toFixed(4)}`);
print(`   - R²        = ${R2.toFixed(4)}`);
print(`   - 残差 S.E. = ${sigma.toFixed(3)} 个百分点`);
print(`   - 反函数: aiScore 过人阈值 x40 (预测朱雀=40%) = ${x40.toFixed(2)}`);
print('');
print('--- 单点残差表（y=官方实测，ŷ=拟合预测）---');
print('id'.padEnd(28) + '  x   y(官)  ŷ(预)  残差  相对%');
for (const r2 of residuals) {
  print(r2.id.padEnd(28) + ` ${r2.x.toFixed(2).padStart(5)} ${r2.y.toFixed(1).padStart(6)} ${r2.yHat.toFixed(1).padStart(6)} ${r2.err > 0 ? '+' : ''}${r2.err.toFixed(1).padStart(5)}  ${r2.abspct.toFixed(1)}%`);
}
const maxAbsPct = Math.max(...residuals.map(r => r.abspct));
print(`\n最大相对残差: ${maxAbsPct.toFixed(1)}%`);
print('');
print('--- aiScore → 预测朱雀% 档位表（新公式） ---');
console.log('aiScore | 预测朱雀% | 建议');
for (const p of predMap) {
  const y = Math.round(p.yHat * 10) / 10;
  let tip: string;
  if (y <= 20) tip = '✅ 过人区间（极大概率过）';
  else if (y <= 40) tip = '🟢 低风险（建议再跑一轮 0.9 朱雀档保险）';
  else if (y <= 60) tip = '🟡 中风险（需要加强：强度 ≥0.9 并开朱雀增强）';
  else if (y <= 80) tip = '🟠 高风险（去味轮次明显不足）';
  else tip = '🔴 严重 AI 味（几乎必中检测）';
  print(`${String(p.x).padStart(6)} | ${String(y).padStart(9)} | ${tip}`);
}
print('');
print(`--- 旧公式 vs 新公式 在 4 个基准 aiScore 上的差异 ---`);
const a0 = 2.0, b0 = 19.2;
for (const x of [8, 10, 33, 87]) {
  const yOld = a0 * x + b0;
  const yNew = a * x + b;
  print(`aiScore=${String(x).padStart(2)} | 旧公式 朱雀=${yOld.toFixed(1)}%  |  新公式 朱雀=${yNew.toFixed(1)}%  |  Δ=${(yNew - yOld > 0 ? '+' : '')}${(yNew - yOld).toFixed(1)}%`);
}

// ------------- 写 JSON 结果 -------------
const outPath = path.join(process.cwd(), 'scripts', 'zhuque-refit-result.json');
fs.writeFileSync(outPath, JSON.stringify({
  ts: new Date().toISOString(),
  points,
  params: { a, b, R2, r, sigma, x40 },
  residuals,
  predMap,
  maxAbsPct,
  oldFormula: { a: 2.0, b: 19.2, note: 'v0.7 n=3 标定' }
}, null, 2), 'utf-8');
print('\n✅ 结果已写入: ' + outPath);
print('（把这段报告贴给我，我会继续回填 zhique-calibration.txt、docs/标定文档、App.tsx 阈值表）');
