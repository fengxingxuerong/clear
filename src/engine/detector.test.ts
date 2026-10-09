import { describe, it, expect } from "vitest";
import { detectAI, detectLevel, keepOnlyIfDetectDrops } from "./detector";

/** 典型 AI 议论文（套话 + 骨架词 + 均匀句长） */
const AI_TEXT = `随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。值得注意的是，数字化阅读不仅改变了人们获取知识的方式，还显著提升了阅读的便捷性。然而，数字化阅读也面临着一系列挑战，诸如注意力分散、深度思考能力下降等问题。因此，我们需要在享受技术便利的同时，保持对阅读质量的关注。
首先，数字化阅读让知识的获取变得更加高效。读者可以随时随地通过移动设备访问海量资源，检索与标注也变得前所未有的便捷。其次，数字化阅读有助于降低阅读门槛，让更多人能够接触到优质的内容。此外，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。
与此同时，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。综上所述，建立完善的数字化阅读体系，推动全民阅读高质量发展，具有重要的现实意义。`;

/** 口语真人稿（第一人称 + 具体细节 + 短句） */
const HUMAN_TEXT = `我家楼下那家早餐店开了快十年了。老板娘记得我不吃香菜，每次都是提前给我挑出来。有次我出差一个月没去，回来她问我："上哪儿发财去了？"我说出差，她笑："还以为你搬走了。"那天豆浆给我多加了半勺糖，说是欢迎回来。这种小事，比什么会员卡都管用。`;

describe("keepOnlyIfDetectDrops（v0.9.28 注入效果回滚判据）", () => {
  // 三档固定分数由实测取定（artifacts/_probe-rollback-fixtures.ts）：57 / 66 / 11
  const before = `值得注意的是，随着技术的快速发展，相关问题应运而生。综上所述，该方案不仅极大地提升了效率，而且有效地降低了成本。`;
  const worse = before + `此外，值得注意的是，综上所述，这一举措具有十分重要的意义。`;
  const better = `这事我干过。说白了就是把流程改一下，效率上来了，成本也降了。不过刚开始那阵子确实乱。`;

  it("注入/改写后 detectAI 下降 → 保留新文本", () => {
    expect(detectAI(better).probability).toBeLessThan(detectAI(before).probability);
    expect(keepOnlyIfDetectDrops(before, better)).toBe(better);
  });

  it("改写后 detectAI 不降反升 → 撤回，返回注入前文本", () => {
    expect(detectAI(worse).probability).toBeGreaterThan(detectAI(before).probability);
    expect(keepOnlyIfDetectDrops(before, worse)).toBe(before);
  });

  it("前后相同直接短路（不白跑两次 detectAI）", () => {
    expect(keepOnlyIfDetectDrops(before, before)).toBe(before);
  });
});

describe("detectAI（本地 14 特征检测）", () => {
  it("AI 议论文落 high 档", () => {
    const r = detectAI(AI_TEXT);
    expect(r.level).toBe("high");
    expect(r.probability).toBeGreaterThanOrEqual(48);
    expect(r.levelText).toBe("AI生成");
    expect(r.features.length).toBeGreaterThanOrEqual(14);
    expect(r.confidence).toBeGreaterThanOrEqual(45);
  });

  it("口语真人稿落 human 档", () => {
    const r = detectAI(HUMAN_TEXT);
    expect(r.level).toBe("human");
    expect(r.probability).toBeLessThan(32);
  });

  it("低于 350 字给警告，句子太少提示节奏不可靠", () => {
    const r = detectAI("很短。就这样。");
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(detectLevel("很短。就这样。")).toBe("human");
  });

  it("topSegments 风险句按分数降序", () => {
    const r = detectAI(AI_TEXT);
    const risks = r.topSegments.map((s) => s.risk);
    const sorted = [...risks].sort((a, b) => b - a);
    expect(risks).toEqual(sorted);
  });

  // ── 分批补覆盖 · 第 1 批：text reporter 指出的 385-386 / 393-394 / 401-402 ──
  // 这三处都是 segmentRisk 里「加分 if」的真分支从未进入过（此前所有样本都落 false）。

  it("段内风险：「是…的。」判断句式收尾且 >22 字 → +12（源码 384-386 真分支）", () => {
    const sent = "经过反复讨论之后，大家一致认为这个方案是非常可行的。";
    // 26 字符 > 22，且以「是非常可行的。」收尾，命中 /(是.*?的。?$)/
    const r = detectAI(sent);
    const seg = r.topSegments.find((s) => s.text === sent);
    expect(seg).toBeDefined();
    // 20（基准）+ 12（判断句式收尾）；该句不含套话/骨架/连接词开头，也不 ≤10 字、无问号
    expect(seg!.reason).toBe("判断句式收尾");
    expect(seg!.risk).toBe(32);
  });

  it("段内风险：汉字+空格+英数的「中英间空格」→ +14（源码 392-394 真分支）", () => {
    const sent = "这个 API 封装得很顺手。";
    // 「个 API」满足 [一-龥][ \t]+[A-Za-z0-9]，且句长 12 不触发超长句/抽象名词
    const r = detectAI(sent);
    const seg = r.topSegments.find((s) => s.text === sent);
    expect(seg).toBeDefined();
    expect(seg!.reason).toBe("中英间空格");
    // 实跑修正：20（基准）+ 14（中英间空格）− 12（有具体细节：CONCRETE 判据命中英文缩写 API）
    expect(seg!.risk).toBe(22);
  });

  it("段内风险：「四字格、四字格、四字格」排比 → +12（源码 400-402 真分支）", () => {
    const sent = "会上提出统筹规划、协同推进、精准发力的要求。";
    // 「统筹规划、协同推进、精准发力」满足 {4}(?:、{4}){2,}
    const r = detectAI(sent);
    const seg = r.topSegments.find((s) => s.text === sent);
    expect(seg).toBeDefined();
    expect(seg!.reason).toBe("四字排比");
    expect(seg!.risk).toBe(32); // 20 + 12
  });

  // ── 分批补覆盖 · 第 2 批：空输入守卫 / medium 档 / ≥350 字 else 臂 ──

  it("空输入守卫：纯空串与全空白都退化为 28 分 human（覆盖 162/222/242/336/337/441/488 行的空臂）", () => {
    for (const empty of ["", "   \n\n  "]) {
      const r = detectAI(empty);
      // 空文本下 3 个反向维度（句长平/TTR低/缺人称/缺细节/标点少）拉满，加权 4.8/17.1 → 28 分
      expect(r.probability).toBe(28);
      expect(r.level).toBe("human");
      expect(r.levelText).toBe("人工特征");
      expect(r.confidence).toBe(56); // dist=|28-32|=4 → 50+5.6 → 56
      expect(r.warnings).toEqual([
        "字数 0，低于朱雀的 350 字门槛；短文本特征不稳，判定仅供参考",
        "句子太少，节奏类特征不可靠",
      ]);
      expect(r.stats).toEqual({ chars: 0, sentences: 0, paragraphs: 0, ttr: 0, sentenceCV: 0 });
      expect(r.topSegments).toEqual([]);
      expect(r.features).toHaveLength(16);
      // 单段落守卫：空文本 paragraphs=0 <2 → 段落特征不参与判定
      const para = r.features.find((f) => f.name === "段落长度均匀")!;
      expect(para.value).toBe(0);
      expect(para.hint).toBe("单段，不参与判定");
    }
    expect(detectLevel("")).toBe("human");
  });

  it("三档判定中档：公文灰区 47 分 → medium / 疑似AI辅助（覆盖 462-463 中间臂）", () => {
    const text = "加强顶层设计，用好抓手，赋能基层，筑牢护城河。";
    const r = detectAI(text);
    expect(r.probability).toBe(47);
    expect(r.level).toBe("medium");
    expect(r.levelText).toBe("疑似AI辅助");
    expect(r.confidence).toBe(51); // dist=min(|47-32|,|47-48|)=1 → 50+1.4 → 51
    // 公文维度钉真值：5 处命中 / 23 字 → 每百字 21.74，norm(·,0,2.0) 截断到 1
    const official = r.features.find((f) => f.name === "公文/黑话套话密度")!;
    expect(official.value).toBe(1);
    expect(official.hint).toBe("每百字 21.74 处（顶层设计/赋能/抓手/护城河 等）");
    expect(detectLevel(text)).toBe("medium");
  });

  it("≥350 字：字数门槛警告的 else 臂（源码 446-448）→ warnings 为空", () => {
    const longText =
      "上周六早上我带女儿去公园散步，路上碰见老邻居张大爷正在遛狗。他养的那条金毛特别亲人，围着我们转了两圈，女儿蹲下来摸了半天不肯走。" +
      "张大爷笑着说这条狗还记得我们家，以前住同一栋楼的时候天天在电梯里碰见，那时候你家姑娘才到我膝盖高。" +
      "我们沿着湖边走了一个多小时，中途在长椅上休息，女儿买了一支冰淇淋，边吃边看别人钓鱼，还问我为什么钓上来的鱼要立刻放回去。" +
      "临走的时候张大爷塞给我两个橘子，说是自己家里种的，让我带给女儿尝尝。" +
      "路上还遇到一位老同学，他孩子也在同一个小学，我们站在门口聊了十来分钟，聊到学区房和补习班的价格，大家都感慨现在养孩子不容易。" +
      "张大爷说他年轻时在这里住了三十年，湖边的柳树还是他刚搬来那年种下的，如今已经长得比两层楼还高，春天飘絮的时候满地都是。" +
      "回家以后她说下次还要来，我答应她每个周末都带她去玩，只要不下雨就一定去，她这才心满意足地去写作业了。";
    const r = detectAI(longText);
    expect(r.stats.chars).toBe(378); // ≥350 → 走 if 的 else 臂
    expect(r.stats.sentences).toBe(8); // ≥4 → 两条警告都不触发
    expect(r.warnings).toEqual([]);
    expect(r.probability).toBe(17);
    expect(r.level).toBe("human");
    expect(r.confidence).toBe(71);
  });

  // ── 分批补覆盖 · 第 3 批：维度分两极与标定边界钉死 ──

  it("维度分·句长节奏：CV 0.945 → value 0（过平的反向）；三句等长 CV 0 → value 1", () => {
    const uneven =
      "短。这一句话特别长，我故意把它写得非常啰嗦，用来把句长的标准差拉上去，让整段话的句长变异系数超过零点六的阈值，从而触发节奏不平的反向判定逻辑分支。";
    const r1 = detectAI(uneven);
    expect(r1.stats.sentenceCV).toBe(0.945); // 0.62 上限外 → norm 截断后 invert → 0
    const rhythm1 = r1.features.find((f) => f.name === "句长节奏过平")!;
    expect(rhythm1.value).toBe(0);
    expect(rhythm1.hint).toBe("句长 CV 0.95（真人随笔常 0.35~0.7）");

    const uniform =
      "这是一个长度完全一样的句子啊。这是一个长度完全一样的句子啊。这是一个长度完全一样的句子啊。";
    const r2 = detectAI(uniform);
    expect(r2.stats.sentenceCV).toBe(0); // 完全同长 → 0.28 下限外 → invert → 1
    const rhythm2 = r2.features.find((f) => f.name === "句长节奏过平")!;
    expect(rhythm2.value).toBe(1);
    expect(rhythm2.hint).toBe("句长 CV 0.00（真人随笔常 0.35~0.7）");
  });

  it("维度分·标点多样性：8 种标点 → value 0；只有句号 → value 1", () => {
    const rich = "什么？真的吗！太好了……等等——先别急：听我说，就这样、明白。";
    const rRich = detectAI(rich);
    const pRich = rRich.features.find((f) => f.name === "标点过于规整")!;
    expect(pRich.value).toBe(0); // variety=8 ≥7 → norm 截断 1 → invert → 0
    expect(pRich.hint).toBe("用到 8 种标点（真人常混用问号/破折号/省略号）");
    expect(rRich.probability).toBe(8);

    const plain = "今天天气很好。我们去公园散步。看到很多人在跑步。大家都很开心。";
    const rPlain = detectAI(plain);
    const pPlain = rPlain.features.find((f) => f.name === "标点过于规整")!;
    expect(pPlain.value).toBe(1); // variety=1 <2 → r=0 → invert → 1
    expect(pPlain.hint).toBe("用到 1 种标点（真人常混用问号/破折号/省略号）");
    expect(rPlain.probability).toBe(16);
  });

  it("标定分界钉死：AI 样本 63 分 high / 真人样本 9 分 human，维度 hint 可复核", () => {
    const ai = detectAI(AI_TEXT);
    expect(ai.probability).toBe(63);
    expect(ai.level).toBe("high");
    expect(ai.levelText).toBe("AI生成");
    expect(ai.confidence).toBe(71); // dist=|63-48|=15 → 50+21 → 71
    expect(ai.topSegments).toHaveLength(8); // 10 句只取风险最高的 8 句
    expect(ai.features.find((f) => f.name === "段落长度均匀")!.hint).toBe("段长 CV 0.24");
    expect(ai.features.find((f) => f.name === "用词重复（TTR 偏低）")!.hint).toBe(
      "bigram TTR 84.8%",
    );

    const human = detectAI(HUMAN_TEXT);
    expect(human.probability).toBe(9);
    expect(human.level).toBe("human");
    expect(human.levelText).toBe("人工特征");
    expect(human.confidence).toBe(82); // dist=|9-32|=23 → 50+32.2 → 82
    expect(human.topSegments).toHaveLength(6); // 6 句不触发 slice(0,8) 截断
    expect(human.features.find((f) => f.name === "段落长度均匀")!.hint).toBe("单段，不参与判定");
    expect(human.features.find((f) => f.name === "用词重复（TTR 偏低）")!.hint).toBe(
      "bigram TTR 97.0%",
    );
  });

  // ── 结构性不可达分支（不为凑数改源码，记录成因）──
  // · 135 行 `hi - lo || 1`：norm 的全部调用点 hi≠lo（0.82/0.98、0.28/0.62、0.15/0.7…），右操作数恒不求值；
  // · 142 行 cv 的 `m === 0`：nums.length<2 已提前 return 0，而 lens/pLens 每项 ≥1（splitSentences 滤掉空句、
  //   splitParagraphs 滤掉空段），length≥2 时均值必 >0；
  // · 175 行 per 的 `chars > 0` false 臂：chars = Math.max(1, r.chars) ≥ 1 恒真（空文本被抬到 1）；
  // · 456 行 `wSum || 1`：16 条特征权重全为正（和 ≈17.1），左操作数恒真，`|| 1` 兜底永不触发。
});
