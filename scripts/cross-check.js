// 交叉预测：旧公式(仅旧3点) vs 新公式(仅新3点)
// 旧3点单独拟合
const OP=[{id:'O1',x:33,y:85},{id:'O2',x:10,y:45},{id:'O3',x:8,y:30}];
const NP=[{id:'N1',x:87.25,y:98},{id:'N2',x:28.23,y:76},{id:'N3',x:21.93,y:63}];
function ols(P){
  const N=P.length;
  const sx=P.reduce((s,p)=>s+p.x,0); const sy=P.reduce((s,p)=>s+p.y,0);
  const sxx=P.reduce((s,p)=>s+p.x*p.x,0);
  const sxy=P.reduce((s,p)=>s+p.x*p.y,0);
  const d=N*sxx-sx*sx;
  return {a:(N*sxy-sx*sy)/d,b:(sy-(N*sxy-sx*sy)/d*sx)/N};
}
const O=ols(OP); const N=ols(NP);
console.log('旧3点公式  y='+O.a.toFixed(3)+'*x+'+O.b.toFixed(3)+'   (原文挡 y≈2.0x+19.2, 与文档 v0.7 一致)');
console.log('新3点公式  y='+N.a.toFixed(3)+'*x+'+N.b.toFixed(3));
console.log('\n--- 旧公式预测 NEW 组 ---');
for(const p of NP){const pY=O.a*p.x+O.b;console.log(p.id+' x='+p.x+' y(官)='+p.y+'   yH(旧预)='+pY.toFixed(1)+'   e='+(p.y-pY>0?'+':'')+(p.y-pY).toFixed(1));}
console.log('\n--- 新公式预测 OLD 组 ---');
for(const p of OP){const pY=N.a*p.x+N.b;console.log(p.id+' x='+p.x+' y(官)='+p.y+'   yH(新预)='+pY.toFixed(1)+'   e='+(p.y-pY>0?'+':'')+(p.y-pY).toFixed(1));}
console.log('\n结论: 两组关系的截距差 约'+(N.b-O.b).toFixed(1)+'个百分点。'+' 判定：旧点来自"数字密集型论说文单篇"，新点来自"3组9段拼接跨风格样本"。拼接样本由于在 3 段间插入了2段桥接段(含 想起朋友聊天 / 说起来你可能不信这类典型人写句)，对官方检测器来说"人写比例被抬高"→ 导致 低 x 档(已去味+加桥) 官方%反而高于旧纯文本可比档，这就是截距漂移的成因。桥接段贡献约'+(N.b-O.b).toFixed(0)+'% 人工基底，相当于对 检测器输入混入了 3 段过渡段共约 100 字的"明确人写特征"，因此新 3 个数据点 与 旧 3 个数据点 不可直接线性合并。');
console.log('\n因此发布策略：双轨发布。主线仍保持 n=3 旧公式(原文档声明的"仅数字密集型")，但在文档追加 "跨风格拼接样本 n=3 专用映射" + 说明桥接段效应，并在 App.tsx 阈值表旁增加"风格提醒"。');
