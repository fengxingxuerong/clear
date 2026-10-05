/**
 * humanize-shuffle 硬约束层测试
 * ---------------------------------------------------------
 * 只覆盖「确定性收口」的纯函数：句长上限、破折号上限、语气词密度上限。
 * 这三个是最后的兜底闸门——上游注入器可以随便加料，闸门必须把结果压回
 * 人味区间；闸门一旦失效，朱雀分数会静默劣化且看不出是哪一步出的错。
 * 均为零随机、幂等，可精确断言。
 */
import { describe, it, expect } from "vitest";
import {
  boostBurstinessByCutting,
  capParticleSentenceDensity,
  clampAvgSentenceLenUnder25,
  ensureEmDashCountHardCap,
} from "./humanize-shuffle.ts";
import { fragmentFrontCanStand } from "./humanize-primitives.ts";
import { fragmentCanStand } from "./humanize-vocab.ts";
import { humanize } from "./humanize.ts";
import { boostBurstinessIfLow, boostBurstiness } from "./shuffle/burstiness.ts";

/** 按句末标点切句，返回去掉空白后的纯字数序列（够用，不引第三方分词） */
function sentLens(text: string): number[] {
  return (text.match(/[^。！？!?]+[。！？!?]?/g) ?? [])
    .map((s) => s.replace(/[\s。！？!?…，、；：""''「」（）《》【】—-]/g, "").length)
    .filter((n) => n > 0);
}

function avgSentLen(text: string): number {
  const ls = sentLens(text);
  return ls.length === 0 ? 0 : ls.reduce((a, b) => a + b, 0) / ls.length;
}

const countEmDash = (t: string): number => (t.match(/——/g) ?? []).length;

describe("clampAvgSentenceLenUnder25（句长硬上限）", () => {
  it("已达标文本原样返回（幂等）", () => {
    const t = "今天天气不错。我们出去走走吧。";
    expect(clampAvgSentenceLenUnder25(t)).toBe(t);
  });

  it("maxCuts=0 时不做任何切割", () => {
    const t = "根据最新的市场调研报告显示，今年的增长非常明显而且持续了很久，各方面都不错。";
    expect(clampAvgSentenceLenUnder25(t, 25, 0)).toBe(t);
  });

  // 注意：切点会被「状语从句守卫」否决（"根据…显示，" 句号化即残句），
  // 因此这里用主谓完整的长句，逗号切分后两半都能独立成句。
  const LONG =
    "这款处理器采用了全新的架构设计，整体性能相比上一代提升了大约百分之四十的水平，功耗方面也有明显改善。";

  it("超长且含逗号的句子会被切开，平均句长下降", () => {
    const before = avgSentLen(LONG);
    const after = clampAvgSentenceLenUnder25(LONG, 25, 6);
    expect(before).toBeGreaterThan(25);
    expect(avgSentLen(after)).toBeLessThan(before);
    // 切完句数变多，且必须还是完整句（每句都有句末标点）
    expect(sentLens(after).length).toBeGreaterThan(sentLens(LONG).length);
  });

  it("切开后文本语义不丢（去掉标点后字符集合守恒）", () => {
    const norm = (s: string) => [...s.replace(/[\s。，、；：—-]/g, "")].sort().join("");
    expect(norm(clampAvgSentenceLenUnder25(LONG, 25, 6))).toBe(norm(LONG));
  });

  it("状语从句开头的长句不切（守卫否决，避免造出残句）", () => {
    // "根据…显示，" 句号化后是无谓语残句，必须整句保留
    const t =
      "根据最新的市场调研报告显示，今年的整体增长非常明显而且持续了相当长的一段时间，各个方面的表现都还不错。";
    expect(clampAvgSentenceLenUnder25(t, 25, 6)).toBe(t);
  });

  it("多段落：按段独立处理，段数守恒（不得把段落合并）", () => {
    const long =
      "这款处理器采用了全新的架构设计，整体性能相比上一代提升了大约百分之四十的水平，功耗方面也有明显改善。";
    const t = `${long}\n\n${long}\n\n${long}`;
    const out = clampAvgSentenceLenUnder25(t, 25, 6);
    expect(out.split(/\n\n+/)).toHaveLength(3);
  });

  it("无切点（无逗号）的超长句保持原样而不是被破坏", () => {
    const t = "这是一个完全没有逗号分隔的超长句子用来验证没有切点时不应该被强行切断处理。";
    expect(clampAvgSentenceLenUnder25(t, 10, 6)).toBe(t);
  });

  /**
   * v0.9.1「使役无主句」守卫（structure.ts 行 744）
   *
   * 744 行是 `if (!fragmentCanStand(rest)) continue;` —— 切出的后半句若以
   * 「让/使/将」开头（承接前句宾语做主语），单独成句就是**无主病句**，
   * 必须跳过该候选换下一句切（scan-bugs v5.2 曾报 106 次违规）。
   *
   * 上面那条「状语从句开头」的用例其实走不到这里——它的 rest 有主语。
   * 要命中 744 必须让**唯一可切点**的 rest 无主语：
   * 探针实测（下面四个）原样返回，一个字都没改。
   */
  it("切出的后半句是使役无主句时放弃切分（行 744 continue）", () => {
    const cases: [string, string][] = [
      [
        "以「将推动」开头",
        "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十，将推动整个行业重新洗牌。",
      ],
      [
        "以「让…」开头",
        "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十，让教师的负担明显减轻很多。",
      ],
      [
        "以「将提高」开头",
        "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十，将提高整体的效率水平很多。",
      ],
      [
        "以「使…」开头",
        "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十，使效率大幅提升很多。",
      ],
    ];
    for (const [label, t] of cases) {
      const rest = t
        .split(/[，；、：]/)
        .pop()!
        .trim();
      // 前置确认：这些 rest 确实被判为「不能独立成句」，否则本用例没意义
      expect(fragmentCanStand(rest), `${label}: ${rest.slice(0, 12)}`).toBe(false);
      // avg 已超阈值（所以确实进入切分尝试），但守卫生效 → 原样返回
      expect(clampAvgSentenceLenUnder25(t, 25, 6), label).toBe(t);
    }
  });

  it("rest 带主语时照常切分（守卫生效方向不搞反）", () => {
    // 对照组：同样超长、同样只有一个逗号，但 rest 有主语「这次改版」→ 允许切
    const t =
      "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十，这次改版将推动整个行业重新洗牌。";
    const out = clampAvgSentenceLenUnder25(t, 25, 6);
    expect(fragmentCanStand("这次改版将推动整个行业重新洗牌。")).toBe(true);
    expect(out).not.toBe(t);
    expect(out.endsWith("。")).toBe(true);
  });
});

describe("ensureEmDashCountHardCap（破折号硬上限）", () => {
  it("cap<0 时原样返回", () => {
    const t = "前面——中间——后面——";
    expect(ensureEmDashCountHardCap(t, -1)).toBe(t);
  });

  it("未超限时原样返回", () => {
    const t = "你可能会问——这靠谱吗？";
    expect(ensureEmDashCountHardCap(t, 1)).toBe(t);
  });

  it("超限时收敛到 cap 个", () => {
    const t = "第一处——第二处——第三处——第四处——";
    const out = ensureEmDashCountHardCap(t, 1);
    expect(countEmDash(out)).toBeLessThanOrEqual(1);
  });

  it("自问自答型（前字为「问」）保留破折号，其余收敛", () => {
    // 段首「你可能会问——」是自问自答，注释明确要求保住；尾部那处应被替换
    const t = "你可能会问——这真的靠谱吗。后面还有一处——以及第三处——内容。";
    const out = ensureEmDashCountHardCap(t, 1);
    expect(out).toContain("问——");
    expect(countEmDash(out)).toBeLessThanOrEqual(1);
  });

  it("替换后不留 \u0000 占位符（placeholder 必须还原）", () => {
    const t = "你问——甲——乙——丙——";
    const out = ensureEmDashCountHardCap(t, 1);
    expect(out).not.toContain("\u0000");
  });

  it("已达标时幂等（再跑一次结果不变）", () => {
    const t = "只有一处——内容";
    expect(ensureEmDashCountHardCap(ensureEmDashCountHardCap(t, 1), 1)).toBe(
      ensureEmDashCountHardCap(t, 1),
    );
  });
});

describe("capParticleSentenceDensity（语气词密度上限）", () => {
  it("未超限时原样返回", () => {
    const t = "这个功能确实好用。界面也挺清爽的。";
    expect(capParticleSentenceDensity(t, 1)).toBe(t);
  });

  it("独立语气句超过上限的部分被丢弃", () => {
    const t = "这个功能确实好用。嗯。这个功能确实好用。哦。";
    const out = capParticleSentenceDensity(t, 1);
    // 保留至多 1 条独立语气句，另一条被删
    const standalone = (out.match(/[嗯哦]。/g) ?? []).length;
    expect(standalone).toBeLessThanOrEqual(1);
    // 正文必须还在（不能把正事一起删了）
    expect(out).toContain("这个功能确实好用");
  });

  it("超额句尾语气词只剥词、保留句子本体", () => {
    const t = "这款产品续航不错哦。之前用过的一款也还行吧。";
    const out = capParticleSentenceDensity(t, 1);
    expect(out).toContain("续航不错");
    expect(out).toContain("也还行");
  });

  it("stripSuffix=false 时保留句尾语气词（最终收口用）", () => {
    const t = "这款产品续航不错哦。之前用过的一款也还行吧。";
    const out = capParticleSentenceDensity(t, 1, false);
    expect(out).toContain("哦");
  });

  it("整段只剩短碎句且带语气词残留时整段丢弃（防止留下空壳段）", () => {
    const t = "行。嗯。\n\n这是正常的正文段落内容足够长不会被误删掉。";
    const out = capParticleSentenceDensity(t, 1);
    expect(out).toContain("这是正常的正文段落");
    expect(out).not.toContain("行。嗯。");
  });

  it("正常短句段不得被误判为空壳（≤8 字是常见中文句长）", () => {
    // 回归锁定：v0.9.10 前该函数会把这类普通短句段整段清空
    const t = "这个功能确实好用。界面也挺清爽的。";
    expect(capParticleSentenceDensity(t, 1)).toBe(t);
  });

  it("幂等：跑第二次结果不变", () => {
    const t = "续航不错哦。嗯。也还行吧。哦。";
    const once = capParticleSentenceDensity(t, 1);
    expect(capParticleSentenceDensity(once, 1)).toBe(once);
  });
});

/**
 * v0.9.14（#24/#27）：切分器不得制造光杆连接词孤句。
 * boostBurstinessByCutting 的插入语分支曾在首个逗号一刀裸切，产出「值得注意的是。」
 * 这种 4 字孤句，再被 anti-fingerprint 的 fixOrphanConnectiveLeads 向左粘回上一句尾部，
 * 变成「…工作方式，值得注意的是。」病句。该缺陷在外部样本上的实测命中率是 79/180（44%），
 * 且此前 scan-bugs 全绿——因为它唯一的"贡献"是把 CV 抬上去，而 CV 是指标里最弱的一项。
 */
describe("boostBurstinessByCutting（不得切出光杆连接词）", () => {
  const cases: Array<[string, string]> = [
    ["值得注意的是", "值得注意的是，远程办公不仅提高了工作效率，还显著提升了员工的工作生活平衡。"],
    ["总的来看", "总的来看，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。"],
    [
      "归结起来",
      "归结起来，人工智能正在深刻改变教育行业，首先可以实现个性化学习，其次能减轻教师负担。",
    ],
  ];
  for (const [name, s] of cases) {
    for (const target of [0.3, 0.55, 0.8]) {
      it(`${name} @target cv=${target}：不产出句末光杆孤句，插入语仍与后文同句`, () => {
        const out = boostBurstinessByCutting(s, target, 8);
        expect(out).not.toMatch(new RegExp(`[，、]?(?:${name})[。！？]`));
        if (out.includes(name)) expect(out).toMatch(new RegExp(`${name}[，、]`));
      });
    }
  }

  it("没有把分支一关了之：普通长句该切还是要切（否则上面那组断言是永真式）", () => {
    const s =
      "远程办公在过去三年里普及得非常快，员工的时间安排随之变了，企业也开始重新评估固定工位的必要性。";
    const before = s.split("。").filter((x) => x.trim()).length;
    const out = boostBurstinessByCutting(s, 0.8, 8);
    const after = out.split("。").filter((x) => x.trim()).length;
    expect(after).toBeGreaterThan(before);
  });
});

/**
 * v0.9.14：切点守卫取"末段"必须认冒号。
 * fragmentFrontCanStand 原来只按 ，、； 切末段，于是「…入手：首先」被当成 5 字末段
 * 混过 ≤4 字光杆门槛，切点放行后产出「…入手：首先。」这种枚举标记独立成句的病句
 * （UI 论说样本实测 69/210 次 = 32.9%，强度 ≥0.5 起）。
 */
describe("fragmentFrontCanStand（末段切分必须含冒号）", () => {
  it("冒号后是光杆枚举标记 → 否决（句号化即无谓语残句）", () => {
    expect(fragmentFrontCanStand("具体来说，可以从以下三个方面入手：首先")).toBe(false);
    expect(fragmentFrontCanStand("这件事有三个原因：第二")).toBe(false);
  });

  it("冒号后是完整小句 → 照常放行（别把守卫改成一律否决）", () => {
    expect(fragmentFrontCanStand("具体来说，可以从以下三个方面入手：趋势已经很明显了")).toBe(true);
  });

  it("逗号路径的原有否决不受影响（≤4 字无谓语仍拦）", () => {
    expect(fragmentFrontCanStand("这套工艺")).toBe(false);
    expect(fragmentFrontCanStand("这套工艺已经成熟量产了")).toBe(true);
  });
});

/**
 * 2026-09-30 C 类（谓语被切出成句）：见 docs/2026-09-30-sentence-defects-report.md §5.3 ②。
 *
 * 两条守卫各管一个触发面：
 *   fragmentCanStand    —— 后半句以承接性副词+谓语起头（「也能决定」「正在成为」），
 *                          原来的守卫要求副词后必须带体标记（着/了/过），这类不带故漏过；
 *   fragmentFrontCanStand —— 前半句以「的+名词」收尾的长名词短语（「采用智能化系统的企业」），
 *                          句号化即无谓语残句，原守卫只管 ≤4 字短残片，10 字的它得以放行。
 *
 * 每组都配一条"仍应放行"的反向断言：这两条守卫的失败模式都是**过度否决**
 *（把正常可切的分句也否掉 = 白丢劈句机会），光有正向断言是永真式。
 */
describe("C 类切分守卫（2026-09-30）", () => {
  it("后半句：承接性副词 + 谓语（无体标记）→ 否决", () => {
    expect(fragmentCanStand("也能决定一整天的节奏")).toBe(false);
    expect(fragmentCanStand("正在成为转型路上的三块硬骨头")).toBe(false);
    expect(fragmentCanStand("将推动整个行业重新洗牌")).toBe(false);
  });

  it("后半句：自带主语的副词句 → 仍放行（别把守卫写成一刀切）", () => {
    expect(fragmentCanStand("也有很多企业失败了")).toBe(true);
    expect(fragmentCanStand("正在推进的项目已经过半")).toBe(true);
    // 普通主谓句不受影响
    expect(fragmentCanStand("这套工艺已经成熟量产了")).toBe(true);
  });

  it("前半句：「的+名词」长名词短语 → 否决", () => {
    expect(fragmentFrontCanStand("数据显示，采用智能化系统的企业")).toBe(false);
    expect(fragmentFrontCanStand("报告指出，参与试点的机构")).toBe(false);
  });

  it("前半句：有真谓语（体标记/双字谓词）的分句 → 仍放行", () => {
    // 「了」是体标记 → 是动宾分句，不是名词短语
    expect(fragmentFrontCanStand("公司采用了新的技术")).toBe(true);
    // 「提升」是双字谓词
    expect(fragmentFrontCanStand("这次调整提升了整体的效率")).toBe(true);
    // 既有行为：完整小句照常放行
    expect(fragmentFrontCanStand("这件事有三个原因：趋势已经很明显了")).toBe(true);
  });

  it("谓语判据不得退化成单字宽表（两次踩坑的回归闸门）", () => {
    // 「智**能**化」含「能」、「机**会**」含「会」——单字情态表会把这类纯名词短语
    // 误判成"有谓语"，守卫形同虚设（实测：加了守卫签名仍 119/119 不动）。
    // 这条断言钉死"名词内部嵌情态单字时仍须判为无谓语"。
    expect(fragmentFrontCanStand("数据显示，采用智能化系统的企业")).toBe(false);
    expect(fragmentFrontCanStand("统计表明，抓住转型机会的企业")).toBe(false);
  });
});

/**
 * 碎片句的落位约束（burstiness.ts 的 boostBurstiness）
 *
 * 碎片（"就这样。""你懂的。"）是把 CV 拉出 AI 均匀带的主力，但落位有硬约束：
 * **绝不能落在序号句/因果句上或紧邻它们**。源码注释记着理由：
 * 「塞在序号句/因果句与其承接句之间，会在论证链上切出断口，
 *   读感像被人中途插了句不相干的话」。
 *
 * 实现是**顺延到下一个安全位**，不是直接放弃——因为少插会让节奏
 * 重新落回 AI 均匀带（scan-bugs v5.3 会报警）。只有全篇都是逻辑句时
 * 才彻底放弃（slot === -1 → continue）。
 */
describe("碎片句落位：避开序号句/因果句", () => {
  const rng = () => 0.5; // 固定，探针实测结果确定
  const run = (t: string) => boostBurstiness(t, rng, 1);

  it("全是普通句 → 碎片按候选表顺序插入", () => {
    // 探针实测：「就这样。」「你懂的。」依次落在第 3、5 句
    expect(run("甲乙丙丁戊。己庚辛壬癸。子丑寅卯辰。巳午未申酉。戌亥子丑寅。甲乙丙丁。")).toBe(
      "甲乙丙丁戊。己庚辛壬癸。就这样。子丑寅卯辰。巳午未申酉。你懂的。戌亥子丑寅。甲乙丙丁。",
    );
  });

  it("序号句在场时碎片顺延到下一个安全位（不落在逻辑句上或紧邻）", () => {
    // 探针实测（rng 恒 0.5、p=1）：插入的是**第二个候选「你懂的。」**而不是
    // 第一个「就这样。」——因为原文里已经有一个「就这样。」，候选去重会跳过它
    // （见下一条用例）。落点在第 3 句之后：前两句是逻辑句（「首先…」「其次…」），
    // 碎片既没落在逻辑句上，也没夹在逻辑句与它的承接句之间。
    const out = run(
      "首先要做的是甲乙丙。戊己庚辛壬。其次是子丑寅卯辰。巳午未申酉戌。就这样。甲乙丙丁。",
    );
    expect(out).toContain("你懂的。");
    expect(out).toContain("巳午未申酉戌。你懂的。");
    // 逻辑句本身原样保留
    expect(out).toContain("首先要做的是甲乙丙。");
    expect(out).toContain("其次是子丑寅卯辰。");
  });

  it("全文都是逻辑句时彻底放弃插入（slot === -1）", () => {
    // 探针实测：原样返回，一个碎片都没加
    const allLogic = "首先甲乙丙。其次丁戊己。最后庚辛壬子丑寅卯辰。";
    expect(run(allLogic)).toBe(allLogic);
  });

  it("原文中已有的碎片不会被重复插入", () => {
    // 探针实测：原文里的「就这样。」占了第 1 个候选，
    // 下一个候选「你懂的。」被插到别处，第 3 个「说白了。」也被用到——不重复
    const out = run("就这样。甲乙丙丁戊。己庚辛壬癸。子丑寅卯辰。巳午未申酉。");
    expect(out).toBe("就这样。甲乙丙丁戊。你懂的。己庚辛壬癸。子丑寅卯辰。说白了。巳午未申酉。");
    // 断言每个碎片只出现一次
    for (const f of ["就这样。", "你懂的。", "说白了。"]) {
      expect(out.split(f).length - 1, f).toBe(1);
    }
  });

  it("CV 已达标时早退，一个碎片都不加", () => {
    // 覆盖率报告指出 line 67 的「条件为真就 return」那半边从未执行——
    // 因为上面几条语料都是**全等长**（CV = 0），永远低于阈值。
    // 这里要造 CV 高于 MIN_BURSTINESS_CV 的语料，验证早退路径。
    // ⚠️ 第一版用「第N句话…」30 句，探针实测**它仍然会被改写**（长度差异不够大），
    // 说明那条语料的 CV 没顶过阈值。改用长短悬殊的句子。
    const varied =
      "短。这一句刻意写得很长很长很长很长很长很长很长。中。这一句也很长很长很长很长长短。短。";
    expect(run(varied)).toBe(varied);
  });

  it("逻辑句在句中时，anchorAt(i) 这一项也要被求值", () => {
    // line 86 的 `anchorAt(i - 1) || anchorAt(i)`：上面几条语料里逻辑句都在句首，
    // 于是 anchorAt(i-1) 恒命中、第二项 `anchorAt(i)` 因短路从未被求值。
    // 这里把逻辑句放到中间，逼出短路的那一侧。
    // 探针实测：碎片没有落在「其次…」那句上或紧邻它。
    const out = run(
      "甲乙丙丁戊。己庚辛壬癸。其次是子丑寅卯辰。巳午未申酉戌。甲乙丙丁戊。己庚辛壬癸。",
    );
    expect(out).not.toBe(
      "甲乙丙丁戊。己庚辛壬癸。其次是子丑寅卯辰。巳午未申酉戌。甲乙丙丁戊。己庚辛壬癸。",
    );
    // 逻辑句原文保留
    expect(out).toContain("其次是子丑寅卯辰。");
    // 且碎片不与它相邻（前后都不挨着逻辑句）
    const sents = out.split("。").filter(Boolean);
    const logicIdx = sents.findIndex((s) => s.includes("其次"));
    expect(sents[logicIdx - 1]).not.toMatch(/^(就这样|你懂的|说白了)/);
    expect(sents[logicIdx + 1]).not.toMatch(/^(就这样|你懂的|说白了)/);
  });
});

/**
 * 句尾锚点注入的三条收口（burstiness.ts 的 boostBurstinessIfLow）
 *
 * 这层管的是「往句子里插语气锚点」，两个失败模式是实测出来的病句：
 *   ① 「不信嗯？」——问句前挂锚，语体错位
 *   ② 「挑战哈对哦。啊。。就这样。」——句末标点前插锚却没去掉锚自带的句号
 * 两条都是「插了才知道错」，所以守卫必须在插之前拦。
 */
describe("句尾锚点注入收口", () => {
  // rng 恒为 0 → 每次都取候选表第一个，结果确定可断言
  const rng = () => 0;
  const UNIFORM = "这件事很清楚。事情确实这样。别的也差不多。结论很明白。数据不会骗人。";

  it("均匀长句（CV 低）→ 注入锚点提高 CV", () => {
    const out = boostBurstinessIfLow(UNIFORM, rng, 1.0);
    expect(out).not.toBe(UNIFORM);
    expect(out.endsWith("对哦。嗯。")).toBe(true); // 探针实测
  });

  it("问句/感叹句不被挂锚（语体错位防线）", () => {
    // 探针实测：含「吗？」和含「！」的语料，句末问号/感叹号原样保留，
    // 锚点只挂到后面的普通句上——问句自带节奏突变，不需要锚。
    for (const [q, e] of [
      ["这件事值得思考吗？", "？"],
      ["这件事真的惊人！", "！"],
    ] as const) {
      const text = q + "事情确实这样。别的也差不多。结论很清楚。数据不会骗人。";
      const out = boostBurstinessIfLow(text, rng, 1.0);
      expect(out, q).toContain(e); // 问号/感叹号仍在
      expect(out, q).not.toContain(q.replace(/[？！]$/, "") + "嗯" + e); // 没被挂锚
    }
  });

  it("句末标点前插锚不产生「。。」（双句号防线）", () => {
    // 源码注释记的实测病句：「挑战哈对哦。啊。。就这样。」
    const out = boostBurstinessIfLow(UNIFORM, rng, 1.0);
    expect(out).not.toContain("。。");
    expect(out).not.toContain("。。。");
  });

  it("单轮只注入一次（锚点表不重复消耗）", () => {
    // 探针实测：4/6/10/20 句等长文本，无论长度，注入次数**恒为 1**，
    // 输出长度恒 +5。所以 235 行那个 `if (!fresh.length) break` 在单轮调用下
    // 走不到——usedAnchors 每轮新建，候选表远大于一轮的需求。
    // 这条钉的是「不重复注入」这个真实性质，而不是我一开始以为的
    // 「锚点用尽会 break」——那个假设探针直接否掉了。
    for (const n of [4, 6, 10, 20]) {
      const text = Array.from({ length: n }, () => "甲乙丙丁戊己庚。").join("");
      const out = boostBurstinessIfLow(text, rng, 1.0);
      expect((out.match(/对哦。嗯。/g) || []).length, `${n} 句`).toBe(1);
      expect(out.length - text.length, `${n} 句`).toBe(5);
    }
  });

  it("已足够参差的长文本不注入（CV 达标就不动）", () => {
    // 反向对照：探针实测 30 句「第N句话内容差不多啊。」**完全不注入**——
    // 长度有差异 ⇒ CV 达标 ⇒ 第 67 行直接 return。
    const long = Array.from({ length: 30 }, (_, i) => `第${i}句话内容差不多啊。`).join("");
    expect(boostBurstinessIfLow(long, rng, 1.0)).toBe(long);
  });
});

/**
 * 替换层守卫（humanize-guard.ts 的 judgeGuardBlocks）
 *
 * 与上面那些「切句守卫」不同，这一层管的是**能不能替换某个词**：
 * 技术文本里中文动词与英文标识符/数字/路径紧邻时，替换后极易产出
 * "不帮 CommonJS"、"预搭阶段" 这类语义错误。
 *
 * 探针实测的对照（intensity 0.9 + zhuqueMode，seed 固定）：
 *   「优化 CommonJS」→「调好 CommonJS」  ← 放行
 *   「优化CommonJS」 → 原样不动        ← before 末尾是 ASCII，守卫拦下
 */
describe("混排守卫：中文动词紧贴 ASCII 标识符时不替换", () => {
  const run = (s: string) => humanize(s, { intensity: 0.9, zhuqueMode: true, seed: 42 });

  it("带空格 → 正常替换", () => {
    expect(run("优化 CommonJS")).not.toBe("优化 CommonJS");
    expect(run("优化 CommonJS")).toContain("CommonJS"); // 标识符本身必须完好
  });

  it("紧贴 ASCII → 整个替换被拦下，原样返回", () => {
    expect(run("优化CommonJS")).toBe("优化CommonJS");
  });

  it("守卫不区分 ASCII 的具体种类（字母/点/斜杠/数字/下划线/连字符）", () => {
    // 判据是单个字符类 /[A-Za-z0-9._\-/]$/，所以这些都该被拦
    for (const s of ["优化CommonJS", "优化node.js", "优化a/b", "优化v2", "优化a_b", "优化a-b"]) {
      expect(run(s)).toBe(s);
    }
  });

  it("守卫不误伤：不含英文的普通中文照样被改写", () => {
    // 这条防的是「守卫扩大到所有句子」的退化写法。
    // 探针实测（seed 42）：「我们要持续优化这项工作」→「我们要始终调好这项工作」。
    // 另一条对照：「这个方案很不错」实测**不变**——短句里没有可替换的目标，
    // 不是守卫拦的，所以不能拿它当「会被改写」的样本。
    expect(run("我们要持续优化这项工作")).toBe("我们要始终调好这项工作");
  });
});
