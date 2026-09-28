import { humanize, aiScore } from "../src/engine/humanize.ts";

const NARR = `那天下午雨下得很大，我撑着伞走在回家的路上。路过巷口的时候，看见老王蹲在屋檐下抽烟。他抬头冲我笑了笑，说这雨怕是一时半会儿停不了。

我点点头，继续往前走，鞋子里灌满了水。街边的梧桐树被风吹得东倒西歪，叶子贴了一地。走到半路，遇见隔壁的小女孩蹲在水坑边叠纸船，裙角湿了一大片。

回到家，我妈正站在厨房窗前看雨。她头也没回，只说了句锅里热着汤。我把湿外套挂在门后，听见雨点砸在雨棚上的声音，忽然觉得这个下午格外安静。`;

const out = humanize(NARR, { intensity: 0.9, zhuqueMode: true, genre: "narrative", seed: 7 });
console.log("输出:", out);
console.log("\n明细:", JSON.stringify(aiScore(out)));

// 3e 逐句拆解，找出被污染的是哪几句
const PAD = ["说真的","说实话","讲真","要我说","说白了","我寻思","老实讲","不瞒你说","你别说","按我的经验","反正","所以说","总之","总的来说","反过来看","平心而论","其实","说到底","具体来说","换句话说","简单说","总体而言","坦白讲","老实说","严格来说","客观来讲","有一说一","不吹不黑","往深了说","简单来说","你细品","凭良心说","说句实在话","往实了说","话又说回来","我琢磨着","我寻思着","我觉得","我认为","在我看来","以我的经验","据我观察","按我的理解","我的看法是","我感觉","这么说吧","客观讲","往好听了说","真要说起来","夸张点说","说难听点","说句不好听的","你想想","讲道理"];
const PART = ["嗯","啊","哦","嗨","咳","呣","啧","诶","哈","嗼","呵"];
const FRAG = ["就这样","怎么说呢","反正就那样","你懂的","没别的意思","话是这么说","道理是这个道理","也不是不行","差不多得了","懂的都懂","你别不信","这谁说得准呢","也不是没有道理","行吧","随你怎么说","反正我信了","无话可说","是啊","哦对"];
const ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sents = out.split(/(?<=[。！？])|\n+/).map((s) => s.trim()).filter(Boolean);
console.log("\n3e 逐句判定:");
for (const s of sents) {
  const bare = s.replace(/[。！？]+$/, "");
  const head = new RegExp(`^(?:${PAD.map(ESC).join("|")})[，,]`).test(s);
  const mid = new RegExp(`^.{4,}?(?:${PAD.map(ESC).join("|")})[，,]`).test(bare);
  const part = new RegExp(`[\\u4e00-\\u9fa5](?:${PART.map(ESC).join("|")})[，,。！？]`).test(s);
  const frag = new RegExp(`^(?:${FRAG.map(ESC).join("|")})[。！？]?$`).test(bare);
  const hit = head || mid || part || frag;
  if (hit) {
    console.log(`  [污染] ${s.slice(0, 40)}`);
    console.log(`         句首垫词=${head} 句中垫词=${mid} 语气词=${part} 碎片=${frag}`);
  }
}
