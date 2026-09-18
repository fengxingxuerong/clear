/**
 * meta-stress.test.ts —— 八维元压测闸门
 * ---------------------------------------------------------
 * 从旧优化工作区的 opt-full-meta.test.ts 移植：一份自带语料的宽领域压测，
 * 覆盖 humanize / mechanicalShuffle 的确定性缺陷面。与 scan-bugs 的分工是：
 * scan-bugs 守「已知病句签名不复发」，这里守「任意套话语料 × 全强度 × 全种子
 * 都不新造病句」——后者是组合爆炸，只能靠固定语料 + 多签名正则兜住。
 *
 * A 组合随机，单条失败不代表引擎坏，代表需要人看；因此按维度聚合后一次性报出。
 */
import { describe, it, expect } from "vitest";
import {
  humanize,
  mechanicalShuffle,
  fingerprintCheck,
  aiScore,
  checkFidelityLocal,
} from "./humanize.ts";

type Opts = { intensity: number; seed: number };
const both = (t: string, o: Opts) => [humanize(t, o), mechanicalShuffle(t, o)];

const INTENSITIES = [0.2, 0.4, 0.6, 0.8, 1.0];
const SEEDS = 40;

/** 头几条失败样本即可定位，全量会把测试输出撑爆 */
function summarize(fails: string[], expectKey: string) {
  expect(fails, `${expectKey}：${fails.length} 处失败，前 5 条：\n${fails.slice(0, 5).join("\n")}`).toHaveLength(0);
}

const corpusA = [
  `高位推动顶层设计，各地压茬推进、挂图作战，攻坚克难、久久为功。我们要锚定目标、紧扣主题，牵住牛鼻子、下好先手棋，打通最后一公里、跑出加速度。通过夯实基础、筑牢防线、厚植优势、盘活资源、补齐短板、锻造长板、擦亮名片，为高质量发展注入新动能、激发新活力、释放新潜力，凝聚共识、形成合力、拓宽渠道、搭建平台。以科技创新为抓手，以数字化转型为契机，成为区域协调发展的重要组成部分。`,
  `我们拉通底层架构，以增长组合拳打透关键路径，通过复盘收敛打法、拉齐认知，最终击穿痛点、放大爽点，让飞轮转起来形成护城河。对齐心智，沉淀经验，反哺业务，构建生态闭环。在高质量发展的背景下，稳步推进。`,
  `值得注意的是，在当今社会，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，人工智能技术至关重要，它不仅极大地提升了内容生产的效率，而且有效地降低了创作门槛。然而，传统的写作方式仍然发挥着不可替代的作用。因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的输出。`,
  `随着数字技术的不断发展，人们的阅读方式正在发生深刻变化，这使得传统的纸质阅读逐渐让位于数字阅读，电子书、听书、碎片化阅读成为许多人的日常选择，这一转变不仅改变了人们获取信息的渠道，也深刻影响着人们的思维习惯与生活方式，因此我们需要重新审视阅读的价值。`,
  `第二天早上他就走了，第一时间我们做了响应，最后一天最忙。第二天下午三点，第一轮测试通过，第二轮调整后进入第三阶段。这个方案有三个方面需要考量：第一是成本，第二是效率，第三是质量。`,
  `随着 AI 技术的发展，GPT-4o 的参数规模已达 1750 亿。实测准确率为 92.5%，比 GPT-3 高出 10 个百分点。详见 https://example.com/page?id=1 页面，时间是 12:30，联系 test@mail.com 咨询。可持续发展与数字化转型并重，落实针对性措施。`,
  `虽然成本很高，但是效果不错。虽然门槛不低，但是值得投入。不仅效率提升了，而且质量也上去了。一方面要控制成本，另一方面要保证质量。无论刮风下雨，他都会准时到岗。只要价格合适，买家就会出现。与其说是天赋，不如说是努力。`,
  `效率的显著提升带来了新的问题。我们实现了重大突破，取得了显著成效。分享学习收获，加强城市治理，进行产业升级，予以高度评价。这具有十分重要的意义，发挥着不可替代的作用。`,
  `我们进行了优化，予以了反馈。效率提升了，成本降低了，质量提高了。持续推进着改革，深入分析着数据，不断优化着流程。价值最大化与利润最大化并重。`,
];

// 病句签名（命中即失败）
const badSignatures: [string, RegExp][] = [
  ["越来越增多", /越来来越|越来越增多/],
  ["急用", /急用/],
  ["但，", /但，/],
  ["具有挺", /具有挺/],
  ["叠逗号", /，，|、、/],
  ["句号后逗号", /。，/],
  ["逗号后句号", /，。/],
  // 名词位了：只抓"的+动词+了"与名词化宾语后补了，不抓自然输入里本来就通的"效率提高了。"
  ["名词位了", /的(?:提高|提升|优化|落实|完善|实现|解决|建立|取得|获得|突破|整合|加强|推进|改造|升级|修复|培育|化解|破解|攻克|达成)了[。！？!?]|(?:突破了|收获了|治理了)[。！？!?]/],
  ["裸难接动词", /(者|人|们)难(?!以)/],
  // 不抓 injectSelfQA 故意造的"意味着什么？"——那是自问自答注入，不是切句切出来的无主残句
  ["无主句切断", /[。！？]?(?:成为|使得|导致|意味着)(?!什么)[^。！？]{0,4}(?:了|着)?[。！？]/],
  // 形式动词槽位（humanize-guard 的 进行/予以/加以 守卫）回归线：结果补语不得进这个槽位
  ["进行+结果补语", /(?:进行|予以|加以)了?(?:调好|改好|做好|弄好|理顺)/],
  // 进行X→X残留：抓被错误删前缀后的"。了优化"式残渣（"进行了优化"本身合法，守卫应保护）
  ["进行X→X残留", /[。，；](?:了|予以了|加以了)[一-龥]{2,4}/],
  ["非常提高", /(?:非常|特别|极为|格外|十分|高度)(?:提高|提升|增强|加强|降低|减少|优化)(?!了)/],
  ["帮衬悬空", /(?:帮衬|助攻)[，。]/],
  ["守住民生", /守住(?:民生|安全)/],
  ["护着权益", /护着(?:权益|秩序)/],
  ["起着/起着", /起着(?:作用|功能)|显着/],
  ["拽着/拉着升级", /(?:拽着|拉着)(?:升级|转型|发展)/],
  ["做目标/建品牌", /(?:做到|达成)(?:目标|战略|愿景)|弄(?:品牌|形象)/],
  ["攒体系", /攒(?:体系|机制|生态)/],
  ["钉在", /钉在(?!.{0,4}上)/],
  ["真推进", /(?:真|实在|当真)(?:推进|落实|开展|实施)/],
  ["稳当推进", /稳当(?:推进|落实)/],
  ["专心推进", /专心(?:推进|落实)/],
  ["上心对接", /(?:上心|乐意)(?:对接|参与|配合)/],
  ["加信心", /加(?:信心|能力|实力)/],
  ["没停过增长", /没停过(?:增长|发展|推进)/],
  ["就问题", /(?:就|奔着|对着)(?:问题|难题|挑战)(?!的)/],
  ["借着大数据", /借着(?:大数据|技术|平台|资源)(?!的东风)/],
  ["陆陆续续调", /陆陆续续(?:调|改|优|推)/],
  ["那一摊", /那一摊(?!子)/],
  ["可持续被拆", /可(?:一直|接连|没停过)发展|持续(?:性)?(?:一直|接连|没停过)/],
  ["就性措施", /(?:就|奔着|对着)性(?:措施|方案)/],
  ["靠了考试", /靠了考试/],
  ["第二个天", /第二个天|头一个天/],
  ["头一个时间", /头一个时间/],
  ["最后说一句天", /最后说一句天|最后说一句(?:时间|阶段)/],
  ["多了一个的", /了(?:的)?提升(?:的)?了/],
  ["帮X表明残留", /(?:聊|说|谈)(?:数字|人工|技术|阅读)[^，。]{0,6}(?:表明|指出|显示|发现)/],
  ["垫词叠罗汉", /(?:说真的|要我说|老实讲|讲真|说实话|客观讲|平心而论|细想下|往实了说|不瞒你说|你别说|话又说回来|说白了|其实|按我的经验)，(?:说真的|要我说|有意思的是|老实讲|讲真|说实话)/],
  ["破折号堆叠", /—{3,}/],
  ["引号残留", /[“”]/],
];

describe("八维元压测闸门", () => {
  it(
    "A) 病句签名压测：套话语料 × 全强度 × 40 种子 零命中",
    () => {
      const fails: string[] = [];
      // 口径修正：签名对**输入原文**即命中的（如语料自带"，予以了反馈"），属继承而非引擎制造，
      // 不计入失败——否则该语料每次运行必失，真缺陷反而被恒定噪声盖住。
      const inherited = corpusA.map((d) => new Set(badSignatures.filter(([, re]) => re.test(d)).map(([n]) => n)));
      let runs = 0;
      for (const intensity of INTENSITIES) {
        for (let seed = 0; seed < SEEDS; seed++) {
          corpusA.forEach((doc, di) => {
            runs++;
            const out = humanize(doc, { intensity, seed });
            for (const [name, re] of badSignatures) {
              if (inherited[di].has(name)) continue;
              if (re.test(out)) fails.push(`${name} 强度${intensity} seed${seed}: ${out.match(re)?.[0]} → ${out.slice(0, 60)}`);
            }
          });
        }
      }
      summarize(fails, `A 病句签名（共 ${runs} 次运行）`);
    },
    180_000,
  );

  it("B) 搭配安全探针：量词/时间/百分比/URL/邮箱 不得被替身打散", () => {
    const probes: [string, string][] = [
      ["第二天早上他就走了。", "第二天"],
      ["第一时间我们做了响应。", "第一时间"],
      ["最后一天最忙。", "最后一天"],
      ["第一轮测试通过。", "第一轮"],
      ["三个方面：第一是成本，第二是效率。", "第一是成本"],
      ["推动可持续发展。", "可持续发展"],
      ["保持持续性增长。", "持续性"],
      ["提出针对性措施。", "针对性"],
      ["通过了资格考试。", "通过了"],
      ["价值最大化。", "价值最大化"],
      ["实现利润最大化。", "最大化"],
      ["第二轮调整后进入第三阶段。", "第二轮"],
      ["下午三点整。", "三点"],
      ["占40%份额。", "40%"],
      ["营收增长23%。", "23%"],
      ["详见 https://example.com/page?id=1 页面，时间是 12:30。", "https"],
      ["联系 test@mail.com 咨询。", "@"],
    ];
    const fails: string[] = [];
    for (const [input, keep] of probes) {
      for (const intensity of [0.2, 0.6, 1.0]) {
        for (let seed = 0; seed < 10; seed++) {
          both(input, { intensity, seed }).forEach((out, fnIdx) => {
            if (!out.includes(keep)) fails.push(`${fnIdx ? "shuffle" : "humanize"} 丢失[${keep}] 强度${intensity} seed${seed}: ${out}`);
          });
        }
      }
    }
    summarize(fails, "B 搭配安全");
  });

  it("C) 标点残渣：不得造出 ，。 。， ，， 等接缝", () => {
    const punctCorpus = [
      "然而，情况并非如此。因此，我们需要调整。此外，还有一点。与此同时，成本在上升。",
      "综上所述，方案可行。总而言之，值得一试。",
      "值得注意的是，效果显著。显而易见，方向正确。",
      "这说明问题存在。由此可以看出，方向是对的。可以看出现状不容乐观。",
    ];
    const fails: string[] = [];
    for (const doc of punctCorpus) {
      for (const intensity of INTENSITIES) {
        for (let seed = 0; seed < 20; seed++) {
          both(doc, { intensity, seed }).forEach((out, fnIdx) => {
            if (/，。|。，|，，|、，|，、|。;|;。/.test(out)) fails.push(`${fnIdx ? "shuffle" : "humanize"} 强度${intensity} seed${seed}: ${out.slice(0, 60)}`);
          });
        }
      }
    }
    summarize(fails, "C 标点残渣");
  });

  it("D) 反指纹限额：垫词复读/破折号/省略号/半角逗号比例", () => {
    const llmStyle = `说真的，现在数字阅读确实方便。检索、标注、分享都很快——效率高得不是一星半点——但是质量未必跟上。说真的，我经常刷完就忘。讲真，注意力也容易散。讲真，这挺麻烦的。碎片化信息看多了，脑子木。另外，纸质书的沉浸感还在。另外，油墨味和书签是独一份的体验……总之各有各的好……所以说，看场景选就行。所以说，灵活一点没坏处。`;
    const fails: string[] = [];
    for (let seed = 0; seed < 30; seed++) {
      const out = mechanicalShuffle(llmStyle, { intensity: 0.3, seed });
      for (const w of ["说真的", "讲真", "所以说", "另外"]) {
        const c = out.split(w + "，").length - 1;
        if (c > 1) fails.push(`垫词复读[${w}] seed${seed}`);
      }
      if (out.split("——").length - 1 > 1) fails.push(`破折号超标 seed${seed}`);
      if (out.split("……").length - 1 > 1) fails.push(`省略号超标 seed${seed}`);
      const full = (out.match(/，/g) || []).length;
      const half = (out.match(/,/g) || []).length;
      if (full + half > 0 && half / (full + half) > 0.15) fails.push(`半角混入过高 seed${seed} ${half}/${full + half}`);
    }
    summarize(fails, "D 反指纹限额");
  });

  it("E) 忠实度硬约束：数字与英文专名不得增删改", () => {
    const fidText = "公司2025年营收增长23%，海外占40%。新产品明年3月发布，支持GPT和Claude模型，准确率92.5%。";
    const fails: string[] = [];
    for (const intensity of INTENSITIES) {
      for (let seed = 0; seed < 20; seed++) {
        both(fidText, { intensity, seed }).forEach((out, fnIdx) => {
          const rep = checkFidelityLocal(fidText, out);
          if (!rep.pass) fails.push(`${fnIdx ? "shuffle" : "humanize"} 强度${intensity} seed${seed}: ${rep.problems[0]} → ${out.slice(0, 60)}`);
        });
      }
    }
    summarize(fails, "E 忠实度");
  });

  it("F) 段落结构：\\n\\n 段落边界必须保留", () => {
    const paraText =
      "第一段第一句，说点事情。这里多说两句凑够长度，避免被短段合并规则吃掉。再多一句保险。\n\n第二段第一句，再说点别的。这里也要凑点长度，同样避免合并。再多一句保险。\n\n第三段比较短。";
    const fails: string[] = [];
    for (const intensity of INTENSITIES) {
      for (let seed = 0; seed < 10; seed++) {
        if (!humanize(paraText, { intensity, seed }).includes("\n\n")) fails.push(`段落丢失 强度${intensity} seed${seed}`);
      }
    }
    summarize(fails, "F 段落结构");
  });

  it("G) aiScore 合理性：人写 < 干净 < 套话，且 AI 文本高分", () => {
    const humanLike = "我昨天试了下那个新软件，界面还行，就是启动有点慢。用了一下午，感觉比之前那个顺手。朋友说下个月要出更新版，到时候再看吧。反正现在够用了。";
    const aiLike = "值得注意的是，随着技术的不断发展，其在各领域的应用日益广泛。毋庸置疑，这一趋势具有深远的意义。综上所述，我们需要持续努力，实现更大的突破。";
    const clean = "今天天气不错，出门走了走。路上买了个煎饼，挺好吃。下午在家看了会书，晚上打算早点睡。";
    const g1 = aiScore(humanLike).score;
    const g2 = aiScore(aiLike).score;
    const gc = aiScore(clean).score;
    const fails: string[] = [];
    if (!(g2 > g1)) fails.push(`评分倒挂：人写 ${g1} >= AI ${g2}`);
    // 29 是本引擎现行的"机器/真人"分界（见 scripts/_calib_margin.ts、_pad_legit.ts）。
    // 旧断言用的 >=50 属 v0.5.x 刻度；v0.8+ 标定过 aiScore，表层方法天然低估是已知设计
    // （样本 D 原文本地 60.22 vs 官方 99.99），拿旧绝对值卡现在必然假红。
    if (g2 < 29) fails.push(`AI 文本未达机器分界 ${g2} < 29`);
    if (g1 > 40) fails.push(`人写文本评分过高 ${g1}`);
    if (gc >= g2) fails.push(`干净文本 ${gc} >= 套话文本 ${g2}`);
    summarize(fails, `G aiScore 单调性（人写${g1} / 干净${gc} / 套话${g2}）`);
  });

  it("H) fingerprintCheck：脏文本必须逐项报红且不通过", () => {
    const dirtyH = `值得注意的是，随着 AI 技术的发展，模型规模已达 1750 亿。说真的，这很厉害。说真的，很快。首先，成本很高。其次，效果一般。最后，值得商榷。不仅效率提升了，而且质量也上去了。随着监管的加强，行业正在洗牌。——但是——综上所述，效果不错。综上所述，值得投入。`;
    const rep = fingerprintCheck(dirtyH);
    const names = rep.issues.map((i) => i.name);
    const expect_ = ["中英数字间空格", "垫词复读", "破折号超标", "段首过渡词残留", "AI 套话残留"];
    const fails = expect_.filter((e) => !names.some((n) => n.includes(e)));
    if (rep.pass) fails.push("脏文本被判为通过");
    summarize(fails, `H 指纹漏报（实际报出：${names.join("、") || "无"}）`);
  });

  // I) 谓语丢失探针：MECH_CLICHES 里的谓语类条目（应运而生/展望未来/按下了快进键…）
  // 常是所在小句的唯一谓语，盲删会留下"AI 写作工具。"式光杆主语，再被垫词补成
  // "人工智能技术吧。"的废句。判据已收在 humanize-shuffle.ts 的 stripAICliches：
  // 只删小句起始位。谓语位改由 VOCAB 替身或保留原文承接——宁可留扣分项，不出废句。
  it("I) 谓语丢失零命中", () => {
    const PREDICATE_LOSS_RE = /[一-龥]{2,6}工具。/;
    const probes = [
      "AI 写作工具应运而生。",
      "值得注意的是，在当今社会，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，人工智能技术至关重要，它不仅极大地提升了内容生产的效率，而且有效地降低了创作门槛。然而，传统的写作方式仍然发挥着不可替代的作用。因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的输出。",
    ];
    const fails: string[] = [];
    for (const doc of probes) {
      for (const intensity of INTENSITIES) {
        for (let seed = 0; seed < SEEDS; seed++) {
          const out = humanize(doc, { intensity, seed });
          if (PREDICATE_LOSS_RE.test(out)) fails.push(`强度${intensity} seed${seed}: ${out.match(PREDICATE_LOSS_RE)![0]} → ${out.slice(0, 50)}`);
        }
      }
    }
    summarize(fails, "I 谓语丢失");
  });

  // J) 谓语类套话在谓语位不得被删成光杆主语（stripAICliches 边界判据的直接回归）
  it("J) 谓语位套话保留：塌句零命中", () => {
    const SUBJ = "人工智能技术";
    const predicateCliches = ["应运而生", "至关重要", "具有十分重要的意义", "按下了快进键", "迈上了新的台阶", "交出了一份满意的答卷", "具有里程碑意义", "展望未来", "在一定程度上", "综上所述", "在当今社会", "发挥着不可替代的作用"];
    const fails: string[] = [];
    for (const p of predicateCliches) {
      let collapsed = 0;
      for (const intensity of INTENSITIES) {
        for (let seed = 0; seed < SEEDS; seed++) {
          const out = humanize(`${SUBJ}${p}。`, { intensity, seed });
          // 塌句判据：原短语没了，且主语后直接接句末标点/空
          if (!out.includes(p) && new RegExp(`${SUBJ}[。，、\\s]?$`).test(out.trim())) collapsed++;
        }
      }
      if (collapsed) fails.push(`${p} 塌 ${collapsed}/${INTENSITIES.length * SEEDS} 次`);
    }
    summarize(fails, "J 谓语位套话保留");
  });
});
