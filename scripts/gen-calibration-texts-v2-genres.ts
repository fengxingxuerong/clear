// scripts/gen-calibration-texts-v2-genres.ts
// 3 个体裁 × 3 档 + 纯人写稿 1 档 = 10 段
// 每段都生成 ≥ 400 字，可直接单篇送朱雀官方，不需要桥接段
import { humanize } from '../src/engine/humanize';
import { aiScore } from '../src/engine/humanize-metrics';
import fs from 'fs';
import path from 'path';

// ---------- 原文样本（AI 生成风格典型稿）----------
const SAMPLES: Record<string, string> = {
  // 叙事文：AI 典型"三段式叙事"
  narrative: `那是一个下着小雨的周末早晨，我独自踏上了前往西山古镇的旅程。值得注意的是，这座拥有六百多年历史的小镇，近年来因为一部热播电视剧的取景而重新走进了大众的视野。综上所述，每一位慕名而来的游客，都能在青石板路、白墙黛瓦与潺潺溪水之间，找到属于自己内心深处的那份宁静与感动。
  我沿着蜿蜒曲折的小巷一路前行，两侧鳞次栉比的老店铺依次映入眼帘——从香气扑鼻的桂花糕作坊、到挂满油纸伞的手工艺品店、再到传出悠扬琵琶声的茶馆，每一处细节都仿佛在无声地诉说着光阴的故事。与此同时，几位身穿汉服的年轻女孩在石桥上摆着各种姿势拍照留念，她们的笑声与淅淅沥沥的雨声交织在一起，构成了一幅极具层次感的生动画面。
  临近中午，我选了一家门头挂着"百年老店"牌匾的小饭馆坐下，点了一份招牌的酱鸭面和一杯碧螺春。面汤醇厚，鸭肉酥烂，茶叶清香，每一口都让人回味无穷。因此，这趟看似寻常的短途旅行，却在不经意间给我留下了极为深刻而美好的印象。临走前，我特意绕到镇后的小山丘上俯瞰全景，烟雨朦胧中的古镇宛如一幅徐徐展开的水墨长卷，令人久久不愿离去。`,

  // 对话体：AI 典型"格式化对白 + 每句回应都长篇大论"
  dialogue: `【场景：一家创业公司的会议室，周一上午的项目周会】

张总（项目经理）：大家早上好，今天我们来开本周的项目周会。值得注意的是，下周就是产品 V2.0 正式上线的时间节点，因此今天的议题主要围绕上线前的最后一轮准备工作展开。综上所述，希望各位同事能够逐一汇报各自负责模块的当前进度，并提前暴露可能存在的风险点。

李工（前端负责人）：张总您好，我这边负责的前端模块目前进展比较顺利。具体来说，所有核心功能页面的开发工作已经完成了百分之九十五以上，剩下的就是一些 UI 细节的微调以及和后端接口的最后联调。与此同时，我们也对移动端的适配做了一轮全面的回归测试，整体兼容性表现良好。不过需要提醒大家的是，支付模块最近做了一次比较大的重构，我建议今天下午安排一次压力测试来确保稳定性。

王工（后端负责人）：我这边的情况和李工差不多。服务端的接口已经全部交付完毕，数据迁移脚本也在测试环境跑通了两次。值得一提的是，我们对数据库的查询性能做了针对性的优化，目前核心接口的平均响应时间从原来的 800 毫秒降到了 350 毫秒左右，降幅超过五成。此外，风控和日志两条链路的监控告警阈值也已经配置完成，上线后一旦出现异常情况会第一时间推送到企业微信群里。

张总（项目经理）：好的，非常感谢两位工程师的详细汇报。既然技术层面整体比较乐观，那我们接下来就讨论一下运营侧的准备工作。综上所述，今天下午我会先和运营部的同事同步目前的进度，然后明天下班前我们再开一次最后上线前的全员确认会。与此同时，请大家在上线当天保持手机通讯畅通，随时待命，确保万无一失。`,

  // 纯人写稿：手写风格（日常口语化、偏随意、段落不规整）
  humanHand: `周末我去了趟超市，本来只想买盒牛奶和面包，结果进去一逛就停不下来。
  三楼的零食区在打折，薯片买二送一，我随手抓了三包，后来又觉得吃这么多油炸的不太好，又放回去两包……最后就拿了一包番茄味的，也算折中吧。
  然后路过水果区，看到草莓还挺新鲜，就挑了一小盒。旁边的阿姨跟我说，"小姑娘，你拿的这个不行，翻底下那层，刚摆出来的"，我听她的翻了一下，果然底下的个头更大一点，赶紧谢谢她。
  结账的时候排了挺久的队，前面那个大爷好像不太会用自助付款，折腾了好半天，后面的人也都没说啥，大家就耐心等着。最后我一共花了 138 块 6，比我预想的超了 80 多。回家路上我一直在想，我到底为啥买了这么多用不着的东西？哦对了，还买了一支护手霜，收银台旁边摆着的，刚好我那个用完了，就顺手拿了一支。
  到家打开冰箱把东西塞进去，这才发现——我上周买的牛奶还没喝完呢。唉。`,
};

type Entry = {
  genre: 'narrative' | 'dialogue' | 'humanHand';
  genreZh: string;
  level: string;     // 原文 / 基础档 / 朱雀档 / 纯人写稿(不去味)
  intensity: number; // 0~1
  zhuqueMode: boolean;
  aiScore: number;
  chars: number;
  text: string;
};

const entries: Entry[] = [];

type Level = { k: string; zh: string; intensity: number; zhuque: boolean };
const levels: Level[] = [
  { k: 'original', zh: '原文', intensity: 0, zhuque: false },
  { k: 'basic', zh: '基础档(0.6)', intensity: 0.6, zhuque: false },
  { k: 'zhuque', zh: '朱雀档(0.9)', intensity: 0.9, zhuque: true },
];

const genreMap: { k: Entry['genre']; zh: string }[] = [
  { k: 'narrative', zh: '叙事文' },
  { k: 'dialogue', zh: '对话体' },
  { k: 'humanHand', zh: '纯人写稿' },
];

function runHumanize(raw: string, intensity: number, zhuqueMode: boolean): string {
  const r = humanize(raw, { intensity, zhuqueMode });
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object' && typeof (r as any).text === 'string') return (r as any).text;
  return raw;
}

for (const g of genreMap) {
  const raw = SAMPLES[g.k];
  if (g.k === 'humanHand') {
    // 纯人写稿：不去味，只跑 1 档"纯人写稿(无处理)" 给 aiScore 做误杀地板测量
    const s = aiScore(raw);
    entries.push({
      genre: g.k, genreZh: g.zh,
      level: '纯人写稿(无处理)', intensity: 0, zhuqueMode: false,
      aiScore: s.score,
      chars: raw.replace(/\s/g, '').length,
      text: raw,
    });
    // 同时给纯人写稿也跑 2 档（去味一下），看 aiScore / 官方分 会不会反而"越去味越像 AI"
    for (const lvl of levels.slice(1)) {
      const rTxt = runHumanize(raw, lvl.intensity, lvl.zhuque).trim() || raw;
      const s2 = aiScore(rTxt);
      entries.push({
        genre: g.k, genreZh: g.zh + '(去味对照)',
        level: lvl.zh, intensity: lvl.intensity, zhuqueMode: lvl.zhuque,
        aiScore: s2.score,
        chars: rTxt.replace(/\s/g, '').length,
        text: rTxt,
      });
    }
  } else {
    for (const lvl of levels) {
      const txt = lvl.intensity === 0 ? raw : runHumanize(raw, lvl.intensity, lvl.zhuque).trim() || raw;
      const s = aiScore(txt);
      entries.push({
        genre: g.k, genreZh: g.zh,
        level: lvl.zh, intensity: lvl.intensity, zhuqueMode: lvl.zhuque,
        aiScore: s.score,
        chars: txt.replace(/\s/g, '').length,
        text: txt,
      });
    }
  }
}

// ---------- 字数检查：不足 360 的末尾追加一小段自然的内容 ----------
const FILLER = [
  "  写到这儿我又想起了一个小细节，就是当时天上还飘着几朵云，慢悠悠地往南边挪。",
  "  说句题外话，那天我其实还遇到了一件有意思的小事，只是这会儿三言两语说不太清楚。",
  "  哦对了，前一天晚上我睡得挺好，所以第二天整个人的精神状态其实挺不错的。",
  "  回头想想，这些琐碎片段虽然没那么重要，可拼在一起反倒觉得挺真实的。",
];
for (const e of entries) {
  while (e.chars < 360) {
    const add = FILLER[Math.floor(Math.random() * FILLER.length)];
    e.text += add;
    e.chars = e.text.replace(/\s/g, '').length;
  }
}

// ---------- 写 JSON ----------
const outDir = process.cwd();
const jsonPath = path.join(outDir, 'scripts', 'calibration-data-v2-genres.json');
fs.writeFileSync(jsonPath, JSON.stringify(entries, null, 2), 'utf-8');

// ---------- 控制台汇总表 ----------
console.log('=== 体裁覆盖标定 样本生成  v2  2026-08-25 ===');
console.log('id  体裁              档位                    aiScore  字数   备注');
let idx = 1;
for (const e of entries) {
  const flag1 = e.chars >= 350 ? '✅过下限' : '⚠️不足350';
  console.log(
    String(idx).padStart(2) + '. ' +
    e.genreZh.padEnd(14) + ' ' +
    e.level.padEnd(16) + ' ' +
    String(e.aiScore).padStart(4) + '   ' +
    String(e.chars).padStart(4) + '   ' +
    flag1
  );
  idx++;
}
console.log(`\nJSON 已写入: ${jsonPath}`);

// ---------- 顺带生成人工送检 txt ----------
const manualPath = path.join(outDir, 'scripts', 'zhuque-manual-inputs-v2-genres.txt');
const lines: string[] = [];
lines.push('# 朱雀官方送检 · 体裁扩充标定（v2，10 段单篇，均≥360字，无需拼接）');
lines.push('# 打开 https://matrix.tencent.com/ai-detect/ai_gen → 文本 Tab → 粘贴 → 立即检测 → 记录 AI概率%');
lines.push('# 回传格式（任选一种，按 id 顺序即可）：');
lines.push('#   A: N1=__,N2=__,N3=__  D1=__,D2=__,D3=__  H0=__,H1=__,H2=__');
lines.push('#   B: 直接 10 个数字用逗号/空格分开（按 id 1~10 顺序）');
lines.push('');
idx = 1;
for (const e of entries) {
  // 简化 id 命名
  let simpleId = '';
  if (e.genre === 'narrative') simpleId = e.level === '原文' ? 'N1' : e.level === '基础档(0.6)' ? 'N2' : 'N3';
  if (e.genre === 'dialogue') simpleId = e.level === '原文' ? 'D1' : e.level === '基础档(0.6)' ? 'D2' : 'D3';
  if (e.genre === 'humanHand') {
    if (e.level === '纯人写稿(无处理)') simpleId = 'H0';
    else if (e.level === '基础档(0.6)') simpleId = 'H1';
    else simpleId = 'H2';
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`【${String(idx).padStart(2,'0')} · id=${simpleId}】  ${e.genreZh}  /  ${e.level}    aiScore=${e.aiScore}  字数=${e.chars}  →  官方 y= ____ %`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(e.text.trim());
  lines.push('');
  idx++;
}
fs.writeFileSync(manualPath, lines.join('\n'), 'utf-8');
console.log(`送检 txt 已写入: ${manualPath}`);
console.log('\n📌 下一步：把 scripts/zhuque-manual-inputs-v2-genres.txt 里 10 段依次粘贴到官方网页，');
console.log('   拿到 10 个%后按 id 顺序回传（例如 N1=78, N2=33, N3=21, D1=89, D2=41, D3=29, H0=14, H1=23, H2=19）。');
console.log('   拿到后会跑 10 点 + 旧 3 点 = 共 13 点交叉验证：判断主线公式 y≈2.008x+19.2 是否跨体裁成立。');
