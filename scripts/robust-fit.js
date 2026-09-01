// 稳健拟合脚本（一次性内联）
// 策略 1：6 点全保留（已做，R²=0.706，sigma=15.4）
// 策略 2：剔除残差最大的 1 个 OLD-3 后 5 点拟合
// 策略 3：仅新 3 点拟合（n=3，看新旧斜率差异）
function ols(P, label){
  const N=P.length;
  const sx=P.reduce((s,p)=>s+p.x,0); const sy=P.reduce((s,p)=>s+p.y,0);
  const sxx=P.reduce((s,p)=>s+p.x*p.x,0);
  const sxy=P.reduce((s,p)=>s+p.x*p.y,0);
  const denom=N*sxx-sx*sx;
  const a=(N*sxy-sx*sy)/denom; const b=(sy-a*sx)/N;
  const ym=sy/N;
  let ssr=0,sst=0;
  const rs=P.map(p=>{const yh=a*p.x+b;const e=p.y-yh;ssr+=e*e;sst+=(p.y-ym)**2;return{id:p.id,x:p.x,y:p.y,yH:yh,e};});
  const R2=1-ssr/sst; const sig=Math.sqrt(ssr/(N-2));
  const x40=(40-b)/a;
  console.log(`\n== ${label}  n=${N} ==`);
  console.log(`y(朱雀%) = ${a.toFixed(3)} * aiScore + ${b.toFixed(3)}`);
  console.log(`R2=${R2.toFixed(4)}   S.E.=${sig.toFixed(3)}   x40(过人阈值)= ${x40.toFixed(2)}`);
  console.log('id'.padEnd(28)+'  x   y(官)  yH(预)  e');
  for(const r of rs) console.log(r.id.padEnd(28)+` ${r.x.toFixed(2).padStart(5)} ${r.y.toFixed(1).padStart(6)} ${r.yH.toFixed(1).padStart(6)} ${r.e>0?'+':''}${r.e.toFixed(1)}`);
  return {a,b,R2,sig,x40,rs};
}
const pts=[
 {id:'NEW-A',x:87.25,y:98},{id:'NEW-B',x:28.23,y:76},{id:'NEW-C',x:21.93,y:63},
 {id:'OLD-1',x:33,y:85},{id:'OLD-2',x:10,y:45},{id:'OLD-3',x:8,y:30}
];
ols(pts,'策略1 全6点');
ols(pts.filter(p=>p.id!=='OLD-3'),'策略2 丢OLD-3');
ols(pts.filter(p=>p.id.startsWith('NEW')),'策略3 仅新3点');
