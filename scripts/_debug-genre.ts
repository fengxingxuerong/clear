import { classifyGenre } from "../src/engine/classify-genre.ts";

const narrative = `那天下午，阳光透过窗帘的缝隙照进房间，在地板上投下一道道光影。她坐在窗边，手里捧着一本旧书，偶尔翻过一页，发出轻微的沙沙声。外面传来孩子们的笑声和远处汽车驶过的声音，但这一切似乎都与她无关。她沉浸在书中的世界里，时而微笑，时而皱眉。时间就这样慢慢地过去了。`;

const r = classifyGenre(narrative);
console.log("genre:", r.genre, "conf:", r.confidence.toFixed(2), "rule:", r.ruleHit);
console.log("features:", JSON.stringify(r.features, null, 2));

// 检查叙事判定阈值
const f = r.features;
console.log("\n=== 阈值检查 ===");
console.log(`dlgQuoteRatio: ${f.dlgQuoteRatio.toFixed(4)} (need ≥0.05 for dialogue)`);
console.log(`dlgColonRatio: ${f.dlgColonRatio.toFixed(4)} (need ≥0.15 for dialogue)`);
console.log(`expoScore: ${f.expoScore.toFixed(4)} (need ≥0.55 for main, need <0.50 for narrative)`);
console.log(`narPastRatio: ${f.narPastRatio.toFixed(4)} (need ≥0.025 for narrative)`);
console.log(`narSceneRatio: ${f.narSceneRatio.toFixed(4)} (need ≥0.018 for narrative)`);
console.log(`pureChars: ${f.pureChars}`);
console.log(`sentCount: ${f.sentCount}`);

// 手动数"了/过/已经/曾"等过去时词
const pastWords = narrative.match(/了|过|已经|曾|曾经|刚刚|刚才/g) || [];
console.log(`\n过去时词汇命中: ${pastWords.length} 个 → ${pastWords.join(", ")}`);
console.log(`按每字比率: ${(pastWords.length / f.pureChars).toFixed(4)} (阈值 0.025 → 需 ${Math.ceil(0.025 * f.pureChars)} 个)`);
