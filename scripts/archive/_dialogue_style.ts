/**
 * scripts/_dialogue_style.ts —— 对话体下 casual vs plain（临时）
 *
 * 目的：判断 casual 是否在某个体裁上仍有价值。
 * 若 casual 只在 main 上致害、在 dialogue 上有益 → 应做体裁门控而非改全局默认。
 */
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";

const CASES: Array<{ id: string; genre: "dialogue" | "narrative" | "humanHand"; text: string }> = [
  {
    id: "对话体",
    genre: "dialogue",
    text: `"你昨天怎么没来？"\n"家里有点事，实在走不开。"\n"下次提前说一声。"\n"知道了，抱歉。"`,
  },
  {
    id: "对话体-AI味",
    genre: "dialogue",
    text: `"你为什么选择这个行业？"\n"首先，我对这个领域有着浓厚的兴趣。其次，它能够充分发挥我的专业特长。此外，这个行业的发展前景十分广阔。综上所述，我认为这是一个明智的选择。"\n"听起来很有道理。"\n"谢谢，我会继续努力的。"`,
  },
  {
    id: "人写",
    genre: "humanHand",
    text: "昨儿个下大雨，我懒得出门，就窝在沙发上翻旧相册。看着看着，想起小时候跟姥姥去赶集的事。那会儿一块钱能买一堆糖，甜得我直咧嘴。现在想想，那才叫快乐。",
  },
];

console.log("文本".padEnd(16) + "原文  casual均值/max   plain均值/max  academic均值/max");
for (const c of CASES) {
  const before = aiScore(c.text).score;
  const out: Record<string, string> = {};
  for (const style of ["casual", "plain", "academic"] as const) {
    const arr: number[] = [];
    for (const it of [0.6, 0.7, 0.8, 0.9]) {
      for (let seed = 1; seed <= 20; seed++) {
        arr.push(aiScore(humanize(c.text, { intensity: it, seed, genre: c.genre, style, zhuqueMode: true })).score);
      }
    }
    const avg = arr.reduce((x, y) => x + y, 0) / arr.length;
    out[style] = `${avg.toFixed(1).padStart(5)}/${Math.max(...arr).toFixed(0).padStart(3)}`;
  }
  console.log(c.id.padEnd(14) + String(before).padStart(4) + "  " + out.casual + "   " + out.plain + "   " + out.academic);
}
