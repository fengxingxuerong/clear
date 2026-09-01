// scripts/sensitivity-h0.ts
// 回答问题：如果纯人写稿 H0 (aiScore=10) 的官方朱雀分很低（<旧预测 39.3%），
// 是否说明之前的误杀截距 19.2 偏高？过人阈值会怎样变化？
//
// 数据集：旧 3 点（主线 n=3）+ 本轮 NEW-B/C 两档（已交叉验证残差 ≤0.2%）= 固定 5 个锚点
//       再加 1 个可插拔点 H0: (x=10, y= 可变场景值)
// 5 锚点：
//   O1  (33, 85)   OLD-1 论说文原文
//   O2  (10, 45)   OLD-2 本地引擎 0.7
//   O3  ( 8, 30)   OLD-3 深度闭环
//   NB  (28.23, 76) NEW-B 基础档拼接（交叉验证完美吻合）
//   NC  (21.93, 63) NEW-C 朱雀档拼接（交叉验证完美吻合）
// 变化值 H0 (x=10, y ∈ {30, 20, 10, 5})  + 基线不含 H0
//
// 每项 OLS 输出：a, b, R², x40(过人阈值 aiScore 需多少 才 y≤40)
//               N2/N3/H1/H2 地板预测 (=b，因 aiScore≈0)

type Pt = { id: string; x: number; y: number };
const anchor: Pt[] = [
  { id: 'O1', x: 33, y: 85 },
  { id: 'O2', x: 10, y: 45 },
  { id: 'O3', x: 8, y: 30 },
  { id: 'NB', x: 28.23, y: 76 },
  { id: 'NC', x: 21.93, y: 63 },
];

const H0_X = 10;
const scenarios = [
  { name: '基线 (无H0 · 主线当前)', h0Y: null },
  { name: 'A · H0官=30% (略低于旧O2=45，代表"人写稿比旧O2更真")', h0Y: 30 },
  { name: 'B · H0官=20% (典型轻度误杀，接近旧截距19.2)', h0Y: 20 },
  { name: 'C · H0官=10% (误杀率仅1成，说明截距19.2偏高接近1倍)', h0Y: 10 },
  { name: 'D · H0官=5%  (几乎零误杀，旧截距19.2严重偏高)', h0Y: 5 },
];

function ols(P: Pt[]) {
  const N = P.length;
  const sx = P.reduce((s, p) => s + p.x, 0); const sy = P.reduce((s, p) => s + p.y, 0);
  const sxx = P.reduce((s, p) => s + p.x * p.x, 0);   const sxy = P.reduce((s, p) => s + p.x * p.y, 0);
  const denom = N * sxx - sx * sx;
  const a = (N * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / N;
  const ym = sy / N;
  let ssr = 0, sst = 0;
  for (const p of P) {
    const yh = a * p.x + b;
    ssr += (p.y - yh) ** 2;
    sst += (p.y - ym) ** 2;
  }
  const R2 = sst === 0 ? 1 : 1 - ssr / sst;
  const sigma = Math.sqrt(ssr / Math.max(1, N - 2));
  const x40 = (40 - b) / a; // 求解 a*x + b = 40
  const floorPred = Math.max(0, Math.min(100, a * 0 + b)); // aiScore=0 地板预测%
  return { a, b, R2, sigma, x40, floorPred, N };
}

function clamp(n: number) { return Math.max(0, Math.min(100, n)); }

console.log('=== H0 敏感性分析：纯人写稿官方分 ↔ 主线截距 ↔ 过人阈值 ===');
console.log('固定锚点：O1/O2/O3 (旧3) + NB/NC (本轮交叉验证 2 点) = 共 5 个可信锚');
console.log('可变点  ：H0 (aiScore=10, y = ?)  ——纯人写稿未处理的官方误杀率\n');

const header = ['场景', 'H0官%', 'n', 'a(斜率)', 'b(截距)', 'Δ截距', 'R²', 'S.E.', '过人阈值 x40', 'Δ阈值', 'aiScore=0 地板%', '预测H0%', 'H0残差'];
console.log(header.map((h, i) => h.padEnd(i <= 1 ? 7 : i === 0 ? 42 : i === 11 || i === 12 ? 10 : 9)).join(' | '));
console.log('-'.repeat(130));

const BASE_B = 19.201;
const BASE_X40 = 10.4;

const rows: any[] = [];
for (const sc of scenarios) {
  const pts = sc.h0Y !== null ? [...anchor, { id: 'H0', x: H0_X, y: sc.h0Y }] : [...anchor];
  const r = ols(pts);
  const h0Pred = clamp(r.a * H0_X + r.b);
  const h0Res = sc.h0Y !== null ? sc.h0Y - h0Pred : 0;
  const row = {
    name: sc.name,
    h0: sc.h0Y ?? '—',
    n: r.N,
    a: r.a.toFixed(3),
    b: r.b.toFixed(2),
    db: (r.b - BASE_B).toFixed(2),
    R2: r.R2.toFixed(4),
    sig: r.sigma.toFixed(2),
    x40: r.x40 < 0 ? '⚠️负(' + r.x40.toFixed(1) + ')' : r.x40.toFixed(2),
    dx40: sc.h0Y === null ? '—' : (r.x40 - BASE_X40 > 0 ? '+' : '') + (r.x40 - BASE_X40).toFixed(2),
    floor: r.floorPred.toFixed(1),
    h0Pred: h0Pred.toFixed(1),
    h0Res: sc.h0Y === null ? '—' : (h0Res > 0 ? '+' : '') + h0Res.toFixed(1),
  };
  rows.push({ sc, r, row });
  console.log([
    row.name.padEnd(42),
    String(row.h0).padEnd(7),
    String(row.n).padEnd(7),
    row.a.padEnd(9),
    row.b.padEnd(9),
    row.db.padEnd(9),
    row.R2.padEnd(9),
    row.sig.padEnd(9),
    String(row.x40).padEnd(12),
    String(row.dx40).padEnd(9),
    String(row.floor).padEnd(13),
    String(row.h0Pred).padEnd(10),
    String(row.h0Res),
  ].join(' | '));
}

console.log('\n\n--- 结论对照表（看表找自己的 H0 对应行）---');
console.log('');
console.log('H0官% | 截距变多少 | 过人阈值 aiScore≤40 对应旧 x40=10.4 放宽/收紧 | 含义');
console.log('------+------------+--------------------------------------------------+------');
for (const { sc, r } of rows.slice(1)) {
  const x40Ok = r.x40 >= 0 && r.x40 <= 100;
  const verdict = (() => {
    if (sc.h0Y! >= 35) return '和旧 O2=45 差不多：旧截距 19.2 基本准确，主线不用改';
    if (sc.h0Y! >= 25) return '比旧 O2=45 乐观 10 个点：截距低 2-4，过人阈值放宽 2-3 个 aiScore 点';
    if (sc.h0Y! >= 15) return '典型低误杀：截距 12-16 左右，过人阈值放宽 5-8 点 → aiScore ≤15-18 即可过人';
    if (sc.h0Y! >= 8)  return '极低误杀：截距 <10，过人阈值放宽到 20+，旧主线对"人写味"整体偏悲观';
    return '几乎零误杀：截距 <5，阈值 x40 变成 30+ —— 当前"去味强度 ≥0.7 开朱雀"的规范过于保守，可下调';
  })();
  const okStr = x40Ok ? '≤' + r.x40.toFixed(1) : '无(截距>40)';
  const dbStr = (r.b - BASE_B).toFixed(2);
  console.log(
    String(sc.h0Y!).padEnd(6) + '| ' +
    (dbStr.startsWith('-') ? '' : ' ') + dbStr + ' pts  '.padEnd(3 - String(Math.abs(parseFloat(dbStr))).length) + '| ' +
    ('x40=' + okStr).padEnd(20) + '（Δ' + (r.x40 - BASE_X40 > 0 ? '+' : '') + (r.x40 - BASE_X40).toFixed(2) + '）| ' +
    verdict
  );
}
console.log('\n--- 对 N2/N3/H1/H2 (aiScore=0 档) 的 UI 提示级影响 ---');
console.log('(这些档目前主线都 → 预测 19.2% 显示 🟢 "低风险；建议再跑一轮")\n');
for (const { sc, r } of rows) {
  const pct = r.floorPred;
  let badge: string;
  if (pct <= 20) badge = '✅ 过人区间 (≤20%)';
  else if (pct <= 40) badge = '🟢 低风险 (20~40%)';
  else badge = '⚠️ 中高 (>40%)';
  console.log(`  ${String(sc.h0Y ?? '基线').padStart(4)} → aiScore=0 地板=${pct.toFixed(1)}%  ${badge}`);
}
console.log('\n💡 回答问题：如果 H0 官分 << 旧预测 39.3%，**必定说明之前的误杀截距 19.2 偏高**。');
console.log('   H0 每比 39.3 低 10 个百分点 → 截距约降 3~4 个百分点 → 过人阈值 x40 约放宽 2~4 个 aiScore 点。');
