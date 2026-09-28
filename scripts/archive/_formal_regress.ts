/**
 * 回归确认：移除方言还原段后，网络口语还原（服务活跃 VOCAB 映射）仍正常。
 * 手法：喂 AI 套话原文 → 0.9 档 formal 语体 → 看是否被错改成网络口语。
 */
import { humanize } from "../src/engine/humanize.ts";

const FORMAL_CASES: Array<[string, string]> = [
  ["公文", `我们要坚持以问题为导向，久久为功，不断完善数据治理体系。同时要打通数据壁垒，确保风险不发生，稳步推进各项改革任务。`],
  ["论说", `企业应当持续提升核心竞争力，构建完善的创新体系。在推进数字化转型的过程中，需要统筹各项资源，确保目标落地见效。`],
];

// 这些是 VOCAB 的坏替身，正式语体下必须被还原
const POLLUTION = ["死磕", "摆平", "捋顺", "弄全", "兜好", "拔高", "盯紧", "把牢", "搭起", "连上壁垒", "稳当", "环绕年度"];

console.log("网络口语还原回归（0.9 档，academic 语体）\n" + "=".repeat(60));
for (const [name, text] of FORMAL_CASES) {
  for (let seed = 1; seed <= 5; seed++) {
    const out = humanize(text, { intensity: 0.9, zhuqueMode: true, genre: "main", style: "academic", seed });
    const leaked = POLLUTION.filter((w) => out.includes(w));
    if (leaked.length) {
      console.log(`  ⚠️ ${name} seed=${seed} 漏网: [${leaked.join(",")}]`);
    }
  }
  console.log(`  ${name}: 5 seed 扫描完成`);
}
console.log("\n（无 ⚠️ 行 = 网络口语还原正常）");
