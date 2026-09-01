/* P6-B 自动体裁识别自检：用 v2 归档 9 样 + v3 新 6 样的 text，验证 D→dialogue / O→main / N→narrative / H 保持手动提示
   注意：若 V3_PTS_JSON 或 V2_JSON 不存在 → 直接打印要求路径，但不崩溃（降级用内置短样例跑） */
import fs from "node:fs";
import path from "node:path";
import { classifyGenre, GENRE_ZH, type AutoGenre } from "../src/engine/classify-genre.ts";

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), "..");
const V2 = path.join(ROOT, "scripts", "calibration-data-v2-genres.json");

interface TestCase { id: string; expectGenre: AutoGenre | "human(manual)"; text: string; }
const cases: TestCase[] = [];

// 1) v2 JSON：有 text 字段，但没有官分（之前分析过）
if (fs.existsSync(V2)) {
  try {
    const arr = JSON.parse(fs.readFileSync(V2, "utf8")) as any[];
    for (const r of arr) {
      if (!r.text || r.text.length < 50) continue;
      const g: AutoGenre | "human(manual)" = (r.genre === "expository" || r.genre === "main") ? "main"
        : r.genre === "narrative" ? "narrative"
        : r.genre === "dialogue" ? "dialogue"
        : r.genre === "humanHand" || r.genre === "human" ? "human(manual)"
        : "main";
      // 对每一个 level 对应一个 case（原文/基础档/朱雀档）
      const id = (r.id ?? (r.genre + "|" + r.level)) + "|" + (r.level ?? "L");
      cases.push({ id, expectGenre: g, text: r.text });
    }
  } catch (e) {
    console.warn(`[selfcheck] 样例加载失败（跳过该来源）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 2) v3 Pts：每点有 processedText（来自回归生成）+ 没有的话从 zhuque-v3-out 里读 txt
function readOut(id: string): string | null {
  const dir = path.join(ROOT, "scripts", "zhuque-v3-out");
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find(n => n.startsWith(id + "-"));
  return hit ? fs.readFileSync(path.join(dir, hit), "utf8") : null;
}
const V3_KNOWN: Array<{id:string; g: AutoGenre | "human(manual)"}> = [
  { id: "O2", g: "main" },
  { id: "O3", g: "main" },
  { id: "N2", g: "narrative" },
  { id: "D1", g: "dialogue" },
  { id: "D2", g: "dialogue" },
  { id: "H2", g: "human(manual)" },
];
for (const k of V3_KNOWN) {
  const t = readOut(k.id);
  if (t) cases.push({ id: k.id + "(v3processed)", expectGenre: k.g, text: t });
}

// 3) 兜底：如果 v2/v3 都没读到，放 3 条短样例确保脚本可运行
if (cases.length === 0) {
  cases.push({
    id: "manual-sample-O", expectGenre: "main",
    text: "基于上述分析，我们可以得出三个结论。首先，政府部门应当建立完善的监管体系，制定更加严格的行业标准。其次，企业要强化自身的主体责任意识，在产品质量、售后服务、用户权益保护等方面持续投入。最后，广大消费者也应理性维权，通过正当渠道表达合理的诉求，共同营造一个公平、透明、可信赖的市场环境。综上所述，只有各方齐心协力，才能从根本上解决当前面临的种种问题。"
  });
  cases.push({
    id: "manual-sample-N", expectGenre: "narrative",
    text: "去年秋天我去了一趟徽州，在一个不知名的小镇上住了三天。那天早上，我推开门就看到薄雾笼着远处的山，空气中飘着淡淡的桂花香。老板从厨房里端出一碗粥，笑着说：「尝尝这个，自家种的。」我坐在门槛上喝着粥，看着一只黄狗从巷口慢悠悠地走过去。后来我沿着青石板路走到河边，河边有人在洗衣服，棒槌声一声一声传过来，好像把时间敲得很慢很慢。"
  });
  cases.push({
    id: "manual-sample-D", expectGenre: "dialogue",
    text: "小明：你听说了吗？下周公司要搬到新楼啦。\n小红：真的？在哪儿呀？\n小明：科技园东路那边，离地铁口三分钟。哎，你之前不是说上下班太远吗？这可好了。\n小红：是啊是啊，不过听说新楼要刷指纹进门，我最近手指总是爆皮……\n小明：哈哈那你去录两个手指，左手一个右手一个，保险点。\n小红：有道理！对了，午饭吃啥？\n小明：楼下新开了一家冒菜，要不今天先去尝尝？"
  });
  cases.push({
    id: "manual-sample-H", expectGenre: "human(manual)",
    text: "今天中午炖了排骨汤，妈非要放八角，我说别放那么重的料，小孩不爱吃。她就不高兴了，说她炖了二十多年汤轮不到我教。哎，老人就是这样，说不得。最后汤端上来我尝了一口，其实真的挺香，就是不敢夸，一夸下次还放。"
  });
}

// —— 执行分类 ——
let pass = 0, fail = 0;
type Row = {id:string; expect:string; got:string; conf:number; rule:number; ok:boolean; feats?:string};
const rows: Row[] = [];
for (const c of cases) {
  const r = classifyGenre(c.text);
  // 期望值为 human(manual) 时：✅ 任何自动判据都 OK（因为我们不自动选 human），但给个提示
  const ok = c.expectGenre === "human(manual)"
    ? true   // 自动器不选 human → 任何都视为通过（因为 human 需要手动）
    : r.genre === c.expectGenre;
  const feats = `dQ=${r.features.dlgQuoteRatio.toFixed(3)} dC=${r.features.dlgColonRatio.toFixed(2)} dSB=${r.features.dlgSceneBlockRatio.toFixed(4)} expo=${r.features.expoScore.toFixed(2)} past=${r.features.narPastRatio.toFixed(3)} scene=${r.features.narSceneRatio.toFixed(3)} short=${r.features.dlgShortTurn.toFixed(2)} chars=${r.features.pureChars} sents=${r.features.sentCount}`;
  rows.push({
    id: c.id.padEnd(32).slice(0,32),
    expect: c.expectGenre === "human(manual)" ? "human(手动)" : c.expectGenre,
    got: GENRE_ZH[r.genre as AutoGenre] ?? r.genre,
    conf: Math.round(r.confidence * 100),
    rule: r.ruleHit,
    ok,
    feats,
  });
  if (ok) pass++; else fail++;
}

// 打印汇总表
console.log("自动体裁识别自检 (n=" + cases.length + ")  P=" + pass + "  F=" + fail + "\n");
console.log("ID                             期望              识别结果     置信  规则  结果  特征向量");
console.log("—————————————————————————————————————————————————————————————————————————————————————————————————");
for (const r of rows) {
  const tag = r.ok ? "\x1b[32m✅\x1b[0m" : "\x1b[31m❌\x1b[0m";
  console.log(`${r.id}  ${r.expect.padEnd(10)}  ${r.got.padEnd(7)}   ${String(r.conf).padStart(3)}%   R${r.rule}   ${tag}  ${r.feats}`);
}
console.log("");
console.log(fail === 0
  ? "\x1b[32m✅ 全部自检通过\x1b[0m"
  : `\x1b[31m❌ 失败 ${fail} 项 — 请检查上表中期望 vs 识别结果，调整阈值或特征\x1b[0m`
);
console.log("");
console.log("说明：H=纯人写稿 不自动选 human 轨道（负斜率需用户确认是「原稿未去味」才启用），视为自动通过。");
process.exit(fail === 0 ? 0 : 1);
