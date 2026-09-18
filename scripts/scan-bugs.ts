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
  const RHYTHM_BASELINE = 31;
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

const total = fails + dfFails + v4 + fp + v43 + v52 + v6 + bo + zq + f44;
if (total > 0) {
  console.error(
    `\n❌ 回归测试共 ${total} 次违规（fails=${fails} dfFails=${dfFails} v4=${v4} fp=${fp} v43=${v43} v52=${v52} v6=${v6} bo=${bo} zq=${zq} f44=${f44}）`,
  );
  process.exit(1);
}
console.log(
  `\n✅ 全部回归通过（fails=${fails} dfFails=${dfFails} v4=${v4} fp=${fp} v43=${v43} v52=${v52} v6=${v6} bo=${bo} zq=${zq} f44=${f44}）`,
);
