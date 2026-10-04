import {
  humanize,
  mechanicalShuffle,
  fingerprintCheck,
  checkFidelityLocal,
  collapseIssues,
} from "../src/engine/humanize.ts";
import { humanizeBestOf } from "../src/engine/humanize-bestof.ts";
import { reportAll, type Violation } from "./violation-report.ts";
declare const process: { exit(code?: number): never; env: Record<string, string | undefined> };

// ============================================================
// scan-bugs · 病句签名回归扫描
//
// 分级（SCAN_TIER env）：
//   fast   → 每组 5 种子（CI 主路径，秒级）
//   full   → 每组 30 种子（默认，PR 全量）
//   audit  → 每组 50 种子（weekly / nightly 深扫）
// 输出（SCAN_VERBOSE env）：
//   默认  → 只打「分组×签名×强度分布」摘要表 + artifact 落盘
//   =1    → 追加逐条 ❌ 明细（调试用）
// artifact：每个签名的首个失败样本写到 artifacts/scan-bugs/*.txt，
//           含 input/output/pattern，人肉复现不用重跑 30 种子。
// ============================================================

const SEED_COUNT = (() => {
  const tier = process.env.SCAN_TIER ?? "full";
  if (tier === "fast") return 5;
  if (tier === "audit") return 50;
  return 30;
})();
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => i);
// 20 种子组 / 10 种子组：从 SEEDS 里截取，保持比例（fast=5 / full=20,10 / audit=20,10 封顶）
const SEEDS_20 = SEEDS.slice(0, Math.min(20, SEEDS.length));
const SEEDS_10 = SEEDS.slice(0, Math.min(10, SEEDS.length));
const VERBOSE = process.env.SCAN_VERBOSE === "1";
/** v0.9.10：更新「句长节奏过平」基线（收紧用；跑完打印建议值）。
 *  用环境变量而非 argv——本文件顶部注册了精简 process shim（仅 exit/env）。 */
const UPDATE_RHYTHM_BASELINE = process.env.SCAN_UPDATE_RHYTHM === "1";
const logDetail = (s: string) => {
  if (VERBOSE) console.log(s);
};
console.log(
  `[scan-bugs] tier=${process.env.SCAN_TIER ?? "full"} → 种子 0~${SEED_COUNT - 1}${VERBOSE ? "（verbose）" : ""}`,
);

// 违规聚合表：每个 ❌ 都记一份，末尾 reportAll() 出摘要 + 落盘 artifact
const violations: Violation[] = [];
function pushV(
  group: string,
  signature: string,
  intensity: number | null,
  seed: number | null,
  opts: { pattern?: string; snippet?: string; input?: string } = {},
): void {
  violations.push({ group, signature, intensity, seed, ...opts });
}

// ============================================================
// v0.2 病句签名：修复目标模式在多种子/多强度下不得出现
// ============================================================
const sample = `随着数字技术的不断发展，人们的阅读方式正在发生深刻变化。传统的纸质阅读逐渐让位于数字阅读，电子书、听书、碎片化阅读成为许多人的日常选择。这一转变不仅改变了人们获取信息的渠道，也深刻影响着人们的思维习惯与生活方式。

值得注意的是，数字阅读的普及带来了效率的显著提升。读者可以随时随地通过移动设备访问海量资源，检索、标注与分享变得前所未有的便捷。然而，效率的提升并不等同于阅读质量的提高。碎片化的信息获取方式，往往使读者难以进行深度思考，注意力也更容易被分散。

与此同时，纸质阅读所具有的沉浸感与仪式感，依然是数字阅读难以替代的。翻动书页的触感、墨香与书签，构成了独特的阅读体验。更重要的是，线性阅读所培养的专注力与耐心，对于系统性知识建构具有不可忽视的价值。

综上所述，数字阅读与纸质阅读并非对立关系，而是互为补充的两种方式。读者应当根据自身的阅读目标与场景，灵活选择合适的阅读媒介。唯有如此，才能在信息时代真正实现阅读的价值最大化。`;
const badPatterns: [string, RegExp][] = [
  ["越来越增多", /越来来越|越来越增多/],
  ["急用思考", /急用/],
  ["裸难接动词", /(者|人|们)难(?!以)/],
  ["但，", /但，/],
  ["具有挺", /具有挺/],
  ["了最大化", /[拔提提]高了?[^。]*最大化|效率[^。]{0,6}了。/],
  ["名词+了结尾", /(提高|拔高|提升|优化)了。/],
  [
    "双垫词",
    /(说真的|要我说|老实讲|讲真|说实话|客观讲|平心而论|细想下|往实了说|不瞒你说|你别说|话又说回来|说白了|其实|按我的经验)，(说真的|要我说|有意思的是|老实讲|讲真|说实话)/,
  ],
  ["无主句", /。(?:成为|使得|意味着)[^。]/],
  ["落到实处", /落到实处/],
];
let fails = 0;
for (const it of [0.4, 0.6, 0.8, 1.0]) {
  for (const seed of SEEDS) {
    const out = humanize(sample, { intensity: it, seed });
    for (const [name, re] of badPatterns) {
      if (re.test(out)) {
        logDetail(`❌ 强度${it} seed${seed} 命中[${name}]`);
        fails++;
        pushV("v0.2", name, it, seed, {
          pattern: re.source,
          snippet: out.slice(0, 200),
          input: sample.slice(0, 200),
        });
      }
    }
  }
}
console.log(fails === 0 ? "✅ 120 次运行零病句签名命中" : `共 ${fails} 次命中`);

// ============================================================
// v0.3.3 反指纹层回归：机械扰动后的输出必须满足限额/去重约束
// ============================================================
const llmStyle = `说真的，现在数字阅读确实方便。检索、标注、分享都很快——效率高得不是一星半点——但是质量未必跟上。说真的，我经常刷完就忘。讲真，注意力也容易散。讲真，这挺麻烦的。碎片化信息看多了，脑子木。另外，纸质书的沉浸感还在。另外，油墨味和书签是独一份的体验……总之各有各的好……所以说，看场景选就行。所以说，灵活一点没坏处。`;
let dfFails = 0;
for (const seed of SEEDS_20) {
  const out = mechanicalShuffle(llmStyle, { intensity: 0.3, seed });
  for (const w of ["说真的", "讲真", "所以说", "另外"]) {
    const c = out.split(w + "，").length - 1;
    if (c > 1) {
      logDetail(`❌ 反指纹 seed${seed} 垫词[${w}]出现${c}次`);
      dfFails++;
      pushV("anti-fp", `垫词[${w}]复读`, 0.3, seed, {
        snippet: out.slice(0, 200),
        input: llmStyle.slice(0, 200),
      });
    }
  }
  if (out.split("——").length - 1 > 1) {
    logDetail(`❌ 反指纹 seed${seed} 破折号超标`);
    dfFails++;
    pushV("anti-fp", "破折号超标", 0.3, seed, { snippet: out.slice(0, 200), input: llmStyle.slice(0, 200) });
  }
  if (out.split("……").length - 1 > 1) {
    logDetail(`❌ 反指纹 seed${seed} 省略号超标`);
    dfFails++;
    pushV("anti-fp", "省略号超标", 0.3, seed, { snippet: out.slice(0, 200), input: llmStyle.slice(0, 200) });
  }
}
console.log(
  dfFails === 0 ? "✅ 反指纹层 20 种子全部满足限额/去重约束" : `反指纹层共 ${dfFails} 次违规`,
);

// ============================================================
// v0.4.0 竞品移植规则回归：空格指纹/让步句重构/半角限频
// ============================================================
const spacey = `随着 AI 技术的发展，模型参数已达到 1750 亿规模。实测显示准确率为 92.5 %，比 GPT-3 高出 10 个点。这种 AI 写作工具应运而生。虽然成本很高，但是效果不错。虽然门槛不低，但是值得投入。`;
let v4 = 0;
for (const seed of SEEDS_20) {
  // v0.8.9：空格剥离已改为「尊重原文排版」（默认不再无条件删），
  // 本探针校验的正是旧剥离能力，故显式开启，保证该能力仍被回归覆盖。
  const out = mechanicalShuffle(spacey, { intensity: 0.3, seed, stripCJKSpaces: true });
  if (
    /[\u4e00-\u9fa5，。；：、][ \t]+[A-Za-z0-9]/.test(out) ||
    /[A-Za-z0-9%）)\]][ \t]+[\u4e00-\u9fa5]/.test(out)
  ) {
    logDetail(`❌ v4 seed${seed} 空格指纹残留`);
    v4++;
    pushV("v4", "空格指纹", 0.3, seed, { snippet: out.slice(0, 200), input: spacey.slice(0, 200) });
  }
  const full = (out.match(/，/g) || []).length;
  const half = (out.match(/,/g) || []).length;
  if (full + half > 0 && half / (full + half) > 0.15) {
    logDetail(`❌ v4 seed${seed} 半角混入过高 ${half}/${full + half}`);
    v4++;
    pushV("v4", "半角混入过高", 0.3, seed, {
      snippet: `${half}/${full + half} | ${out.slice(0, 200)}`,
      input: spacey.slice(0, 200),
    });
  }
}
const reframed = mechanicalShuffle("虽然成本很高，但是效果不错。虽然门槛不低，但是值得投入。", {
  intensity: 1,
  seed: 3,
});
if (/虽然[^，。]{2,16}[，,]?但是/.test(reframed)) {
  console.log("❌ v4 让步句未重构: " + reframed);
  v4++;
  pushV("v4", "让步句未重构", 1, 3, {
    snippet: reframed.slice(0, 200),
    input: "虽然成本很高，但是效果不错。虽然门槛不低，但是值得投入。",
  });
}
console.log(v4 === 0 ? "✅ v0.4.0 竞品移植规则 20 种子全部通过" : `v0.4.0 规则共 ${v4} 次违规`);
console.log("\n让步句重构示例: " + reframed);

// ============================================================
// v0.4.1 指纹体检自检：坏文本必须报警、机械层清洗后干净文本必须通过
// ============================================================
const dirty = `值得注意的是，随着 AI 技术的发展，模型规模已达 1750 亿。说真的，这很厉害。说真的，很快。——但是——然而，成本很高。综上所述，效果不错。综上所述，值得投入。句长均匀节奏平稳的一组句子。信息密度接近长度相当的另一组句子。检测器看的正是这种规律性特征。综上所述不错。……真的……`;
const dirtyReport = fingerprintCheck(dirty);
const dirtyNames = dirtyReport.issues.map((i) => i.name);
const mustCatch = ["中英数字间空格", "垫词复读「说真的」", "破折号超标", "段首过渡词残留", "AI 套话残留"];
let fp = 0;
for (const name of mustCatch) {
  if (!dirtyNames.includes(name)) {
    console.log(`❌ 指纹体检漏报: ${name}`);
    fp++;
    pushV("fp-check", `漏报-${name}`, null, null, { input: dirty.slice(0, 200) });
  }
}
if (dirtyReport.pass) {
  console.log("❌ 指纹体检对脏文本判定为通过");
  fp++;
  pushV("fp-check", "脏文本误判通过", null, null, { input: dirty.slice(0, 200) });
}
for (const seed of SEEDS_10) {
  const cleaned = mechanicalShuffle(dirty, { intensity: 0.6, seed, stripCJKSpaces: true });
  const rep = fingerprintCheck(cleaned);
  if (!rep.pass && rep.issues.some((i) => mustCatch.includes(i.name))) {
    console.log(`❌ 清洗后仍残留（seed${seed}）: ${rep.issues.map((i) => i.name).join("、")}`);
    fp++;
    pushV("fp-check", `清洗后残留-${rep.issues.map((i) => i.name).join("/")}`, 0.6, seed, {
      snippet: cleaned.slice(0, 200),
      input: dirty.slice(0, 200),
    });
  }
}
console.log(
  fp === 0 ? "✅ 指纹体检自检通过（漏报 0 / 清洗后干净 10 种子）" : `指纹体检共 ${fp} 次问题`,
);

// ============================================================
// v0.4.3 子代理审计修复签名：任何强度/种子下都不得再出病句/乱码/丢段落
// ============================================================
let v43 = 0,
  zq = 0,
  f44 = 0;
{
  const probes: [string, string, RegExp][] = [
    ["进行了X→了X", "我们对流程进行了优化。团队对数据开展了分析，并予以了反馈。", /(流程了|数据了|并了|予以了$)/],
    ["第二天被切量词", "第二天早上他就走了。第一时间我们做了响应。最后一天最忙。", /(第二个天|头一个天|头一个时间|最后说一句天|头一个步|头一个段)/],
    ["可持续内嵌", "推动可持续发展，保持持续性增长。提出针对性措施，有针对性地落实。通过了资格考试。", /(可(一直|接连|没停过)发展|持续性?(一直|接连|没停过)|就性措施|奔着性措施|靠了考试)/],
    ["URL/时间乱码", "详见 https://example.com/page?id=1 页面，时间是 12:30，联系 test@mail.com 咨询。。测试……真的……继续——再——结束。", /(https[：，]|12[：，]30)/],
    ["疑问句挂尾巴", "这个方案到底可行吗？他会不会来呢？", /(吗[嘛吧呢呀哈]，|吗，你细品|呢嘛。)/],
    ["双了/名词位了", "实现了重大突破。分享学习收获。加强城市治理。效率的提升。", /(突破了。|收获了。|治理了。|提升了。)/],
    ["无论/只要模板病句", "无论刮风下雨，他都会准时到岗。只要价格合适，买家就会出现。与其说是天赋，不如说是努力。", /(照样。|都照办|就能买家|自然会买家|宁可说是)/],
    ["级联二次替换", "把人才引进作为抓手。随着改革深入，政策落地。大力实施新规。倾力打造品牌。确保安全，整合资源。", /(使劲点|下功夫点|落地处|做实处|鼓捣|拼了|揉在一起|弄舒坦|一定安全)/],
    ["段落保留", "第一段第一句，说点事情。这里多说两句凑够长度，避免被短段合并规则吃掉。再多一句保险。\n\n第二段第一句，再说点别的。这里也要凑点长度，同样避免合并。再多一句保险。", /^[^\n]*$/s],
  ];
  for (const [name, input, bad] of probes) {
    for (const it of [0.3, 0.6, 1.0]) {
      for (const seed of SEEDS_20) {
        for (const out of [humanize(input, { intensity: it, seed }), mechanicalShuffle(input, { intensity: it, seed })]) {
          if (bad.test(out)) {
            logDetail(`❌ v4.3[${name}] 强度${it} seed${seed}: ${out.slice(0, 60)}`);
            v43++;
            pushV("v4.3", name, it, seed, { pattern: bad.source, snippet: out.slice(0, 200), input: input.slice(0, 200) });
          }
        }
      }
    }
  }
  const para = humanize("第一段第一句，说点事情。\n\n第二段第一句，再说点别的。", { intensity: 0.6, seed: 3 });
  if (!para.includes("\n")) {
    console.log("❌ v4.3 段落丢失: " + para);
    v43++;
    pushV("v4.3", "段落丢失", 0.6, 3, {
      snippet: para.slice(0, 200),
      input: "第一段第一句，说点事情。\n\n第二段第一句，再说点别的。",
    });
  }
  console.log(v43 === 0 ? "✅ v0.4.3 审计修复签名 9 组探针全部通过" : `v0.4.3 共 ${v43} 次违规`);
}

// ============================================================
// v0.5.2 外部通用文本回归：只测自家样本会漏（审查实测：外部普通 AI 体文本
// 首轮即命中套话残留/垫词叠罗汉/名词位崩坏）。用三段项目外文本做硬断言。
// ============================================================
let v52 = 0;
{
  const extSamples = [
    "随着互联网技术的不断发展，远程办公逐渐成为一种流行的工作方式。值得注意的是，远程办公不仅提高了工作效率，还显著提升了员工的工作生活平衡。然而，远程办公也面临着一系列挑战，诸如沟通成本、团队协作等问题。因此，企业需要不断优化管理流程，以确保协作质量。总而言之，远程办公既带来了机遇，也带来了挑战，我们应当以理性的态度看待它。",
    "人工智能正在深刻改变教育行业。首先，人工智能可以实现个性化学习，针对每个学生的特点制定学习方案。其次，人工智能有助于减轻教师的负担，让教师将更多精力投入到教学创新中。此外，人工智能还能够提供即时反馈，帮助学生及时发现并解决问题。与此同时，我们也必须认识到，技术赋能教育并不意味着教师可以被替代。教育的核心在于育人，这是任何技术都无法完全实现的。综上所述，人工智能与教育的融合是大势所趋，我们既要积极拥抱技术，也要坚守教育的本质。",
    "随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。值得注意的是，数字化阅读不仅改变了人们获取知识的方式，还显著提升了阅读的便捷性。然而，数字化阅读也面临着一系列挑战，诸如注意力分散、深度思考能力下降等问题。因此，我们需要在享受技术便利的同时，保持对阅读质量的关注。\n\n首先，数字化阅读让知识的获取变得更加高效。读者可以随时随地通过移动设备访问海量资源，检索与标注也变得前所未有的便捷。其次，数字化阅读有助于降低阅读门槛，让更多人能够接触到优质的内容。此外，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。\n\n与此同时，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。纸质阅读所具有的沉浸感与仪式感，依然是数字媒介难以替代的。阅读的核心在于思考，这是任何技术手段都无法完全实现的。\n\n综上所述，数字化阅读与传统阅读并非对立关系，而是互为补充的两种方式。我们既要积极拥抱技术进步，也要坚守阅读的本质，唯有如此，才能真正实现阅读的价值。",
  ];
  const killerIntro = /(?:^|[。！？!?\n])[ \t]*(?:值得注意的是|值得一提的是|毋庸置疑|毋庸讳言|不可否认|众所周知|归根结底|归根到底|综上所述|总而言之|总的说来|总的来说|简而言之|一言以蔽之|由此可见)(?:的是)?/;
  const introConn = /(?:^|[。！？!?\n])[ \t]*(?:然而|因此|此外|与此同时|更重要的是)[，,、]/;
  const padsAll = ["说真的", "其实", "说实话", "按我的经验", "老实讲", "讲真", "说白了", "你别说", "要我说", "话又说回来", "平心而论", "客观讲", "往实了说", "不瞒你说", "说句掏心窝的", "细想下", "反正", "拢共", "一句话", "简说", "这么看", "照这么说", "值得注意的是", "总而言之", "综上所述"];
  const doublePad = new RegExp("(?:" + padsAll.join("|") + ")，(?:" + padsAll.join("|") + ")，");
  const brokenSigs: [string, RegExp][] = [
    ["名词位替身", /的(合到一起|做到|弄成|办成|搞定|摆平|捋顺|搭起|立起|搞出|改好|调顺|弄舒坦|补齐|弄全|兜好|捞着|混到一起|揉合|盯着|省事|顺手)/],
    ["弄成用处动宾崩", /弄成[^。]{0,8}用处/],
    ["垫词接连接词双开头", /(要我说|说真的|说实话|讲真|客观讲|平心而论)，(这期间|另一头|同时，|更要紧的是|还有一点|这么一来)/],
    ["定语位对口味", /对口味(学习|方案|服务|定制)/],
    ["添劲接动词", /添劲(减轻|提高|降低|改善|解决|增强)/],
    ["语体错位尾助词", /(行业|趋势|教育|技术|发展|本质|方案)[哈嘛呀呗咯]。/],
    ["一次搞定作定语", /一次搞定(服务|方案|平台)/],
    ["使役无主句", /。(让|使|帮|叫)[^。]{2,}/],
    // v0.9.14：句末悬空连接词。boostBurstinessByCutting 的插入语分支曾在首个逗号一刀裸切，
    // 留下「总的来看。」这种光杆孤句，再被 fixOrphanConnectiveLeads 向左粘回上一句尾部，
    // 产出「…工作方式，值得注意的是。」这种病句。健康形态是连接词待在句首（「总的来看，……」），
    // 所以这里只抓"逗号后紧跟连接词、且立刻收句"这一种。
    // 实测：修复前 102/280 次运行命中、修复后 0。别把它改成永真式。
    [
      "句末悬空连接词",
      /[，、](说起来|归结起来|一句话概括|总的来说|总的来看|说到底|有意思的是|值得注意的是|要我说|说白了|按我的经验)[。！？]/,
    ],
    // v0.9.14：枚举标记被单独收成一句（「…入手：首先。企业需要加大研发投入」）。
    // 根因是 fragmentFrontCanStand 取"末段"时只按 ，、； 切、不含冒号，
    // 于是「入手：首先」当成 5 字末段混过 ≤4 字光杆门槛。实测 UI 论说样本 69/210=32.9%。
    [
      "枚举标记光杆成句",
      /[：:；;，][ \t]*(首先|其次|再次|最后|第一|第二|第三|一方面|另一方面)[。！？]/,
    ],
  ];
  /** v0.9.10 P2：句长节奏过平的已知基线（见下方比对段说明） */
  const rateHits: { it: number; seed: number; cv: number }[] = [];
  for (const text of extSamples) {
    if (humanize(text, { intensity: 0, seed: 1 }) !== text) {
      console.log("❌ v5.2 强度0 改动了原文");
      v52++;
      pushV("v5.2", "强度0改动原文", 0, 1, { snippet: "(见 humanize 输出)", input: text.slice(0, 300) });
    }
    for (const it of [0.6, 0.9]) {
      for (const seed of SEEDS) {
        const out = humanize(text, { intensity: it, seed });
        if (killerIntro.test(out)) {
          logDetail(`❌ v5.2 高危套话句首残留 强度${it} seed${seed}: ${out.match(killerIntro)![0]}`);
          v52++;
          pushV("v5.2", "高危套话句首", it, seed, {
            pattern: killerIntro.source,
            snippet: `${out.match(killerIntro)![0]} | ${out.slice(0, 200)}`,
            input: text.slice(0, 300),
          });
        }
        if (introConn.test(out)) {
          logDetail(`❌ v5.2 句首连接词残留 强度${it} seed${seed}`);
          v52++;
          pushV("v5.2", "句首连接词", it, seed, { pattern: introConn.source, snippet: out.slice(0, 200), input: text.slice(0, 300) });
        }
        if (doublePad.test(out)) {
          logDetail(`❌ v5.2 双垫词叠罗汉 强度${it} seed${seed}`);
          v52++;
          pushV("v5.2", "双垫词", it, seed, { pattern: doublePad.source, snippet: out.slice(0, 200), input: text.slice(0, 300) });
        }
        for (const [name, re] of brokenSigs) {
          if (re.test(out)) {
            logDetail(`❌ v5.2 [${name}] 强度${it} seed${seed}: ${out.slice(0, 60)}`);
            v52++;
            pushV("v5.2", name, it, seed, { pattern: re.source, snippet: out.slice(0, 200), input: text.slice(0, 300) });
          }
        }
        // 谓语塌缩差分探针。brokenSigs 是签名式正则，只能防已知写法；这里拿输出与**原文**
        // 做差分，能罩住整类"谓语被删成光杆主语"。这类缺陷曾从 v0.8 一路活到 v0.9.10，
        // 因为 aiScore 对塌句给 0 分——所有指标只奖励"删掉了"，没人检查句子还成不成句。
        for (const col of collapseIssues(text, out)) {
          logDetail(`❌ v5.2 语法塌缩 强度${it} seed${seed}: ${col}`);
          v52++;
          pushV("v5.2", "语法塌缩", it, seed, { snippet: out.slice(0, 200), input: text.slice(0, 300) });
        }
        const rep = fingerprintCheck(out);
        for (const iss of rep.issues) {
          if (iss.name === "段首过渡词残留" || iss.name === "AI 套话残留") {
            logDetail(`❌ v5.2 指纹体检[${iss.name}] 强度${it} seed${seed}`);
            v52++;
            pushV("v5.2", `指纹-${iss.name}`, it, seed, { snippet: out.slice(0, 200), input: text.slice(0, 300) });
          }
          // v0.9.1：节奏检查从 0.6 档改到 0.9 档——v0.9.8 废除极短语气锚后，0.6 档
          // 的 boostBurstiness 拉不动 CV 到 0.45 是设计权衡（少语气词 vs 低 CV），
          // 0.9 档有完整 boost 能力，节奏过平才是真实引擎问题。
          //
          // v0.9.10 基线化（P2）：本项是**已知且有意的设计权衡**，故建基线而非当违规。
          // 背景链：
          //  · v0.9.6 实测证伪 CV 判别力（人写口语随笔 CV=0.27 全场最低、AI 排比 0.34），
          //    标尺删除 burstiness 反向项，只留 ≤8 分弱信号；
          //  · v0.9.8 据此废除「为 CV 撒极短语气锚」的 boostBurstinessIfLow——语气词是
          //    新标尺第一损伤源（单剥可回收 33~84 分）；
          //  · CV 兜底只剩 boostBurstinessByCutting（纯切长句、零注入），对短文本
          //    （<150 字）切句空间不足，0.9 档实测 CV 稳定落在 0.19~0.37。
          // 结论：此处 CV 偏低是「不撒语气词」的必要代价，修它等于重新引入语气词污染。
          // 基线语义：记录当前档位命中数，允许持平，超出即报警（真实退化）。
          if (it === 0.9 && iss.name === "句长节奏过平") {
            rateHits.push({ it, seed, cv: rep.sentenceCV });
          }
        }
      }
    }
  }
  console.log(
    v52 === 0 ? "✅ v0.5.3 外部通用文本回归 3样本×2强度×30种子 全部通过" : `外部回归共 ${v52} 次违规`,
  );

  // ---------------------------------------------------------------------------
  // v0.9.10 P2：「句长节奏过平」基线（已知设计权衡，非常规回归）
  //
  // 为什么建基线而不是修：CV 偏低是「v0.9.6 证伪 CV 判别力 → v0.9.8 废除语气锚注入」
  // 之后的**必然结果**——引擎只剩 boostBurstinessByCutting（纯切长句），短文本
  // 切句空间不足时 CV 拉不到 0.45。修它 = 重新引入语气词污染（新标尺第一损伤源）。
  //
  // 基线语义（与 regression-12samples.lock.json 同思路）：
  //   · 命中数 ≤ 基线 → 通过（打印持平/改善提示，不阻断 CI）；
  //   · 命中数 > 基线 → 报违规（说明除已知权衡外又多了新退化，需人工判断）。
  // 维护：若未来 boost 手段增强使命中数下降，用
  //       `SCAN_UPDATE_RHYTHM=1 npm run test:regress` 打印建议值后手动收紧基线
  //       （本文件顶部注册了精简 process shim，无 argv，故用环境变量而非 CLI flag）。
  // ---------------------------------------------------------------------------
  // v0.9.14：31 → 41（+10）。抬这十格是一笔**算过账**的交换，不是"红了就放宽"：
  //   boostBurstinessByCutting 的插入语分支过去在首个逗号一刀裸切，靠造出
  //   「值得注意的是。」这种光杆孤句抬 CV —— 也就是说这 10 次"节奏达标"本来就是病句换来的。
  //   改成"切点必须落在插入语之后且过 findGuardedCutNear 全套守卫"后，这些句子切不动了：
  //   0.9 档命中数 31 → 41（CV 落在 0.31~0.39，离 0.45 目标不远，不是塌到 0.05 那种）。
  //   同一批运行里「句末悬空连接词」从 **79 次（180 次运行、44%）→ 0 次**，
  //   该签名已进 brokenSigs 硬拦，下次再想靠孤句抬 CV 会直接红。
  //   何况本项指标自身在 v0.9.6 已被实测证伪（人写口语随笔 CV=0.27 是全场最低、判别力≈0 且方向反）。
  //   拿可信度近零的节奏计数去换 44% 的病句率，方向明确。
  //   维护提醒：以后动这块代码先看 brokenSigs["句末悬空连接词"] 的命中数，别看本数。
  const RHYTHM_BASELINE = 41;
  if (UPDATE_RHYTHM_BASELINE) {
    console.log(
      `\n🔧 建议把 RHYTHM_BASELINE 更新为 ${rateHits.length}（当前基线 ${RHYTHM_BASELINE}）——` +
        `命中 CV ${rateHits.length ? `${Math.min(...rateHits.map((h) => h.cv))}~${Math.max(...rateHits.map((h) => h.cv))}` : "无"}`,
    );
  } else if (rateHits.length > RHYTHM_BASELINE) {
    const excess = rateHits.length - RHYTHM_BASELINE;
    logDetail(`❌ v5.3 指纹体检[句长节奏过平] 超出基线：${rateHits.length} > ${RHYTHM_BASELINE}`);
    v52 += excess;
    pushV("v5.3", "指纹-句长节奏过平（超基线）", 0.9, -1, {
      snippet: `命中 ${rateHits.length} 次 > 基线 ${RHYTHM_BASELINE}（CV ${Math.min(...rateHits.map((h) => h.cv))}~${Math.max(...rateHits.map((h) => h.cv))}）`,
      input: "(见 v5.2 外部样本，短文本切句空间不足)",
    });
  } else if (rateHits.length > 0) {
    console.log(
      `📊 v5.3 句长节奏过平：${rateHits.length}/${RHYTHM_BASELINE} 基线内（已知权衡：v0.9.8 废除语气锚后短文本 CV 兜底受限）`,
    );
  }
}

// ============================================================
// v0.6.0 病句修复回归：实测量化过的病句（命中率见 README）全部归零才能过
// ============================================================
let v6 = 0,
  bo = 0;
{
  const gwSample = `高位推动顶层设计，各地压茬推进、挂图作战，攻坚克难、久久为功。我们要锚定目标、紧扣主题，牵住牛鼻子、下好先手棋，打通最后一公里、跑出加速度。通过夯实基础、筑牢防线、厚植优势、盘活资源、补齐短板、锻造长板、擦亮名片，为高质量发展注入新动能、激发新活力、释放新潜力，凝聚共识、形成合力、拓宽渠道、搭建平台。`;
  const listSample = `随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。然而，数字化阅读也面临着一系列挑战，诸如注意力分散、深度思考能力下降等问题。因此，我们需要在享受技术便利的同时，保持对阅读质量的关注。`;
  // 公文书面腔回潮采用「差集式」签名：仅当改写稿引入了「原文没有」的官方腔措辞才算回潮。
  // 语义：引擎把用户原文里的官方腔换成另一套官方腔（如 顶层设计→顶层规划）属于
  // "换汤不换药"，正是要抓的回潮；但若原文本就含某个词、引擎只是保留，不算引入。
  const OFFICIALESE = ["总体设计", "按图推进", "长期坚持", "夯实根基", "守牢防线", "加深优势", "盘活资产", "填平缺口", "拉长长板", "做亮招牌", "排忧解难", "拓宽路子", "架起平台", "顶层规划", "凑成共识"];
  const sigs: [string, string, RegExp, string[]?][] = [
    ["列举被打散", listSample, /(?:诸如|比如|例如|譬如|像是|像)[^。\n]{1,22}。[^。\n]{0,22}(?:等|等等)/],
    ["无法完全弄成", "阅读的核心在于思考，这是任何技术手段都无法完全实现的。", /(无法|难以)(完全)?(弄成|办成)/],
    ["贴着主题", "我们要锚定目标、紧扣主题，下好先手棋。", /(贴着主题|卡着主题|钉在主题|揪着主题)/],
    ["技术少不了", "人工智能技术至关重要，它极大地提升了效率。", /(技术少不了|技术离不了)/],
    ["模板跨标点吞并", "我们要以高质量发展为抓手，为产业升级注入新动能，成为区域协调发展的重要组成部分。", /(给抓手|让抓手)/],
    ["动词并列接跟", "通过夯实基础、厚植优势，凝聚共识、形成合力、拓宽渠道、搭建平台。", /(跟架起|跟搭|以及架起|跟拓|跟形成)/],
    ["公文书面腔回潮", gwSample, new RegExp("(" + OFFICIALESE.join("|") + ")"), OFFICIALESE],
  ];
  for (const [name, input, bad, blacklist] of sigs) {
    for (const it of [0.6, 0.9]) {
      for (const seed of SEEDS) {
        const out = humanize(input, { intensity: it, seed });
        if (!bad.test(out)) continue;
        let matched = out.match(bad)!.map((m) => m.trim());
        // 差集式：若黑名单词全部都是原文已有的（引擎只是保留原意），不算回潮
        if (blacklist) {
          const introduced = blacklist.filter((w) => out.includes(w) && !input.includes(w));
          if (introduced.length === 0) continue;
          matched = introduced;
        }
        logDetail(`❌ v6.0[${name}] 强度${it} seed${seed}: ${matched.join("/")}`);
        v6++;
        pushV("v6.0", name, it, seed, {
          pattern: bad.source,
          snippet: `${matched.join("/")} | ${out.slice(0, 200)}`,
          input: input.slice(0, 300),
        });
      }
    }
  }
  const fullText = listSample + "\n\n" + gwSample;
  for (let base = 0; base < 10; base++) {
    const s = humanizeBestOf(fullText, { intensity: 0.6, candidates: 1, seed: base });
    const m = humanizeBestOf(fullText, { intensity: 0.6, candidates: 10, seed: base });
    const sr = s.fingerprint.issues.length * 1000 + s.after.score;
    const mr = m.fingerprint.issues.length * 1000 + m.after.score;
    if (mr > sr) {
      console.log(`❌ v6.0 择优劣于单次 base${base}: ${mr} > ${sr}`);
      bo++;
      pushV("v6.0", "择优劣于单次", 0.6, base, {
        snippet: `base=${base} multi=${mr} single=${sr}`,
        input: fullText.slice(0, 300),
      });
    }
    if (!m.text.trim()) {
      console.log(`❌ v6.0 择优输出为空 base${base}`);
      bo++;
      pushV("v6.0", "择优输出为空", 0.6, base, { snippet: "", input: fullText.slice(0, 300) });
    }
  }
  console.log(
    v6 === 0 && bo === 0 ? "✅ v0.6.0 病句修复（7 组探针）+ 择优（10 基种子）全部通过" : `v0.6.0 共 ${v6 + bo} 次违规`,
  );
}

// ============================================================
// v0.6.0 朱雀增强模式回归：zhuqueMode 不得引入已知病句/坏搭配
// ============================================================
{
  const zhuqueProbes: [string, string, RegExp][] = [
    ["级联使劲点", "以高质量发展为抓手。", /使劲点/],
    ["获得感截断", "增强人民群众的获得感。", /(?<!获)得感/],
    ["增强人民截断", "增强人民群众的安全感。", /加人民/],
    ["着+了崩溃", "推动了发展。保障了安全。维护了权益。引领了潮流。", /(推着了|护着了|围着了)/],
    ["显出出了", "展现出了巨大的潜力。", /显出出了/],
    ["生造词", "厚植优势。织密网络。形成合力。纲举目张。因地制宜。", /(攒厚优势|织严网络|合起力|抓纲带目|看地方下菜)/],
    ["垫词跨段重复", "值得注意的是，第一段。值得注意的是，第二段。", /要我说[，。].*要我说[，。]/s],
  ];
  for (const [name, input, bad] of zhuqueProbes) {
    for (const it of [0.3, 0.6, 0.9]) {
      for (const seed of SEEDS_20) {
        const out = humanize(input, { intensity: it, seed, zhuqueMode: true });
        if (bad.test(out)) {
          logDetail(`❌ v0.6[${name}] 强度${it} seed${seed}: ${out.slice(0, 60)}`);
          zq++;
          pushV("zhuque-mode", name, it, seed, { pattern: bad.source, snippet: out.slice(0, 200), input: input.slice(0, 200) });
        }
      }
    }
  }
  console.log(
    zq === 0 ? "✅ v0.6.0 朱雀增强模式 7 组探针全部通过" : `v0.6.0 朱雀模式共 ${zq} 次违规`,
  );
}

// ============================================================
// v7.0 引擎搭配/切分签名（2026-09-30 补）
//
// 来源：docs/2026-09-30-sentence-defects-report.md —— 三类在回归样本盲区里
// 稳定复现的病句。它们此前能一路活到 v0.9.18，原因是**每个签名都是逐条手写的**：
// brokenSigs 里有「裸难接动词」「添劲接动词」，说明"替身接动词"这类病早就知道，
// 只是恰好没写「守住下去」「借引入」这两条；而 v0.2/v5.2 的样本里也恰好不含
// 「坚持+补语」「通过+动词短语」「…，也/正在+动词」这三种结构。
//
// 三类缺陷（细节与根因见该文档）：
//   A 词表层单音节替身搭配崩坏 —— VOCAB 280 条里替身为单音节的有 28 条，
//     替换不看搭配；同类问题 2026-08-17 已因「保障→守住」单点处置过一次，
//     但没形成通用守卫，所以「坚持→守住」又踩进来。
//   B 介词降级后接动词短语 —— 通过→借/靠/用，「借引入视觉检测系统」不成话。
//   C 谓语被切出成句 —— fragmentCanStand 的副词守卫要求"副词+着/了/过"，
//     而「也能决定」「正在成为」不带体标记，于是被放行、被劈成独立句。
//     （既有 collapseIssues 差分探针管不到这类：它判据是"尾部被砍≥2字"的
//       删减型塌缩，C 类是"逗号升级为句号"，前后一字不少。）
//     2026-09-30 已修：A/B/C 六条签名**全部归零**，基线同步收紧到 0，
//     六条都从"基线棘轮"升级为**硬拦**——任何一条回升都直接红。
//
// 为什么当初用基线而不是硬拦（保留这一段，避免后来人"顺手改成硬拦"然后被反噬）：
//   登记基线时这 6 条在当前引擎上是稳定命中的（113~120/120），硬拦会让本门禁
//   **永久变红**——而本文件自己记过那条教训（README §12 样本回归开头）：
//   "这道门禁以前是永久红的…红到没人再看它，于是等于没有"。
//   故照 RHYTHM_BASELINE / regression-12samples.lock.json 同范式记基线：
//   只许改善（计数下降），超出基线即红（说明新增了同类退化）。
//   ⇒ 2026-09-30 根因修完后六条**全部归零**，基线收紧到 0，
//     于是这套"基线棘轮"自然等价于硬拦（见 V7_BASELINE 处注释）。
//
// 误报基线（为什么这 6 条有资格进签名表）：14 条合法人写句（含「报告指出，
//   成本上升。其原因很复杂。」「会议到此结束。其后续安排另行通知。」这类
//   正常「其」开头句）× 6 签名 = 0 误报；16 篇真实语料原文（10 篇送检原文
//   + 6 篇 eval/corpus.json）× 6 签名 = 0 误报。复核方式见报告 §2.3。
//
// 维护纪律（照 --rebaseline 的同款设计，不给"红了就调高"的便捷开关）：
//   · 计数**下降** = 修好了或词表收紧了 → 用 SCAN_UPDATE_V7_BASELINE=1 打印
//     建议值，确认后手动收紧常量，让改善被钉住；
//   · 计数**上升** = 新增同类退化 → 先查是不是又往词表塞了单音节替身、
//     或放宽了 fragmentCanStand 守卫，**不要**用调高基线糊过去；
//   · 修根因会改引擎输出字节，必与四条体裁线重拟合一起评估
//     （calib 当前 Δmax 35/35 已压满棘轮天花板）。
// ============================================================
let v7 = 0;
/**
 * v8.0 计数用**对象属性**，不用模块级 `let`。
 *
 * 原因（实测踩过，不是风格偏好）：初版在模块级写了 `let v8 = 0`，又在 v8.0 那个
 * `{...}` 块里**同名再声明了一次** `let v8 = 0`。于是块内 `v8 += hits` 累加的是
 * **块内**那个绑定，而文件末尾 `total` 读的是**模块级**那个——门禁明明抓到 11 次
 * 违规，末尾却打印 `v8=0`、`total=0`、**退出码 0**。
 *
 * 这类"计数变量被同名声明遮蔽"的失效是**静默**的：探针照常打印"共 11 次超出基线"，
 * 只有最后那行退出码是错的——而 CI 只看退出码。用对象属性（`V8_COUNT.n`）不存在
 * 同名遮蔽的余地，踩不到这个坑。
 *
 * 另：v8.0 组必须做过**缺陷注入复验**才算数——2026-10-04 把 humanize 的裸骨架修复
 * 改成不可能匹配后，本组报告 11 次且 exit 1；改回后 0 次 exit 0。
 */
const V8_COUNT = { n: 0 };
{
  const UPDATE_V7_BASELINE = process.env.SCAN_UPDATE_V7_BASELINE === "1";
  // 本组**刻意不跟随 SCAN_TIER**：基线是"120 次里命中多少次"的绝对值，
  // 若种子数随档位变（fast=5 → 每探针最多 20 次），基线 118 在 CI 就永远
  // 不可能被触发——那又是一道"红了也没人看"的门禁。故固定用完整网格：
  // 6 个短输入 × 4 强度 × 30 种子 = 720 次 humanize，实测秒级，CI 能承受。
  const V7_INTENSITIES = [0.4, 0.6, 0.8, 1.0];
  const V7_SEEDS = Array.from({ length: 30 }, (_, i) => i);
  const V7_RUNS = V7_INTENSITIES.length * V7_SEEDS.length; // 120
  /** 签名表：[类, 签名名, 命中正则, 最小复现输入（该输入本身不得命中，否则探针无效）] */
  const v7Probes: ["A" | "B" | "C", string, RegExp, string][] = [
    [
      "A",
      "动补不兼容替换",
      /守住(?:下去|下来|起来)/,
      "他相信，只要坚持下去，未来一定会越来越好。",
    ],
    [
      "A",
      "动宾不兼容替换",
      /守住(?:学习|思考|努力|读书|研究|探索|创新|成长)/,
      "我们要坚持学习，也要坚持思考，才能坚持努力。",
    ],
    [
      "B",
      "介词降级后接动词短语",
      // 行首锚定：只抓"裸介词降级"造成的动词短语开头（「借引入…」），
      // 不抓句中的正常连谓（「用引入的方式」这种"的"字结构不在表内）
      /(?:^|[，。！？、；：\n][ \t]*)(?:用|靠|借)(?:引入|采用|实现|推动|加强|提升|构建|优化|打造|推进|完成|达成|取得|解决|落实|建立|开展|实施)/,
      "通过引入视觉检测系统，产品的缺陷识别效率得到了显著提升。",
    ],
    [
      "C",
      "引导语命题被切开",
      // 要求被切开的名词短语以「的+名词」结尾：这是"该短语无谓语"的确凿信号。
      // 放宽到"任意 2~24 字 + 其"会误伤「报告指出，成本上升。其原因很复杂。」
      // 这类合法人写句（实测 2 处误报），故收紧到名词性后缀白名单。
      /(?:显示|表明|指出|认为|发现|强调)[，,][^，,。！？]{0,14}的(?:人群|企业|群体|用户|学生|员工|机构|公司|团队|产品|项目|数量|比例|幅度|水平|速度|规模|情况|因素|问题)[。！？][ \t]*其/,
      "近年来，随着人工智能技术的快速发展，越来越多的企业开始将其应用于生产和管理环节。数据显示，采用智能化系统的企业，其生产效率平均提升了百分之三十。",
    ],
    [
      "C",
      "谓语状语被切出成句",
      // 副词/时间副词起头 + 谓语：缺主语（承接前句主语），
      // fragmentCanStand 的③号守卫只认"副词+着/了/过"，这类不带体标记故漏过。
      /[。！？\n][ \t]*(?:正在|正|将|已|也|就|才|则|仍|还)[\u4e00-\u9fa5]{0,8}(?:成为|进行|形成|改变|影响|构成|推动|加速|决定|带来|导致|意味着)/,
      "数据孤岛、算法偏见与人才缺口，正在成为转型路上的三块硬骨头。",
    ],
    [
      "C",
      "谓语状语被切出成句·话题述题",
      // 同一条正则、不同触发面：原文是"话题，述题"式（一杯水的温度，也能决定…），
      // 切完前半成光杆名词短语。单列一条是为了区分"哪一类原文结构会踩"，
      // 修的时候两处根因不同（前者缺主语、后者是话题述题被拆）。
      /[。！？\n][ \t]*(?:正在|正|将|已|也|就|才|则|仍|还)[\u4e00-\u9fa5]{0,8}(?:成为|进行|形成|改变|影响|构成|推动|加速|决定|带来|导致|意味着)/,
      "生活不该将就，一杯水的温度，也能决定一整天的节奏。",
    ],
  ];

  /**
   * 基线（2026-09-30 v0.9.18 / HEAD cf933b7 实测，网格固定为
   * 强度 [0.4,0.6,0.8,1.0] × 种子 0~29 = V7_RUNS 次/探针，与 SCAN_TIER 无关）。
   * 每个数都可用 `SCAN_UPDATE_V7_BASELINE=1 npm run test:regress` 现算复核。
   */
  const V7_BASELINE: Record<string, number> = {
    // A/B 三类：2026-09-30 修根因后归零，基线同步收紧到 0（该门禁"只许改善"的纪律）：
    //   动补/动宾 ← 删除 VOCAB 的 坚持→守住（多义项，词表无法表达）
    //   介词降级  ← GUARD_AFTER.通过 补 20 个动词短语后缀（名词语境仍可替换）
    // 归零后这三条从"基线棘轮"升级为**硬拦**：任何回升都直接红。
    动补不兼容替换: 0,
    动宾不兼容替换: 0,
    介词降级后接动词短语: 0,
    // C 三类：2026-09-30 同日修根因后也归零，基线同步收紧到 0（与 A/B 一样升级为硬拦）：
    //   谓语状语×2 ← fragmentCanStand 的副词守卫从"副词+体标记"放宽为"副词+谓语"
    //                 （并对自带主语的副词句放行，避免过度否决）
    //   引导语命题  ← fragmentFrontCanStand 补「的+名词」长名词短语判据
    //                 （原判据只管 ≤4 字短残片，10 字的「采用智能化系统的企业」漏过）
    // ⚠️ 修这两条守卫时踩了两次同一个坑，都在代码注释里钉住了：
    //   判"有没有谓语"**不能**用单字表（CLAUSE_PREDICATE_RE 的「以」、
    //   单字情态表的「能/会/有」）——「智**能**化」「采**用**」这类名词内部
    //   大量嵌这类单字，会把它误判成"有谓语"，守卫加了却 119/119 一动不动。
    //   现判据只收**体标记 + 双字谓词**。
    引导语命题被切开: 0,
    谓语状语被切出成句: 0,
    "谓语状语被切出成句·话题述题": 0,
  };

  const measured: Record<string, number> = {};
  for (const [cls, name, bad, input] of v7Probes) {
    // 探针自检：最小复现输入本身不得命中签名，否则签名匹配的是"原文特征"而非
    // "引擎引入的破坏"（这类自证失效是"永真式签名"的经典来源，v0.9.14 已踩过）
    if (bad.test(input)) {
      console.log(`❌ v7.0 [${name}] 探针无效：最小复现输入本身就命中签名`);
      v7++;
      pushV("v7.0", `${name}·探针无效`, null, null, {
        pattern: bad.source,
        snippet: input.slice(0, 200),
        input: input.slice(0, 200),
      });
      continue;
    }
    let hits = 0;
    for (const it of V7_INTENSITIES) {
      for (const seed of V7_SEEDS) {
        const out = humanize(input, { intensity: it, seed });
        if (bad.test(out)) {
          hits++;
          if (hits === 1) {
            logDetail(`❌ v7.0[${cls}·${name}] 首次命中 强度${it} seed${seed}: ${out.slice(0, 60)}`);
          }
        }
      }
    }
    measured[name] = hits;
    const base = V7_BASELINE[name];
    if (base === undefined) {
      console.log(`❌ v7.0 [${name}] 缺基线值（新签名必须同时登记基线）`);
      v7++;
      pushV("v7.0", `${name}·缺基线`, null, null, { snippet: `实测 ${hits}` });
    } else if (hits > base) {
      // 超出基线 = 新增同类退化。给出可复现首例，落到 artifacts。
      const it0 = V7_INTENSITIES[0];
      const seed0 = V7_SEEDS[0];
      const out0 = humanize(input, { intensity: it0, seed: seed0 });
      logDetail(`❌ v7.0[${cls}·${name}] 超出基线 ${hits} > ${base}`);
      v7 += hits - base;
      pushV("v7.0", name, it0, seed0, {
        pattern: bad.source,
        snippet: `${hits}/${V7_RUNS} 次 > 基线 ${base} | ${out0.slice(0, 200)}`,
        input: input.slice(0, 200),
      });
    }
  }

  /**
   * 金丝雀（同结构、当前未饱和的输入）：解决"签名饱和 → 计数无法上升 → 抓不到新退化"
   * 这个门禁设计问题。上面 6 条主签名里 C 类是 120/120 饱和的，计数只能降不能升，
   * 等于对"新增同类破坏"失明；这里补的输入当前命中 <120（多数远低于），
   * 一旦有人把 fragmentCanStand 守卫放宽或再塞单音节替身，这些计数会抬头。
   *
   * 每条都必须是"引擎当前处理得还算干净"的真实短语结构，不用生造句。
   * 基线同样可用 SCAN_UPDATE_V7_BASELINE=1 现算复核。
   */
  const v7Canary: [string, string, RegExp, number][] = [
    [
      "力图+动词",
      "他力图改变现状，力图突破困局。",
      /想(?:改变|扭转|突破|实现)/,
      80,
    ],
    [
      "促进+名词",
      "政策促进发展，促进增长。",
      /助(?:发展|增长|提升)/,
      58,
    ],
    [
      "针对+问题",
      "针对这个问题，我们提出了方案。针对这些情况，需要复核。",
      /就(?:这个|该|上述|这些)(?:问题|情况|现象)/,
      44,
    ],
    [
      "取得+名词",
      "公司取得成效，项目取得突破。",
      /见(?:成效|效果|突破|进展)/,
      86,
    ],
    // 以下三条当前 0 命中：任何上升都是新引入的同类破坏，最灵敏
    [
      "通过+名词（未饱和）",
      "通过数据分析，通过平台协作，通过工具提效。",
      /(?:^|[，。！？、；：\n][ \t]*)(?:用|靠|借)(?:数据|平台|工具|系统|方法|渠道)(?:来|去|，)/,
      0,
    ],
    [
      "话题述题·未饱和",
      "这次调整，也会影响后续的排期。",
      /[。！？\n][ \t]*(?:正在|也|就|才|则|仍|还)[\u4e00-\u9fa5]{0,8}(?:成为|进行|形成|改变|影响|构成|推动|加速|决定|带来|导致|意味着)/,
      0,
    ],
    [
      "引导语·未饱和",
      "报告指出，参与调研的用户，其反馈集中在三点。",
      /(?:显示|表明|指出|认为|发现|强调)[，,][^，,。！？]{0,14}的(?:人群|企业|群体|用户|学生|员工|机构|公司|团队|产品|项目|数量|比例|幅度|水平|速度|规模|情况|因素|问题)[。！？][ \t]*其/,
      0,
    ],
  ];

  for (const [name, input, bad, base] of v7Canary) {
    if (bad.test(input)) {
      console.log(`❌ v7.0 [金丝雀·${name}] 探针无效：输入本身就命中`);
      v7++;
      pushV("v7.0", `金丝雀·${name}·探针无效`, null, null, {
        pattern: bad.source,
        snippet: input.slice(0, 200),
        input: input.slice(0, 200),
      });
      continue;
    }
    let hits = 0;
    for (const it of V7_INTENSITIES) {
      for (const seed of V7_SEEDS) {
        if (bad.test(humanize(input, { intensity: it, seed }))) hits++;
      }
    }
    measured[`金丝雀·${name}`] = hits;
    if (hits > base) {
      const out0 = humanize(input, { intensity: V7_INTENSITIES[0], seed: V7_SEEDS[0] });
      logDetail(`❌ v7.0[金丝雀·${name}] 超出基线 ${hits} > ${base}`);
      v7 += hits - base;
      pushV("v7.0", `金丝雀·${name}`, V7_INTENSITIES[0], V7_SEEDS[0], {
        pattern: bad.source,
        snippet: `${hits}/${V7_RUNS} 次 > 基线 ${base} | ${out0.slice(0, 200)}`,
        input: input.slice(0, 200),
      });
    }
  }

  const names = v7Probes.map(([, n]) => n);
  const canaryNames = v7Canary.map(([n]) => `金丝雀·${n}`);
  const shown = [...names, ...canaryNames].map((n) => `${n}=${measured[n] ?? "-"}/${V7_BASELINE[n] ?? v7Canary.find(([c]) => `金丝雀·${c}` === n)?.[3] ?? "-"}`);
  if (UPDATE_V7_BASELINE) {
    // 照 RHYTHM 的维护口子：只打印建议值，不自动写常量（改常量需人确认并留理由）
    console.log(`\n🔧 建议把 V7_BASELINE 更新为：\n${JSON.stringify(measured, null, 2)}`);
  }
  console.log(
    v7 === 0
      ? `✅ v7.0 引擎搭配/切分签名 6 条基线内（${shown.join(" ")}）`
      : `v7.0 共 ${v7} 次超出基线（${shown.join(" ")}）`,
  );
}

// ============================================================
// v8.0 类别级语言质量探针 × 多体裁语料（2026-10-04 补）
//
// ## 为什么要这一组，而不是继续往 v7.0 加签名
//
// v7.0 的 6 条签名在 2026-09-30 修完后**全部归零并升级为硬拦**——看数字是完美收官。
// 但 2026-10-04 随手写的 5 段新文本（政务/产品/学术/叙事/随笔）× 3 档强度，
// **立刻命中 3 组 v7.0 一条都不覆盖的病句**：
//   「从治理与合规看看看」「搞出健全的监管框架」「在产业真正做出来那一摊」
//
// 根因不是"修得不干净"，是**签名式回归的结构性天花板**：
//   · 每条签名都绑定"特定词 + 特定结构"，只能证明**老坑有没有复发**；
//   · 且 v0.2/v7.0 的输入都只有**1 段固定 sample**（数字阅读论说文）——
//     覆盖面是"1 段文本 × 120 次"，不是"N 段文本 × M 次"。
//     换一段体裁就换一批搭配，旧签名一条都碰不到。
//
// 因此这一组的两个刻意设计：
//   ① 探针是**类别级**（叠字/裸骨架/口语动词+抽象宾语/语义漂移），不绑定具体词；
//   ② 语料是**多体裁**数组（论说/产品/学术/叙事），不是单段。
//
// ## 判定纪律（与 v7.0 一致）
//
// 新探针先量后定基线：修完实测 0/（语料数×档位×种子）即登记基线 0 = 硬拦。
// 不做"基线棘轮慢慢降"——类别级探针的语义是"这类破坏一条都不许有"。
//
// ## ⚠️ 敏感度实测（2026-10-04 缺陷注入，别把"零命中"当成"探针有效"）
//
// 三条探针都做了"把对应守卫改坏 → 探针是否变红"的注入验证，结果参差不齐：
//   · 口语结果动词+抽象宾语：**单条敏感**（去掉 clashAbstract 即命中「搞出健全的监管框架」）
//   · 三连叠字：**组合敏感**——只去掉叠字左侧判据不红，需同时回退模板正则（残留"审视"）才红
//   · 骨架词独立成句：**不敏感**——去掉独句还原那段也不复现，当前引擎已无该触发路径
// 即：这三条里只有第一条是真正的硬门禁，另两条是纵深。保留它们的理由是防未来
// （引擎改动可能重新打通触发路径），但**不许对外宣称"三条硬拦都在生效"**。
// 完整矩阵见 `src/engine/humanize-quality-v0922.test.ts` 头部注释。
// ============================================================
{
  const V8_INTENSITIES = [0.4, 0.6, 0.9];
  // 语料面比种子面重要：多一段体裁比多种子更能覆盖新搭配。
  // 种子只取 0~9（10 个），网格 = 4 段 × 3 档 × 10 种子 = 120 次/探针，与 v0.2 同量级。
  const V8_SEEDS = Array.from({ length: 10 }, (_, i) => i);

  const V8_CORPUS: [string, string][] = [
    [
      "政务论说",
      "随着人工智能技术的不断发展，自然语言处理已经成为当前学术界与产业界共同关注的重要研究方向。\n首先，从技术演进的角度来看，大语言模型的出现极大地推动了相关领域的技术变革。值得注意的是，模型规模的持续扩大不仅带来了性能的显著提升，也为下游应用提供了坚实的支撑。\n其次，在产业落地层面，越来越多的企业开始将相关技术广泛应用于智能客服、内容生成、辅助办公等多个场景。与此同时，行业内的竞争也日趋激烈，各家企业都在积极构建自身的技术护城河。\n再次，从治理与合规的角度审视，技术的快速发展也带来了不容忽视的伦理风险。因此，建立健全的监管框架具有重要的战略意义。\n综上所述，人工智能技术的发展是一项长期而复杂的系统工程。只有在技术创新与风险防控之间取得平衡，才能真正实现可持续的高质量发展。",
    ],
    [
      "产品介绍",
      "本产品基于先进的分布式架构设计，能够为用户提供高效、稳定、安全的数据处理能力。\n一方面，系统采用了多层次的缓存机制，大幅降低了请求延迟；另一方面，通过智能调度算法，实现了资源的动态分配与优化配置。\n此外，平台还提供了丰富的开放接口，便于开发者进行二次集成。无论是中小型团队还是大型企业，都可以借助该平台显著提升自己的研发效率。\n总的说来，该产品致力于为用户创造长期价值，助力企业实现数字化转型。",
    ],
    [
      "学术摘要",
      "本文旨在探讨城市绿地空间格局对居民心理健康的影响机制。研究以某二线城市为案例，运用空间句法与问卷调查相结合的方法进行分析。\n研究结果表明，绿地可达性与居民的心理健康水平呈显著正相关。与此同时，绿地的植被多样性也对情绪恢复具有积极作用。\n值得注意的是，不同年龄段的人群对绿地的使用需求存在显著差异。因此，在城市绿地规划中应当充分考虑人群的异质性特征。\n本研究的发现对于优化城市绿地布局、提升公共空间品质具有一定的参考价值。",
    ],
    [
      "人写叙事",
      "那年夏天我第一次离开县城。\n火车开了整整一夜，硬座，空调吹得人后颈发凉。凌晨四点我在郑州站下来，站台上有卖胡辣汤的，五块钱一碗，辣得我眼泪都出来了。\n后来我才知道，那是我很多年里最后一次觉得五块钱能买到那么实在的东西。",
    ],
  ];

  const V8_PROBES: [string, RegExp, string][] = [
    [
      "三连叠字",
      // 「从治理与合规看看看」：模板产出"从X看" + 词表「审视→看看」，
      // 两级替换各看各的都没错，叠起来是三连字。既有叠字守卫只查了右侧，漏了左侧。
      /([\u4e00-\u9fa5])\1{2,}/,
      "类别级：替换/切分叠加产生的连续同字，一眼可辨的机器破坏",
    ],
    [
      "骨架词独立成句",
      // 「再说。」「再次。」：骨架词的语义是引导后文，独立成句＝把连接词当完整句子。
      /(?:^|\n|\u3002|\uff01|\uff1f)(?:\u9996\u5148|\u5176\u6b21|\u518d\u8bf4|\u53e6\u5916|\u6b64\u5916|\u603b\u7684\u6765\u770b|\u603b\u800c\u8a00\u4e4b|\u603b\u7684\u8bf4\u6765|\u6700\u540e)\u3002/,
      "类别级：提纲骨架词被切成独句（修复见 humanize 清尾段）",
    ],
    [
      "口语结果动词+抽象宾语",
      // 「搞出健全的监管框架」（实测）：动结式口语动词（搞出/弄出/干出/整出）语义上
      // 要求宾语是"能做出来的具体东西"，接抽象名词即搭配不当。
      // 中间允许 0~6 字的定语，否则「搞出健全的监管框架」里的"健全的"会让它漏网。
      /(?:搞出|弄出|干出|整出|搞成|弄成)[\u4e00-\u9fa5]{0,6}(?:框架|机制|体系|格局|价值|水平|质量|效率|意义|能力|模式|结构|制度|规范|标准|流程|生态|共识|关系|布局|目标|监管|治理|服务|管理|指标|模型|方案|路径|思路|逻辑|规则|秩序|信誉|口碑|信任|权威|优势|潜力|空间|挑战|风险|压力|动力|活力|合力|效力|竞争力|凝聚力|创造力|生产力)/,
      "类别级：动结式口语动词接抽象名词宾语",
    ],
  ];

  const V8_BASELINE: Record<string, number> = {
    三连叠字: 0,
    骨架词独立成句: 0,
    "口语结果动词+抽象宾语": 0,
  };

  const v8Measured: Record<string, number> = {};
  for (const [name, bad] of V8_PROBES) {
    let hits = 0;
    let firstHit = "";
    for (const [corpusName, input] of V8_CORPUS) {
      for (const it of V8_INTENSITIES) {
        for (const seed of V8_SEEDS) {
          const out = humanize(input, { intensity: it, seed });
          if (bad.test(out)) {
            hits++;
            if (!firstHit) {
              const m = out.match(bad);
              firstHit = `${corpusName} 强度${it} seed${seed}: …${out.slice(
                Math.max(0, (out.search(bad) ?? 0) - 20),
                (out.search(bad) ?? 0) + 30,
              )}…（命中「${m?.[0] ?? "?"}」）`;
            }
          }
        }
      }
    }
    v8Measured[name] = hits;
    const base = V8_BASELINE[name];
    if (hits > base) {
      logDetail(`❌ v8.0[${name}] 超出基线 ${hits} > ${base} ｜ ${firstHit}`);
      V8_COUNT.n += hits - base;
      pushV("v8.0", name, V8_INTENSITIES[0], V8_SEEDS[0], {
        pattern: bad.source,
        snippet: `${hits} 次 > 基线 ${base} ｜ ${firstHit}`,
        input: V8_CORPUS[0][1].slice(0, 200),
      });
    }
  }
  console.log(
    V8_COUNT.n === 0
      ? `✅ v8.0 类别级语言质量探针 3 条 × 4 体裁语料 × 3 档 × 10 种子 = 120 次/探针，全部零命中（${Object.entries(
          v8Measured,
        )
          .map(([k, v]) => `${k}=${v}/0`)
          .join(" ")}）`
      : `v8.0 共 ${V8_COUNT.n} 次超出基线（${Object.entries(v8Measured)
          .map(([k, v]) => `${k}=${v}/${V8_BASELINE[k]}`)
          .join(" ")}）`,
  );
}

// ============================================================
// v0.4.4 本地忠实度校验自检
// ============================================================
{
  const orig = "公司2025年营收增长23%，海外占40%。新产品明年3月发布，支持GPT和Claude模型。";
  const good = "公司2025年营收增长23%，海外占40%。新产品明年3月出，兼容GPT和Claude。";
  const badNum = "公司2025年营收增长32%，海外占40%。新产品明年3月出，兼容GPT和Claude。";
  const badLost = "公司2025年营收增长23%，海外占40%。新产品明年出，兼容GPT。";
  if (!checkFidelityLocal(orig, good).pass) {
    console.log("❌ 忠实校验误报（合法改写被拦）");
    f44++;
    pushV("fidelity", "误报", null, null, { input: orig });
  }
  if (checkFidelityLocal(orig, badNum).pass) {
    console.log("❌ 忠实校验漏报（23%→32%未抓）");
    f44++;
    pushV("fidelity", "漏报-数字篡改", null, null, { input: orig });
  }
  if (checkFidelityLocal(orig, badLost).pass) {
    console.log("❌ 忠实校验漏报（数字/Claude丢失未抓）");
    f44++;
    pushV("fidelity", "漏报-数字丢失", null, null, { input: orig });
  }
  console.log(
    f44 === 0 ? "✅ 本地忠实度校验 判别正确（合法过/篡改拦/丢失拦）" : `忠实度校验 ${f44} 项问题`,
  );
}

// ============================================================
// 汇总：CI 上先看摘要表（分组×签名×强度分布），复现看 artifacts/scan-bugs/*.txt
// ============================================================
reportAll(violations, { summaryOnly: VERBOSE });

const total = fails + dfFails + v4 + fp + v43 + v52 + v6 + bo + zq + f44 + v7 + V8_COUNT.n;
if (total > 0) {
  console.error(
    `\n❌ 回归测试共 ${total} 次违规（fails=${fails} dfFails=${dfFails} v4=${v4} fp=${fp} v43=${v43} v52=${v52} v6=${v6} bo=${bo} zq=${zq} f44=${f44} v7=${v7} v8=${V8_COUNT.n}）`,
  );
  process.exit(1);
}
console.log(
  `\n✅ 全部回归通过（fails=${fails} dfFails=${dfFails} v4=${v4} fp=${fp} v43=${v43} v52=${v52} v6=${v6} bo=${bo} zq=${zq} f44=${f44} v7=${v7} v8=${V8_COUNT.n}）`,
);
