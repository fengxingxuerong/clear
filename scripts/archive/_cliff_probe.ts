/**
 * 断崖定位：intensity 0.45→0.40 之间发生了什么？
 * 手法：用「单段文本」直调 humanizeSingle 无法访问（未导出），
 * 改为对同一文本用不同 intensity 跑 humanize，抓所有「概率门槛」。
 */
import { humanize, aiScore } from "../src/engine/humanize.ts";


const HUMAN = `周末去了趟菜市场。西红柿涨到六块五一斤，摊主说连着下了半个月雨，大棚里光照不够。我挑了几个软硬适中的，又顺路买了半斤饺子皮。

回来的路上太阳出来了，晒得后背发烫。路过巷口，看见邻居家的猫趴在墙头打盹，尾巴有一搭没一搭地甩。我站了一会儿，才慢悠悠往家走。

到家把菜洗了，水龙头的水凉得扎手。窗户开着，能听见楼下小孩在吵，也不知道在争什么。我想，这样一下午，其实也挺好。`;

console.log("细扫 0.36~0.50 每一档");
for (let i = 36; i <= 50; i++) {
  const it = i / 100;
  const out = humanize(HUMAN, { intensity: it, zhuqueMode: true, genre: "humanHand", seed: 7 });
  const s = aiScore(out);
  const hasFrag = /(^|[。！？\n]\s*)(就这样|怎么说呢|你懂的|反正就那样|差不多得了|哦对|是啊|行吧)[。！？]/.test(out);
  const hasPad = /(^|[。！？\n]\s*)(说真的|讲真|说白了|其实|坦白讲|我寻思着)[，,]/.test(out);
  console.log(`  ${it.toFixed(2)} → score=${String(s.score).padStart(3)} 句式=${String(s.structureHits).padStart(3)}  碎片=${hasFrag ? "有" : "无"}  句首垫词=${hasPad ? "有" : "无"}`);
}

console.log("\n逐段单独跑（定位是哪一段被污染）");
for (const [i, p] of HUMAN.split(/\n\n+/).entries()) {
  const out = humanize(p, { intensity: 0.48, zhuqueMode: true, genre: "humanHand", seed: 7 });
  console.log(`  段${i + 1}: ${aiScore(out).score}分 | ${out.slice(0, 120)}`);
}
