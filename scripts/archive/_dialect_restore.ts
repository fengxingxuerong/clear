/**
 * 方言还原表（FORMAL_RESTORE 前半段）在 injectDialect 停用后是否变成误伤源？
 * 场景：用户原文本来就含方言词，走 formal 语体（论说/公文/学术）会被无条件还原。
 */
import { humanize } from "../src/engine/humanize.ts";

// 用户原文正常含方言词（不是引擎注入的）
const USER_TEXT_WITH_DIALECT = `老王这人干活麻利，街坊都晓得他的脾气。那天我去找他，瞅见他在院子里修车。

他跟我说，这事儿得慢慢唠。`;

const DIALECT_WORDS = ["麻利", "晓得", "瞅见", "瞅", "唠"];

console.log("原文：", USER_TEXT_WITH_DIALECT.replace(/\n+/g, " ⏎ "));
console.log("");

for (const genre of ["main", "narrative", "humanHand"] as const) {
  for (const style of ["academic", "casual"] as const) {
    const out = humanize(USER_TEXT_WITH_DIALECT, {
      intensity: 0.9,
      zhuqueMode: true,
      genre,
      style,
      seed: 1,
    });
    const lost = DIALECT_WORDS.filter(
      (w) => USER_TEXT_WITH_DIALECT.includes(w) && !out.includes(w),
    );
    console.log(
      `${genre}/${style}: 丢失方言词 [${lost.join(",") || "无"}]`,
    );
    if (lost.length) console.log(`   → ${out.replace(/\n+/g, " ⏎ ")}`);
  }
}
