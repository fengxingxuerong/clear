// 一次性：分析待搬区间的内部依赖（只读，不写任何文件）
import fs from "node:fs";

const P = "D:/projects/quaiwei/src/engine/humanize.ts";
const lines = fs.readFileSync(P, "utf8").split("\n");

const seg = (a, b) => lines.slice(a - 1, b); // 1-based 闭区间

const A1 = seg(149, 162);
const A2 = seg(295, 490);
const B1 = seg(293, 293);
const B2 = seg(1581, 2428);

// 锚点校验
const check = (name, arr, firstNeedle, lastNeedle) => {
  const head = arr.slice(0, 5).join("\n");
  const okF = head.includes(firstNeedle);
  const okL = arr[arr.length - 1].includes(lastNeedle);
  console.log(`${name}: ${arr.length} 行 | 首锚点 ${okF ? "OK" : "FAIL → " + arr[0].slice(0, 50)} | 末锚点 ${okL ? "OK" : "FAIL → " + JSON.stringify(arr[arr.length - 1].slice(0, 50))}`);
  if (!okF || !okL) process.exit(1);
};
check("A1 常量", A1, "REPLACE_VOCAB_BASE", "DROP_CONNECTIVE_INTENSITY_THRESHOLD");
check("A2 替换规则", A2, "REPLACE_VOCAB_CANDIDATES", "]);");
check("B1 场景块", B1, "SCENE_BLOCK_LINE_RE = /", "SCENE_BLOCK_LINE_RE = /");
check("B2 朱雀增强", B2, "applyZhuqueFeatures", "}");

// 顶层声明清单（排除待搬区间内的）
const declRe = /^(?:export\s+)?(?:const|let|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const topLevel = new Map(); // name -> line no
lines.forEach((l, i) => {
  const m = declRe.exec(l);
  if (m) topLevel.set(m[1], i + 1);
});

const moving = new Set();
for (const [a, b] of [
  [149, 162],
  [293, 293],
  [295, 490],
  [1581, 2428],
]) {
  for (let n = a; n <= b; n++) moving.add(n);
}

const external = new Map(); // name -> 定义行
for (const [name, ln] of topLevel) {
  if (!moving.has(ln)) external.set(name, ln);
}

// 在待搬区间里找用到的外部符号
const identRe = /\b([A-Za-z_$][\w$]{2,})\b/g;
const KEYWORDS = new Set(["const", "let", "var", "function", "return", "export", "import", "from", "type", "interface", "if", "else", "for", "while", "new", "class", "extends", "true", "false", "null", "undefined", "string", "number", "boolean", "void", "this", "throw", "try", "catch", "finally", "switch", "case", "break", "continue", "default", "await", "async", "yield", "typeof", "instanceof", "in", "of", "as", "satisfies", "readonly", "public", "private", "protected", "static", "get", "set", "declare", "abstract", "implements", "namespace", "module", "enum"]);

for (const [label, arr] of [
  ["A(1a rules)", [...A1, ...A2]],
  ["B(1b zhuque)", [...B1, ...B2]],
]) {
  const used = new Set();
  for (const l of arr) {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
    for (const m of l.matchAll(identRe)) {
      const id = m[1];
      if (KEYWORDS.has(id)) continue;
      if (external.has(id)) used.add(id);
    }
  }
  console.log(`\n=== ${label} 需要的 humanize.ts 外部符号（${used.size}）===`);
  for (const id of [...used].sort()) console.log(`   ${id}  (定义于第 ${external.get(id)} 行)`);
}

// 同时报告：humanize.ts 里 export 出去、但定义在待搬区间的符号（需要 re-export）
console.log(`\n=== 待搬区间里被 export 的符号（humanize.ts 必须 re-export）===`);
for (const [a, b] of [
  [149, 162],
  [293, 293],
  [295, 490],
  [1581, 2428],
]) {
  for (let n = a; n <= b; n++) {
    const l = lines[n - 1];
    const m = /^export\s+(?:const|function|type|interface|class|let)\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (m) console.log(`   第 ${n} 行  ${m[1]}`);
  }
}
