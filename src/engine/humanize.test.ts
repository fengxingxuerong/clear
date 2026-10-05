import { describe, it, expect } from "vitest";
import {
  humanize,
  applyZhuqueFeatures,
  aiScore,
  humanizeWithScore,
  crossChunkCleanup,
  injectDialect,
} from "./humanize.ts";
import { VOCAB, DIALECT_VOCAB } from "./humanize-data.ts";
import { countPadHeads, PAD_INJECT_CAP } from "./humanize-primitives.ts";
import { restoreMixedSpacing } from "./humanize-shuffle.ts";
import {
  pplIssues,
  PPL_MIN_MEAN_NLL,
  PPL_MAX_WIN_STD,
  PPL_MIN_CHARS,
  PPL_MIN_WINDOWS,
} from "./humanize-metrics.ts";

// 真断言版回归测试：任何失败都让 vitest（以及 npm test / CI）以非零退出码收场，
// 而不是 console.log 冒烟后恒绿。
describe("humanize 引擎", () => {
  it("空/纯空白输入返回空串", () => {
    expect(humanize("")).toBe("");
    expect(humanize("   \n  \t  ")).toBe("");
  });

  it("超短文本透传（v0.9.4：实测「短。」被管线清成空串，数据丢失）", () => {
    expect(humanize("短。")).toBe("短。");
    expect(humanize("好的", { intensity: 0.9, zhuqueMode: true })).toBe("好的");
    // 10 字及以上的正常短句不受守卫影响（不做内容断言，只断非空且包含原词根）
    const out = humanize("这句话有十个字以上了吗", { seed: 1 });
    expect(out.length).toBeGreaterThan(0);
  });

  it("串联迭代不堆积垫词（v0.9.4 P2 跨轮饱和守卫）", () => {
    // 实测迭代 5 轮垫词 12→22→28→35 线性堆积、字数 +89%——
    // 守卫生效后：第二次处理的注入被抑制，垫词计数不得随轮次显著增长
    const sample = `值得注意的是，在当今社会，随着人工智能技术的快速发展，AI 写作工具应运而生。
首先，它能够提升效率。通过自动化的方式，减少重复劳动。其次，它降低了门槛。普通人也能生成可用的文本。最后，它改变了行业。许多岗位被重新定义。
综上所述，这项技术至关重要。它不仅影响当下，还塑造未来。唯有主动拥抱变化，方能行稳致远。`;
    const r1 = humanize(sample, { intensity: 0.9, seed: 20260905, zhuqueMode: true });
    const r2 = humanize(r1, { intensity: 0.9, seed: 20260905, zhuqueMode: true });
    const r3 = humanize(r2, { intensity: 0.9, seed: 20260905, zhuqueMode: true });
    // 饱和守卫：第 2 轮起注入被抑制，垫词数不再单调上涨（允许 ±2 抖动）
    expect(countPadHeads(r2)).toBeLessThanOrEqual(countPadHeads(r1) + 2);
    expect(countPadHeads(r3)).toBeLessThanOrEqual(countPadHeads(r2) + 2);
    // 字数不随迭代注水（旧实现 3 轮 +40%+）
    expect(r3.replace(/\s/g, "").length).toBeLessThanOrEqual(r1.replace(/\s/g, "").length * 1.2);
  });

  it("countPadHeads 基础口径", () => {
    expect(countPadHeads("正常的文本没有垫词。")).toBe(0);
    expect(countPadHeads(`你懂的。就这么回事。`)).toBe(2);
    expect(PAD_INJECT_CAP).toBeGreaterThan(5);
  });

  it("坏替身回归：Phase1 实测病句不得复现（v0.9.5 P4 词表清理+GUARD 长搭配）", () => {
    // 以下病句全部在 Phase1 实测中出现（测试报告附 1）
    const cases: Array<[string, string]> = [
      ["为职业发展注入源源不断的动力", "源源接连"], // 不断→接连 腰斩成语
      ["发挥日益重要的作用", "起渐渐"], // 发挥→起 与 日益→渐渐 相撞
      ["发挥日益重要的作用", "施展渐渐"], // 删"起"后双替身仍相撞 → GUARD 整组保护
      ["满足日常需求", "合上"], // 满足→合上 缺搭配
      ["同时关注上下文中的其他词语", "盯住不放上下文"], // 盯住不带宾语
      ["为您的使用安全保驾护航", "安全护住"], // 保驾护航→护住 丢搭配
    ];
    for (const [input, bad] of cases) {
      const out = humanize(input, { intensity: 0.9, seed: 20260905, zhuqueMode: true });
      expect(out).not.toContain(bad);
    }
  });

  it("双语气词折叠：呀呀/嘛嗯式堆叠不复现（v0.9.5 P4）", () => {
    const sample =
      "值得注意的是，随着技术的发展，很多事物都在变化。综上所述，我们需要认真对待。这不仅关乎当下，也关乎未来。值得深思。";
    const out = humanize(sample, { intensity: 0.9, seed: 20260905, zhuqueMode: true });
    expect(out).not.toMatch(/([哦呵啧呣诶呀嘛呢吧啊嗯])\1/); // 相邻重复（呀呀/嘛嘛）
    expect(out).not.toMatch(/([哦呵啧呣诶呀嘛呢吧啊嗯])[哦呵啧呣诶呀嘛呢吧啊嗯]+[。，]/); // 相邻异形（嘛嗯/呢呵）
  });

  it("纯英文不崩溃且产出非空", () => {
    const out = humanize("This is a test. Notably, AI tools are important.", { seed: 1 });
    expect(out.length).toBeGreaterThan(0);
  });

  it("强度 0 保持原文不变（v0.8.6 语义：intensity<=0 严格短路）", () => {
    const sample = "值得注意的是，在当今社会，随着人工智能技术的快速发展，AI 写作工具应运而生。";
    const out = humanize(sample, { intensity: 0, seed: 42 });
    // v0.8.6 之前，强度 0 会漏掉 stripCJKEdgeSpaces 等确定性清理（中英文间空格被清掉、
    // 连接词被 stripLeadingConnectivesHard 删掉）——语义与"强度 0 = 保持原文"不符。
    // 现在入口直接短路：所有 pass 都不运行，包括确定性清理。
    expect(out).toBe(sample);
    // 替身词不出现在输出
    expect(out).not.toMatch(/说起来|有意思的是|要我说/);
  });

  it("强度提升后套话命中不增（去味后 aiScore ≤ 原文）", () => {
    const sample = `值得注意的是，在当今社会，随着人工智能技术的快速发展，AI 写作工具应运而生。
综上所述，人工智能技术至关重要，它不仅极大地提升了内容生产的效率，而且有效地降低了创作门槛。`;
    const before = aiScore(sample);
    const after = aiScore(humanize(sample, { intensity: 0.9, seed: 7 }));
    expect(after.score).toBeLessThanOrEqual(before.score);
  });

  it("固定种子结果可复现", () => {
    const sample = "综上所述，人工智能技术至关重要，它不仅极大地提升了效率，而且降低了门槛。";
    const a = humanize(sample, { intensity: 0.6, seed: 42 });
    const b = humanize(sample, { intensity: 0.6, seed: 42 });
    expect(a).toBe(b);
  });

  it("多段文本保留段落换行", () => {
    const para = "第一段第一句，说点事情。\n\n第二段第一句，再说点别的。";
    const out = humanize(para, { intensity: 0.6, seed: 3 });
    expect(out).toContain("\n");
  });

  it("humanizeWithScore 返回前后评分与去味文本", () => {
    const r = humanizeWithScore("值得注意的是，在当今社会，技术发展很快。", {
      intensity: 0.6,
      seed: 1,
    });
    expect(typeof r.text).toBe("string");
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.before.score).toBeGreaterThanOrEqual(0);
    expect(r.after.score).toBeGreaterThanOrEqual(0);
  });

  it("公文套话密集文本去味后套话命中下降", () => {
    const sample2 = `高位推动顶层设计，各地压茬推进、挂图作战，攻坚克难、久久为功。
我们要锚定目标、紧扣主题，牵住牛鼻子、下好先手棋，打通最后一公里、跑出加速度。
通过夯实基础、筑牢防线、厚植优势、盘活资源、补齐短板、锻造长板、擦亮名片，
为高质量发展注入新动能、激发新活力、释放新潜力，凝聚共识、形成合力、拓宽渠道、搭建平台。`;
    const r2 = humanizeWithScore(sample2, { intensity: 0.7, seed: 99 });
    expect(r2.after.formulaicHits).toBeLessThanOrEqual(r2.before.formulaicHits);
  });
});

describe("crossChunkCleanup（LLM 长文分块拼接反指纹兜底）", () => {
  // 模拟三个分块独立去味后拼接：各块"各出现一次"的垫词/破折号/省略号在块边界累积
  const dirty =
    "说真的，第一段内容。讲真，这块很重要。\n\n" +
    "说真的，第二段内容。讲真，这块也一样。\n\n" +
    "另外，第三段。——结果——另外，收尾了……真的……";

  it("垫词跨块去重（每词保留首次）", () => {
    const clean = crossChunkCleanup(dirty);
    for (const w of ["说真的", "讲真"]) {
      expect(clean.split(w + "，").length - 1).toBeLessThanOrEqual(1);
    }
  });

  it("破折号/省略号全文限额为 1", () => {
    const clean = crossChunkCleanup(dirty);
    expect(clean.split("——").length - 1).toBeLessThanOrEqual(1);
    expect(clean.split("……").length - 1).toBeLessThanOrEqual(1);
  });

  it("段首过渡词被清除且正文不受影响", () => {
    const clean = crossChunkCleanup(dirty);
    expect(clean).toContain("第一段内容");
    expect(clean).toContain("第二段内容");
    expect(clean).toContain("第三段");
  });

  it("纯清理不改写：去掉限额类模式后其余文本原样保留", () => {
    const plain = "没有垫词没有超标标点的普通文本。第二句说的也是普通话。";
    expect(crossChunkCleanup(plain)).toBe(plain);
  });
});

describe("数据词典完整性", () => {
  for (const [name, tbl] of Object.entries({ VOCAB, DIALECT_VOCAB })) {
    it(`${name} 无「唯一替身=原词」死项`, () => {
      const dead: string[] = [];
      for (const [from, tos] of Object.entries(tbl)) {
        if (tos.length === 1 && tos[0] === from) dead.push(from);
      }
      expect(dead).toEqual([]);
    });

    it(`${name} 替身数组无重复`, () => {
      const dups: string[] = [];
      for (const [from, tos] of Object.entries(tbl)) {
        const seen = new Set<string>();
        for (const t of tos) {
          if (seen.has(t)) {
            dups.push(`${from}: ${t}`);
          }
          seen.add(t);
        }
      }
      expect(dups).toEqual([]);
    });
  }
});

describe("pplIssues 第 8 项判定", () => {
  const win = { charStart: 0, charEnd: 100, scoredCount: 80, meanNll: 0.5 };
  const base = {
    meanNll: 1.2,
    winStd: 0.3,
    scoredChars: 300,
    windows: [win, { ...win }, { ...win }],
  };

  it("均值通道：meanNll 低于 PPL_MIN_MEAN_NLL 报「困惑度异常低」", () => {
    const issues = pplIssues({ ...base, meanNll: PPL_MIN_MEAN_NLL - 0.01 });
    expect(issues.some((i) => i.name === "困惑度异常低")).toBe(true);
  });

  it("均值通道：人工写作量级（约 1.2 nat）不触发任何问题", () => {
    expect(pplIssues(base)).toHaveLength(0);
  });

  it("平坦通道：窗数达标且 winStd 低于 PPL_MAX_WIN_STD 才报「困惑度曲线过平」", () => {
    const issues = pplIssues({ ...base, winStd: PPL_MAX_WIN_STD / 2 });
    expect(issues.map((i) => i.name)).toContain("困惑度曲线过平");
  });

  it("平坦通道：窗口数不足时不判", () => {
    const few = { ...base, windows: base.windows.slice(0, PPL_MIN_WINDOWS - 1) };
    expect(pplIssues(few)).toHaveLength(0);
  });

  it("短文（低于 PPL_MIN_CHARS）静默跳过", () => {
    expect(pplIssues({ ...base, scoredChars: PPL_MIN_CHARS - 1, meanNll: 0 })).toHaveLength(0);
  });
});

describe("restoreMixedSpacing（v0.8.9 LLM 稿空格回填）", () => {
  const orig = "从 Webpack 迁移到 Vite，包含 1200 个模块。";
  it("原文带空格排版 → 回填被 LLM 压掉的空格", () => {
    const out = restoreMixedSpacing(orig, "从Webpack迁移到Vite，包含1200个模块。");
    expect(out).toBe("从 Webpack 迁移到 Vite，包含 1200 个模块。");
  });
  it("中文标点后不插空格（初版 bug：产出'， 1200 个模块'）", () => {
    const out = restoreMixedSpacing(orig, "我们有个项目，1200个模块。Vite很快。");
    expect(out).not.toMatch(/[，。；：、]\s/);
    expect(out).toContain("，1200 个模块");
  });
  it("原文不带空格 → 原样返回，不擅自加空格", () => {
    const noSpace = "从Webpack迁移到Vite。";
    expect(restoreMixedSpacing(noSpace, "从Webpack迁移到Vite。")).toBe("从Webpack迁移到Vite。");
  });
  it("幂等：已有空格不重复插入", () => {
    const once = restoreMixedSpacing(orig, "从Webpack迁移到Vite");
    expect(restoreMixedSpacing(orig, once)).toBe(once);
  });
});

describe("softenPassive（被动软化白名单）", () => {
  // 每例都给两句：引擎对极短文本有闸门，单句会被原样返回，测不到这条规则
  const cases: [string, string][] = [
    ["这种方法很新。这种方法被广泛使用于医疗诊断。", "被广泛使用于"],
    ["这款产品卖得好。该产品受到广泛关注。", "受到广泛关注"],
    ["这套流程跑了两年。方案得到广泛认可。", "得到广泛认可"],
    ["这是个热门方向。这被认为是行业趋势。", "被认为是"],
    ["这块牌子响了十年。它被称之为里程碑。", "被称之为"],
  ];

  it("每条白名单搭配都能被软化（跨种子覆盖全部 5 条）", () => {
    const softened = cases.map(([, cliche]) => {
      for (let seed = 0; seed < 40; seed++)
        if (
          !humanize(cases.find((x) => x[1] === cliche)![0], { intensity: 1, seed }).includes(cliche)
        )
          return true;
      return false;
    });
    expect(softened.every(Boolean)).toBe(true);
  });

  it("不产出搭配病句、主语重复或缺介词的残形", () => {
    for (const [text] of cases) {
      for (let seed = 0; seed < 40; seed++) {
        const o = humanize(text, { intensity: 1, seed });
        expect(/受到广泛留意|得到广泛盯着/.test(o), `搭配病句: ${o}`).toBe(false);
        expect(/它大家|这大家普遍|管它叫/.test(o), `主语重复/回退替身: ${o}`).toBe(false);
        // 整块替换必须带介词"在"；"用得很广"后面跟语气词是合法的，所以正向验前置
        if (o.includes("用得很广"))
          expect(/在[^，。！？\s]{2,14}用得很广/.test(o), `缺介词: ${o}`).toBe(true);
      }
    }
  });

  it("「被认为是」软化后系词仍在，判断句不残缺", () => {
    const t = "这是个热门方向。这被认为是行业趋势。";
    for (let seed = 0; seed < 40; seed++) {
      const o = humanize(t, { intensity: 1, seed });
      if (!o.includes("被认为是")) expect(/是/.test(o), `丢了系词: ${o}`).toBe(true);
    }
  });

  it("非白名单的被动搭配一律不碰（宁缺毋滥）", () => {
    const t = "这套方法很常用。他得到了提高，也受到启发，被广泛应用在工业界。";
    for (let seed = 0; seed < 20; seed++) {
      const o = humanize(t, { intensity: 1, seed });
      expect(o).toContain("得到了提高");
      expect(o).toContain("受到启发");
    }
  });
});

describe("标点相撞与搭配病句（UI 实测发现，v0.9.14）", () => {
  // 来源：在真浏览器里点「示例」→「去味」，界面直接印出
  //   「往后看，搞出完善的监管体系，推进可持续发展，。」
  //   「数字化办公非常提高了工作效率」
  // 前者是第 3 步的标点归一跑在 stripAICliches 之前（删掉句尾套话后留下悬空「，」），
  // 后者是 humanize-vocab 把「极大地」换成不能修饰「V+了」的「非常/特别」。
  // aiScore 对这两种残缺都看不见（中位 6 分），所以只能由测试钉住。
  const SAMPLE = `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。
综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。
然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。
从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。
因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的发展。`;

  const run = (intensity: number, zhuqueMode: boolean, seed: number) =>
    humanize(SAMPLE, { intensity, zhuqueMode, seed });

  const SEEDS = Array.from({ length: 40 }, (_, i) => 20260800 + i);

  it("40 种子 × 2 档：不留下任何相撞标点（，。/。。/，，/行首标点）", () => {
    for (const seed of SEEDS) {
      for (const [i, z] of [
        [0.6, false],
        [0.9, true],
      ] as [number, boolean][]) {
        const o = run(i, z, seed);
        expect(o).not.toMatch(/[，、]{2}/);
        expect(o).not.toMatch(/。{2,}/);
        expect(o).not.toMatch(/[，、]。/);
        expect(o).not.toMatch(/(^|\n)[，、。；：]/);
      }
    }
  });

  it("「极大地」的替换项不得产出「非常/特别 + V + 了」这类搭配病句", () => {
    for (const seed of SEEDS) {
      const o = run(0.6, false, seed);
      expect(o).not.toMatch(/(?:非常|特别)[^，。！？\n]{0,4}了/);
    }
  });
});

describe("injectDialect（方言注入，主路径已停用、保留以备回滚）", () => {
  // 源码注释写明「函数本体保留以备回滚，**不要重新接回主路径**」——但它是导出符号，
  // 任何一次回滚都会直接踩上它，所以这里把它当活代码钉住四件事：
  //   ① p<=0 必须短路在任何 rng 消费之前（回滚开关的语义）；
  //   ② 【场景…】块头行必须逐字保留（P8 护栏，方言表里的「从/说/看」会污染块头）；
  //   ③ 每词预算 cap = max(1, min(3, ceil(total*0.25 + p))) 必须真的生效；
  //   ④ 同 rng 同输出（确定性是所有回归基线的前提）。
  // 此前三项行为无任何测试覆盖（humanize.ts 1330-1357 行全红）。

  /** 队列 rng：按序出数并记录每次消费，用于断言「早退零消费」与消费次数 */
  function queueRng(values: number[]) {
    let i = 0;
    const calls: number[] = [];
    const rng = () => {
      const v = values[Math.min(i, values.length - 1)];
      calls.push(v);
      i++;
      return v;
    };
    return { rng, calls };
  }

  const forbidden = (): number => {
    throw new Error("此路径不应消费 rng");
  };

  it("p<=0 原样返回，且一次 rng 都不消费", () => {
    const src = "我从家里出发。";
    expect(injectDialect(src, forbidden, 0)).toBe(src);
    expect(injectDialect(src, forbidden, -0.5)).toBe(src);
    expect(injectDialect("", forbidden, 0)).toBe("");
  });

  it("场景块头行逐字保留，行外正常替换", () => {
    const src = "【场景：从早上八点】\n我从家里出发";
    const { rng, calls } = queueRng([0]);
    const out = injectDialect(src, rng, 1);
    expect(out).toBe("【场景：从早上八点】\n我打家里出发"); // 从 → pick 首项「打」
    expect(calls).toHaveLength(2); // 门限 + pick，场景行零消费
  });

  it("每词预算生效：4 处命中在 p=1 下只改前 2 处（cap = ceil(4*0.25+1) = 2）", () => {
    const src = "从早从晚从左从右";
    const { rng, calls } = queueRng([0]);
    const out = injectDialect(src, rng, 1);
    expect(out).toBe("打早打晚从左从右");
    expect(calls).toHaveLength(4); // 两次替换各消耗 门限+pick
    expect(out.match(/从/g)).toHaveLength(2); // 剩余 2 处按 cap 原样保留
  });

  it("候选按表序取首项，且同 rng 两次运行结果一致", () => {
    const src = "也许会下雨";
    const a = queueRng([0]);
    const b = queueRng([0]);
    const outA = injectDialect(src, a.rng, 1);
    const outB = injectDialect(src, b.rng, 1);
    expect(outA).toBe("或许会下雨"); // 也许 → 候选首项「或许」
    expect(outA).toBe(outB);
    expect(a.calls).toHaveLength(2);
  });

  it("rng 概率门限：不过门限只花 1 次消费且原样跳过，过门限才走 pick", () => {
    const src = "从早从晚从左从右";

    // 全 0.9、p=0.5 → 四处全部跳过：每处恰好 1 次门限消费，pick 零消费
    const skip = queueRng([0.9]);
    expect(injectDialect(src, skip.rng, 0.5)).toBe(src);
    expect(skip.calls).toHaveLength(4);

    // 首处 0 < 0.5 过门限 → pick(0.9) 取下标 2 =「自从」；其余三处 0.9 跳过
    const mixed = queueRng([0, 0.9]);
    expect(injectDialect(src, mixed.rng, 0.5)).toBe("自从早从晚从左从右");
    expect(mixed.calls).toHaveLength(5); // 门限+pick + 3 次跳过门限
  });
});

/* ─────────── 观点垫词注入：剧本格式守卫 + 去重重试 ───────────
 *
 * injectOpinion 有两层此前未被单独钉住的行为：
 *   1) isScriptFormatLine —— 剧本块的说话人标签前绝不能插垫词
 *      （否则「讲真，张总（项目经理）：…」直接破坏剧本格式）；
 *   2) used 去重 —— 同一垫词不得复读，复读是可被统计抓到的机器指纹。
 *
 * 两层都是「静默破坏格式/指纹」类缺陷，所以各自都配一条反向断言：
 * 非剧本行**必须**被注入，否则守卫就写成了「一律不插」的一刀切。
 */
describe("观点垫词注入：剧本格式守卫与去重", () => {
  /** 说话人标签行（剧本格式）——垫词不得插到标签前面 */
  const SCRIPT =
    "张总（项目经理）：说实话这个方案确实有点意思。我个人感觉这套逻辑还挺顺的。以后可以再试试别的办法看看效果如何。整体来说应该没问题。";
  /** 散文文本，探针确认 seed=3/5/7/8/99 会稳定产出垫词 */
  const PROSE =
    "这套方案的整体思路是清楚的。具体的执行步骤也已经列好了。后续跟踪要看数据反馈才靠谱。另外要注意排期安排不能太紧。资源也要提前协调好免得中途卡住。风险点需要单独列出来跟进。";
  /** 垫词池（humanize-zhuque.ts OPINION_PHRASES）——全是「我觉得」型第一人称短语 */
  const PAD =
    /(我觉得|我个人觉得|我感觉|我认为|在我看来|以我的经验|据我观察|按我的理解|我的看法是|我个人的看法|我寻思着|我琢磨着|老实说)/;
  // injectOpinion/injectFragments 只在 applyZhuqueFeatures 的 casual 门控内被调用
  // （行 999-1005），不在 humanize() 主链路——所以直接调 applyZhuqueFeatures。
  const inject = (t: string, seed: number) => applyZhuqueFeatures(t, 1, seed, "casual");

  it("剧本格式行原样保留：说话人标签前不得出现任何垫词", () => {
    // 探针 seed=3 会给散文行注入「我寻思着」；同样内容带上说话人标签后必须不再注入
    expect(inject(PROSE, 3)).toMatch(PAD);
    const scriptOut = inject(SCRIPT, 3);
    // 标签行必须仍以说话人开头——垫词若插在前面会变成「讲真，张总（项目经理）：…」
    expect(scriptOut.split("\n")[0]).toMatch(/^张总（项目经理）/);
  });

  it("对照组：非剧本行确实会被注入垫词（证明守卫按格式生效，不是一律不插）", () => {
    // 同 seed 同强度，散文注入、剧本不注入 —— 差异只来自 isScriptFormatLine 守卫
    expect(inject(PROSE, 3)).toMatch(PAD);
    expect(inject(SCRIPT, 3).split("\n")[0]).not.toMatch(PAD);
  });

  it("同段落内垫词不复读：抽到已用垫词时必须换一句（行 1450 的 used 去重守卫）", () => {
    // 探针实测 seed=3 会产生两个**不同**垫词（我寻思着 / 据我观察）——正是去重的体现：
    // 若守卫失效，同一个垫词会被复读，那是可被统计抓到的机器指纹
    const out = inject(PROSE, 3);
    const pads = [...out.matchAll(new RegExp(PAD, "g"))].map((m) => m[0]);
    expect(pads.length).toBeGreaterThan(1); // 前置：确实注入了多处垫词
    expect(new Set(pads).size).toBe(pads.length); // 无复读
  });
});

/* ─────────── v0.9 P5 学术体冻结表（ACADEMIC_FROZEN） ───────────
 *
 * 这张表此前**一行覆盖都没有**：humanize() 的 style 参数在全部测试里
 * 只出现过 "casual"，academic 分支（行 392/399）从未被执行。
 *
 * 它守的是一条产品口径：书面语体 + 口语替身 = 错位签名。学术体下
 * 「持续改善」不能换成「一直调顺」。所以这条用例的对照组必须是
 * casual——同一 seed 同一强度下两体裁输出必须不同，否则冻结表形同虚设。
 */
describe("学术体冻结表：口语替身在 academic 下不得生效", () => {
  const OPTS = { intensity: 1.0, seed: 7 } as const;
  /** 冻结表里的源词 + 一个 casual 下确实会换掉的对照 */
  const CASES = [
    { src: "我们需要持续改善整体效率。", frozen: "持续" },
    { src: "由此可见，认知水平有待提升。", frozen: "认知" },
    { src: "与此同时，配套措施也在逐步完善。", frozen: "逐步" },
  ];

  it("academic 保留书面源词，casual 换成口语替身（同 seed 同强度）", () => {
    for (const { src, frozen } of CASES) {
      const academic = humanize(src, { ...OPTS, style: "academic" });
      const casual = humanize(src, { ...OPTS, style: "casual" });
      // 学术体必须保留源词本身
      expect(academic, `academic 应保留「${frozen}」：${academic}`).toContain(frozen);
      // 而 casual 确实换掉了它 —— 否则上条只是因为源词压根没命中替换表（永真）
      expect(casual.includes(frozen), `casual 应换掉「${frozen}」：${casual}`).toBe(false);
    }
  });

  it("对照组：冻结表之外的词两体裁行为一致（证明冻结是按表生效，不是 academic 全停替换）", () => {
    // 「由此可见」不在冻结表里 ⇒ 两体裁都会动它（casual 换替身，academic 走别的删词规则）
    const src = "由此可见，认知水平有待提升。";
    const academic = humanize(src, { ...OPTS, style: "academic" });
    const casual = humanize(src, { ...OPTS, style: "casual" });
    // academic 体仍然在正常改写（不是把替换功能整体关掉），只是不走「口语替身」这一路
    expect(academic).not.toBe(src);
    expect(casual).not.toBe(src);
    // 而两体裁对同一个词给出了不同处理 —— 证明差异来自冻结表本身
    expect(academic).not.toBe(casual);
  });
});
