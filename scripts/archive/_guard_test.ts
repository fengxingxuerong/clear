/**
 * 验证 assertCaptureRefsValid 守卫：故意构造错误规则应立刻抛错。
 * （守卫是模块加载时执行的，所以这里复制其逻辑做等价验证）
 */
function assertCaptureRefsValid(table: readonly (readonly [RegExp, string])[], label: string): void {
  for (const [re, rep] of table) {
    const refs = [...rep.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    if (refs.length === 0) continue;
    const src = re.source;
    let groups = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== "(") continue;
      if (src[i + 1] !== "?") groups++;
      else if (src[i + 2] === "<" && src[i + 3] !== "=" && src[i + 3] !== "!") groups++;
    }
    const maxRef = Math.max(...refs);
    if (maxRef > groups) {
      throw new Error(
        `${label} 替换串引用了 $${maxRef} 但正则只有 ${groups} 个捕获组 → ` +
          `会输出字面 "$1" 污染文本：${re.source} → ${JSON.stringify(rep)}`,
      );
    }
  }
}

console.log("=== 用例 1：修复前的坏规则（应抛错）===");
try {
  assertCaptureRefsValid([[/唠(?:起|到|一|两)?/g, "谈$1"]], "TEST");
  console.log("  ❌ 未抛错 —— 守卫失效！");
} catch (e) {
  console.log(`  ✅ 正确抛错: ${(e as Error).message.slice(0, 80)}...`);
}

console.log("\n=== 用例 2：修复后的好规则（应通过）===");
try {
  assertCaptureRefsValid([[/唠(起|到|一|两)?/g, "谈$1"]], "TEST");
  console.log("  ✅ 通过");
} catch (e) {
  console.log(`  ❌ 误报: ${(e as Error).message}`);
}

console.log("\n=== 用例 3：命名捕获组（应通过）===");
try {
  assertCaptureRefsValid([[/瞅(?<x>到|见|了)?/g, "看$1"]], "TEST");
  console.log("  ✅ 通过");
} catch (e) {
  console.log(`  ❌ 误报: ${(e as Error).message}`);
}

console.log("\n=== 用例 4：无 $ 引用（应通过）===");
try {
  assertCaptureRefsValid([[/恁/g, "那么"]], "TEST");
  console.log("  ✅ 通过");
} catch (e) {
  console.log(`  ❌ 误报: ${(e as Error).message}`);
}

console.log("\n=== 用例 5：lookahead 不应被算作捕获组（应抛错）===");
try {
  assertCaptureRefsValid([[/兜住(?=不发生)/g, "确保$1"]], "TEST");
  console.log("  ❌ 未抛错 —— lookahead 被误算成捕获组！");
} catch {
  console.log(`  ✅ 正确抛错`);
}
