/** 干跑：确认每条 defect 夹具的缺陷句编号能被正确切出并定位（不调用 LLM） */
import { CASES, analyze } from "./cases.ts";

let bad = 0;
for (const c of CASES) {
  const { sentences, defectIdx } = analyze(c);
  if (c.kind === "clean") {
    console.log(`  ·  ${c.id.padEnd(22)} ${sentences.length} 句（clean）`);
    continue;
  }
  const ok = defectIdx != null;
  if (!ok) bad++;
  const shown = ok
    ? `第${defectIdx}句「${sentences[(defectIdx ?? 1) - 1].slice(0, 24)}」`
    : "❌ 定位失败";
  console.log(`  ${ok ? "✅" : "❌"} ${c.id.padEnd(22)} ${sentences.length} 句 → ${shown}`);
}
console.log(`\n定位失败 ${bad} 条`);
