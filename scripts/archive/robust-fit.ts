// scripts/robust-fit.ts
// 策略 1：6 点全保留
// 策略 2：剔除残差最大的 1 个点后 5 点拟合
// 策略 3：仅新 3 点拟合
type Pt = { id: string; x: number; y: number };
const pts: Pt[] = [
  { id: 'NEW-A', x: 87.25, y: 98 },
  { id: 'NEW-B', x: 28.23, y: 76 },
  { id: 'NEW-C', x: 21.93, y: 63 },
  { id: 'OLD-1', x: 33, y: 85 },
  { id: 'OLD-2', x: 10, y: 45 },
  { id: 'OLD-3', x: 8, y: 30 },
];

function ols(P: Pt[], label: string) {
  const N = P.length;
  const sx = P.reduce((s, p) => s + p.x, 0); const sy = P.reduce((s, p) => s + p.y, 0);
  const sxx = P.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = P.reduce((s, p) => s + p.x * p.y, 0);
  const denom = N * sxx - sx * sx;
  const a = (N * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / N;
  const ym = sy / N;
  let ssr = 0, sst = 0;
  const rs = P.map(p => {
    const yH = a * p.x + b; const e = p.y - yH;
    ssr += e * e; sst += (p.y - ym) ** 2;
    return { id: p.id, x: p.x, y: p.y, yH, e };
  });
  const R2 = 1 - ssr / sst;
  const sig = Math.sqrt(ssr / Math.max(1, N - 2));
  const x40 = (40 - b) / a;
  console.log(`\n== ${label}  n=${N} ==`);
  console.log(`y(朱雀%) = ${a.toFixed(3)} * aiScore + ${b.toFixed(3)}`);
  console.log(`R²=${R2.toFixed(4)}   S.E.=${sig.toFixed(3)}   x40(过人阈值)=${x40.toFixed(2)}`);
  console.log('id'.padEnd(10) + '  x      y     yH      e');
  for (const r of rs) {
    console.log(r.id.padEnd(10) + ` ${r.x.toFixed(2).padStart(6)} ${r.y.toFixed(1).padStart(5)} ${r.yH.toFixed(1).padStart(6)} ${r.e > 0 ? '+' : ''}${r.e.toFixed(1)}`);
  }
  return { label, a, b, R2, sig, x40, rs };
}

console.log('官方回传: A=98, B=76, C=63');
const r1 = ols(pts, '策略1 全6点');
// 找全6点里残差最大的
const worst = [...r1.rs].sort((a, b) => Math.abs(b.e) - Math.abs(a.e))[0];
console.log(`\n全6点中残差最大: ${worst.id}  |e|=${Math.abs(worst.e).toFixed(1)}`);
const r2 = ols(pts.filter(p => p.id !== worst.id), `策略2 剔除${worst.id} 剩5点`);
const r3 = ols(pts.filter(p => p.id.startsWith('NEW')), '策略3 仅新3点');

console.log('\n--- 三策略横向对比 ---');
console.log('策略'.padEnd(24) + '  a      b       R²     sig   x40');
for (const r of [r1, r2, r3]) {
  console.log(r.label.padEnd(24) + ` ${r.a.toFixed(3).padStart(5)} ${r.b.toFixed(2).padStart(7)} ${r.R2.toFixed(4).padStart(7)} ${r.sig.toFixed(2).padStart(5)} ${r.x40.toFixed(2).padStart(6)}`);
}

console.log('\n--- 过人阈值(朱雀≤40%) 等价所需 aiScore (负号意味着"按本斜率预测即使 aiScore=0 也过不了") ---');
for (const r of [r1, r2, r3]) {
  const passable = r.x40 >= 0 && r.x40 <= 100;
  console.log(`  ${r.label.padEnd(24)} x40=${r.x40.toFixed(2)}  ${passable ? '✅ 可实现：aiScore ≤ ' + r.x40.toFixed(0) : '⚠️ 斜率太低/截距太高，x40不在 [0,100] 内；截距上限=' + (r.a * 0 + r.b).toFixed(1) + '%'}`);
}

// 写 JSON 供后续选用
import fs from 'fs';
import path from 'path';
fs.writeFileSync(path.join(process.cwd(), 'scripts', 'robust-fit-result.json'), JSON.stringify({ r1, r2, r3, worstRemoved: worst.id }, null, 2));
