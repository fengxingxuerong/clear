import { humanize, mechanicalShuffle, fingerprintCheck, checkFidelityLocal } from "../src/engine/humanize.ts";
declare const process: { exit(code?: number): never };
const sample = `随着数字技术的不断发展，人们的阅读方式正在发生深刻变化。传统的纸质阅读逐渐让位于数字阅读，电子书、听书、碎片化阅读成为许多人的日常选择。这一转变不仅改变了人们获取信息的渠道，也深刻影响着人们的思维习惯与生活方式。

值得注意的是，数字阅读的普及带来了效率的显著提升。读者可以随时随地通过移动设备访问海量资源，检索、标注与分享变得前所未有的便捷。然而，效率的提升并不等同于阅读质量的提高。碎片化的信息获取方式，往往使读者难以进行深度思考，注意力也更容易被分散。

与此同时，纸质阅读所具有的沉浸感与仪式感，依然是数字阅读难以替代的。翻动书页的触感、墨香与书签，构成了独特的阅读体验。更重要的是，线性阅读所培养的专注力与耐心，对于系统性知识建构具有不可忽视的价值。

综上所述，数字阅读与纸质阅读并非对立关系，而是互为补充的两种方式。读者应当根据自身的阅读目标与场景，灵活选择合适的阅读媒介。唯有如此，才能在信息时代真正实现阅读的价值最大化。`;
// 病句签名扫描：修复目标模式在多种子/多强度下不得出现
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
  for (let seed = 0; seed < 30; seed++) {
    const out = humanize(sample, { intensity: it, seed });
    for (const [name, re] of badPatterns) {
      if (re.test(out)) {
        console.log(`❌ 强度${it} seed${seed} 命中[${name}]`);
        fails++;
      }
    }
  }
}
console.log(fails === 0 ? "✅ 120 次运行零病句签名命中" : `共 ${fails} 次命中`);

// v0.3.3 反指纹层回归：机械扰动后的输出必须满足限额/去重约束
const llmStyle = `说真的，现在数字阅读确实方便。检索、标注、分享都很快——效率高得不是一星半点——但是质量未必跟上。说真的，我经常刷完就忘。讲真，注意力也容易散。讲真，这挺麻烦的。碎片化信息看多了，脑子木。另外，纸质书的沉浸感还在。另外，油墨味和书签是独一份的体验……总之各有各的好……所以说，看场景选就行。所以说，灵活一点没坏处。`;
let dfFails = 0;
for (let seed = 0; seed < 20; seed++) {
  const out = mechanicalShuffle(llmStyle, { intensity: 0.3, seed });
  // 垫词复读：同一垫词+"，"最多出现一次
  for (const w of ["说真的", "讲真", "所以说", "另外"]) {
    const c = out.split(w + "，").length - 1;
    if (c > 1) {
      console.log(`❌ 反指纹 seed${seed} 垫词[${w}]出现${c}次`);
      dfFails++;
    }
  }
  // 破折号整篇最多 1 个，省略号最多 1 个
  if (out.split("——").length - 1 > 1) {
    console.log(`❌ 反指纹 seed${seed} 破折号超标`);
    dfFails++;
  }
  if (out.split("……").length - 1 > 1) {
    console.log(`❌ 反指纹 seed${seed} 省略号超标`);
    dfFails++;
  }
}
console.log(
  dfFails === 0 ? "✅ 反指纹层 20 种子全部满足限额/去重约束" : `反指纹层共 ${dfFails} 次违规`,
);

// v0.4.0 竞品移植规则回归：空格指纹/让步句重构/半角限频
const spacey = `随着 AI 技术的发展，模型参数已达到 1750 亿规模。实测显示准确率为 92.5 %，比 GPT-3 高出 10 个点。这种 AI 写作工具应运而生。虽然成本很高，但是效果不错。虽然门槛不低，但是值得投入。`;
let v4 = 0;
for (let seed = 0; seed < 20; seed++) {
  const out = mechanicalShuffle(spacey, { intensity: 0.3, seed });
  // 中文与字母/数字之间不得残留空格（\n 除外）
  if (
    /[\u4e00-\u9fa5，。；：、][ \t]+[A-Za-z0-9]/.test(out) ||
    /[A-Za-z0-9%）)\]][ \t]+[\u4e00-\u9fa5]/.test(out)
  ) {
    console.log(`❌ v4 seed${seed} 空格指纹残留`);
    v4++;
  }
  // 半角逗号混入量必须极低（≤ 每 10 个逗号 1 个）
  const full = (out.match(/，/g) || []).length;
  const half = (out.match(/,/g) || []).length;
  if (full + half > 0 && half / (full + half) > 0.15) {
    console.log(`❌ v4 seed${seed} 半角混入过高 ${half}/${full + half}`);
    v4++;
  }
}
// 让步句重构：高强度下"虽然…但是"应被重构掉
const reframed = mechanicalShuffle("虽然成本很高，但是效果不错。虽然门槛不低，但是值得投入。", {
  intensity: 1,
  seed: 3,
});
if (/虽然[^，。]{2,16}[，,]?但是/.test(reframed)) {
  console.log("❌ v4 让步句未重构: " + reframed);
  v4++;
}
console.log(v4 === 0 ? "✅ v0.4.0 竞品移植规则 20 种子全部通过" : `v0.4.0 规则共 ${v4} 次违规`);
console.log("\n让步句重构示例: " + reframed);

// v0.4.1 指纹体检自检：坏文本必须报警、机械层清洗后干净文本必须通过
const dirty = `值得注意的是，随着 AI 技术的发展，模型规模已达 1750 亿。说真的，这很厉害。说真的，很快。——但是——然而，成本很高。综上所述，效果不错。综上所述，值得投入。句长均匀节奏平稳的一组句子。信息密度接近长度相当的另一组句子。检测器看的正是这种规律性特征。综上所述不错。……真的……`;
const dirtyReport = fingerprintCheck(dirty);
const dirtyNames = dirtyReport.issues.map((i) => i.name);
const mustCatch = [
  "中英数字间空格",
  "垫词复读「说真的」",
  "破折号超标",
  "段首过渡词残留",
  "AI 套话残留",
];
let fp = 0;
for (const name of mustCatch) {
  if (!dirtyNames.includes(name)) {
    console.log(`❌ 指纹体检漏报: ${name}`);
    fp++;
  }
}
if (dirtyReport.pass) {
  console.log("❌ 指纹体检对脏文本判定为通过");
  fp++;
}
// 干净文本（机械层清洗过的脏文本）应通过
for (let seed = 0; seed < 10; seed++) {
  const cleaned = mechanicalShuffle(dirty, { intensity: 0.6, seed });
  const rep = fingerprintCheck(cleaned);
  if (!rep.pass && rep.issues.some((i) => mustCatch.includes(i.name))) {
    console.log(`❌ 清洗后仍残留（seed${seed}）: ${rep.issues.map((i) => i.name).join("、")}`);
    fp++;
  }
}
console.log(
  fp === 0 ? "✅ 指纹体检自检通过（漏报 0 / 清洗后干净 10 种子）" : `指纹体检共 ${fp} 次问题`,
);

// v0.4.3 子代理审计修复签名：这些输入在任何强度/种子下都不得再出病句/乱码/丢段落
let v43 = 0,
  zq = 0,
  f44 = 0;
{
  const probes: [string, string, RegExp][] = [
    [
      "进行了X→了X",
      "我们对流程进行了优化。团队对数据开展了分析，并予以了反馈。",
      /(流程了|数据了|并了|予以了$)/,
    ],
    [
      "第二天被切量词",
      "第二天早上他就走了。第一时间我们做了响应。最后一天最忙。",
      /(第二个天|头一个天|头一个时间|最后说一句天|头一个步|头一个段)/,
    ],
    [
      "可持续内嵌",
      "推动可持续发展，保持持续性增长。提出针对性措施，有针对性地落实。通过了资格考试。",
      /(可(一直|接连|没停过)发展|持续性?(一直|接连|没停过)|就性措施|奔着性措施|靠了考试)/,
    ],
    [
      "URL/时间乱码",
      "详见 https://example.com/page?id=1 页面，时间是 12:30，联系 test@mail.com 咨询。。测试……真的……继续——再——结束。",
      /(https[：，]|12[：，]30)/,
    ],
    ["疑问句挂尾巴", "这个方案到底可行吗？他会不会来呢？", /(吗[嘛吧呢呀哈]，|吗，你细品|呢嘛。)/],
    [
      "双了/名词位了",
      "实现了重大突破。分享学习收获。加强城市治理。效率的提升。",
      /(突破了。|收获了。|治理了。|提升了。)/,
    ],
    [
      "无论/只要模板病句",
      "无论刮风下雨，他都会准时到岗。只要价格合适，买家就会出现。与其说是天赋，不如说是努力。",
      /(照样。|都照办|就能买家|自然会买家|宁可说是)/,
    ],
    [
      "级联二次替换",
      "把人才引进作为抓手。随着改革深入，政策落地。大力实施新规。倾力打造品牌。确保安全，整合资源。",
      /(使劲点|下功夫点|落地处|做实处|鼓捣|拼了|揉在一起|弄舒坦|一定安全)/,
    ],
    [
      "段落保留",
      "第一段第一句，说点事情。这里多说两句凑够长度，避免被短段合并规则吃掉。再多一句保险。\n\n第二段第一句，再说点别的。这里也要凑点长度，同样避免合并。再多一句保险。",
      /^[^\n]*$/s,
    ],
  ];
  for (const [name, input, bad] of probes) {
    for (const it of [0.3, 0.6, 1.0]) {
      for (let seed = 0; seed < 20; seed++) {
        for (const out of [
          humanize(input, { intensity: it, seed }),
          mechanicalShuffle(input, { intensity: it, seed }),
        ]) {
          if (bad.test(out)) {
            console.log(`❌ v4.3[${name}] 强度${it} seed${seed}: ${out.slice(0, 60)}`);
            v43++;
          }
        }
      }
    }
  }
  // 段落保留专项：humanize 输出必须含换行
  const para = humanize("第一段第一句，说点事情。\n\n第二段第一句，再说点别的。", {
    intensity: 0.6,
    seed: 3,
  });
  if (!para.includes("\n")) {
    console.log("❌ v4.3 段落丢失: " + para);
    v43++;
  }
  console.log(v43 === 0 ? "✅ v0.4.3 审计修复签名 9 组探针全部通过" : `v0.4.3 共 ${v43} 次违规`);
}

// v0.6.0 朱雀增强模式回归：zhuqueMode 不得引入已知病句/坏搭配
{
  const zhuqueProbes: [string, string, RegExp][] = [
    ["级联使劲点", "以高质量发展为抓手。", /使劲点/],
    ["获得感截断", "增强人民群众的获得感。", /(?<!获)得感/],
    ["增强人民截断", "增强人民群众的安全感。", /加人民/],
    ["着+了崩溃", "推动了发展。保障了安全。维护了权益。引领了潮流。", /(推着了|护着了|围着了)/],
    ["显出出了", "展现出了巨大的潜力。", /显出出了/],
    [
      "生造词",
      "厚植优势。织密网络。形成合力。纲举目张。因地制宜。",
      /(攒厚优势|织严网络|合起力|抓纲带目|看地方下菜)/,
    ],
    ["垫词跨段重复", "值得注意的是，第一段。值得注意的是，第二段。", /要我说[，。].*要我说[，。]/s],
  ];
  for (const [name, input, bad] of zhuqueProbes) {
    for (const it of [0.3, 0.6, 0.9]) {
      for (let seed = 0; seed < 20; seed++) {
        const out = humanize(input, { intensity: it, seed, zhuqueMode: true });
        if (bad.test(out)) {
          console.log(`❌ v0.6[${name}] 强度${it} seed${seed}: ${out.slice(0, 60)}`);
          zq++;
        }
      }
    }
  }
  console.log(
    zq === 0 ? "✅ v0.6.0 朱雀增强模式 7 组探针全部通过" : `v0.6.0 朱雀模式共 ${zq} 次违规`,
  );
}

// v0.4.4 本地忠实度校验自检
{
  const orig = "公司2025年营收增长23%，海外占40%。新产品明年3月发布，支持GPT和Claude模型。";
  const good = "公司2025年营收增长23%，海外占40%。新产品明年3月出，兼容GPT和Claude。";
  const badNum = "公司2025年营收增长32%，海外占40%。新产品明年3月出，兼容GPT和Claude。";
  const badLost = "公司2025年营收增长23%，海外占40%。新产品明年出，兼容GPT。";
  if (!checkFidelityLocal(orig, good).pass) {
    console.log("❌ 忠实校验误报（合法改写被拦）");
    f44++;
  }
  if (checkFidelityLocal(orig, badNum).pass) {
    console.log("❌ 忠实校验漏报（23%→32%未抓）");
    f44++;
  }
  if (checkFidelityLocal(orig, badLost).pass) {
    console.log("❌ 忠实校验漏报（数字/Claude丢失未抓）");
    f44++;
  }
  console.log(
    f44 === 0 ? "✅ 本地忠实度校验 判别正确（合法过/篡改拦/丢失拦）" : `忠实度校验 ${f44} 项问题`,
  );
}

// 汇总：任一回归组失败即非零退出，供 CI / 一键脚本感知
const total = fails + dfFails + v4 + fp + v43 + zq + f44;
if (total > 0) {
  console.error(
    `\n❌ 回归测试共 ${total} 次违规（fails=${fails} dfFails=${dfFails} v4=${v4} fp=${fp} v43=${v43} zq=${zq} f44=${f44}）`,
  );
  process.exit(1);
}
console.log(
  `\n✅ 全部回归通过（fails=${fails} dfFails=${dfFails} v4=${v4} fp=${fp} v43=${v43} zq=${zq} f44=${f44}）`,
);
