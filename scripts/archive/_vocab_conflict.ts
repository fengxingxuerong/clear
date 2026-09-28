/**
 * 词表冲突审计（完整版）：注入侧 vs 清除侧取交集。
 */
import {
  PARENTHETICALS,
  SENTENCE_FRAGMENTS,
  OPINION_PHRASES,
  PARENTHETIC_NOTES,
} from "../src/engine/humanize-zhuque.ts";
import { PAD_HEADS } from "../src/engine/humanize-primitives.ts";

// 清除侧：从 anti-fingerprint.ts 源码抄录（模块内未导出）
const REPEAT_PHRASES = [
  "我随便举一个你就懂了", "这事儿还真不是我瞎编", "别急，我慢慢跟你捋", "那你自己试试就知道了",
  "因为事实就摆在眼前", "这不是理所当然的吗", "有人要抬杠了", "真的假的", "为啥这么说",
  "例子呢", "你可能会问", "其实不然", "不信？", "搁谁都一样", "你细品", "有意思的是",
  "我寻思着", "按我的经验", "以我的经验", "往实了说", "往好听了说", "唠到底",
  "你懂的", "就这样", "这有什么要紧的", "要紧的在后头", "细想一下还真不是",
  "就这么回事", "话又侃回来", "侃真的", "据我观察", "客观讲", "老实讲",
  "不瞒你说", "不吹不黑", "讲道理",
];

// 注入侧合并（去掉句末标点做归一）
function norm(s: string) {
  return s.replace(/[。！？，、]+$/g, "").trim();
}

const INJECT_SOURCES: Record<string, string[]> = {
  "zhuque.PARENTHETICALS": PARENTHETICALS,
  "zhuque.SENTENCE_FRAGMENTS": SENTENCE_FRAGMENTS,
  "zhuque.OPINION_PHRASES": OPINION_PHRASES,
  "zhuque.PARENTHETIC_NOTES": PARENTHETIC_NOTES,
  "primitives.PAD_HEADS": PAD_HEADS,
};

const injectMap = new Map<string, string[]>(); // 词 → 来源列表
for (const [src, list] of Object.entries(INJECT_SOURCES)) {
  for (const raw of list) {
    const w = norm(raw);
    if (!w) continue;
    if (!injectMap.has(w)) injectMap.set(w, []);
    injectMap.get(w)!.push(sourceLabel(src, raw));
  }
}

const clearMap = new Map<string, string[]>();
for (const raw of REPEAT_PHRASES) {
  const w = norm(raw);
  if (!w) continue;
  if (!clearMap.has(w)) clearMap.set(w, []);
  clearMap.get(w)!.push("anti-fingerprint.REPEAT_PHRASES");
}

function sourceLabel(src: string, raw: string) {
  return `${src}(${raw})`;
}

console.log("注入侧词条总数:", injectMap.size);
console.log("清除侧词条总数:", clearMap.size);

const conflicts: Array<[string, string[], string[]]> = [];
for (const [w, inj] of injectMap) {
  if (clearMap.has(w)) conflicts.push([w, inj, clearMap.get(w)!]);
}

console.log(`\n${"=".repeat(70)}`);
console.log(`冲突词总数: ${conflicts.length}  ← 同一个词既被注入又被清除`);
console.log("=".repeat(70));
for (const [w, inj, clr] of conflicts) {
  console.log(`\n★ 「${w}」`);
  console.log(`   注入 ← ${inj.join(" / ")}`);
  console.log(`   清除 ← ${clr.join(" / ")}`);
}

// 顺便列出"只在注入侧"的高危词（无对应清除 = 会永久残留）
console.log(`\n${"=".repeat(70)}`);
console.log("注入侧独有（无清除对应，会永久残留）:");
console.log("=".repeat(70));
for (const [w, inj] of injectMap) {
  if (!clearMap.has(w)) console.log(`  ${w.padEnd(16)} ← ${inj.map((s) => s.split("(")[0]).join(", ")}`);
}
