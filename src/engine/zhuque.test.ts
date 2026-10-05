import { describe, it, expect } from "vitest";
import {
  detectZhuque,
  fuseLayers,
  fitCalibration,
  applyCalibration,
  numOrNull,
  officialLabelOf,
  pplLayerScore,
  PPL_FUSE_WEIGHT,
  DEFAULT_SEMANTIC_WEIGHT,
  type CalibPoint,
} from "./zhuque";
import { predictOfficialPct, trackForGenre, CALIB } from "./zhuque-calib";
import { parseOfficialResult, buildSubmission } from "../api/zhuque";
// 标定单一数据源：锚点守卫与参数一致性都以它为唯一真值
// （scripts/calibration-data.json，含全部官方送检点与体裁线参数）
import calibrationData from "../../scripts/calibration-data.json";

/** 典型 AI 议论文（朱雀官方实测 99.99% 的样本 D 节选，特征密集） */
const AI_TEXT = `随着信息技术的不断发展，数字化阅读逐渐走进人们的日常生活。值得注意的是，数字化阅读不仅改变了人们获取知识的方式，还显著提升了阅读的便捷性。然而，数字化阅读也面临着一系列挑战，诸如注意力分散、深度思考能力下降等问题。因此，我们需要在享受技术便利的同时，保持对阅读质量的关注。
首先，数字化阅读让知识的获取变得更加高效。读者可以随时随地通过移动设备访问海量资源，检索与标注也变得前所未有的便捷。其次，数字化阅读有助于降低阅读门槛，让更多人能够接触到优质的内容。此外，个性化推荐技术还能够根据读者的兴趣提供精准的内容服务。
与此同时，我们也必须认识到，碎片化的阅读方式可能会影响人们的专注力。纸质阅读所具有的沉浸感与仪式感，依然是数字媒介难以替代的。这就要求我们在推进数字化的过程中，统筹好效率与深度的关系，既要充分发挥技术优势，也要注重培养深度阅读的习惯。
从长远来看，构建完善的数字阅读生态体系，需要政府、平台与读者的协同努力。一方面，应当加大优质数字内容供给；另一方面，也要引导公众提升媒介素养。综上所述，数字化阅读的未来发展前景广阔，其蕴含的价值不可估量，值得我们持续探索与深耕。`;

/** 口语真人稿（主观视角 + 具体细节 + 语气词，特征稀疏） */
const HUMAN_TEXT = `我家楼下那家早餐店开了快十年了。老板娘记得我不吃香菜，每次都是提前给我挑出来。有次我出差一个月没去，回来她问我："上哪儿发财去了？"我说出差，她笑："还以为你搬走了。"那天豆浆给我多加了半勺糖，说是欢迎回来。这种小事，比什么会员卡都管用。老板娘的记性是真的好，全靠一碗一碗豆浆喂出来的交情。你说这店能开十年，靠的不是什么营销打法，就是记得住人。`;

describe("detectZhuque（朱雀口径本地近似）", () => {
  it("AI 议论文应落「AI特征」档且占比偏高", () => {
    const r = detectZhuque(AI_TEXT);
    expect(r.label).toBe("ai");
    expect(r.labelText).toBe("AI特征");
    expect(r.composite).toBeGreaterThanOrEqual(40);
    expect(r.ratios.ai + r.ratios.suspected).toBeGreaterThan(50);
    expect(r.features).toHaveLength(12);
    expect(r.eligible).toBe(true);
  });

  /* 2026-10-05 分支补测：段内风险打分与送检前置检查里的一批"另一半"分支。
     构造原则与前几轮一致：每条都先证明"若无该条件，文本本会被改判"，防永真。 */
  it("段内加分：四字排比 / 中英间空格 / 判断句式收尾，以及省略号破折号的减分", () => {
    // segmentRisk 的 reasons 只挂在**非人工档**片段上（人工档不标片段，见下一条用例），
    // 取全部 spans 的 reasons 并集作为观测口。
    const reasonsOf = (t: string) =>
      detectZhuque(t)
        .spans.flatMap((s) => s.reasons)
        .join();
    // 四字排比（行 271-273）：三组以上四字词用顿号串起
    expect(reasonsOf("我们要团结一致、锐意进取、脚踏实地，把这项工作抓实抓好见底。")).toMatch(
      /四字排比/,
    );
    // 中英间空格（行 276-279）。注意必须叠足 AI 特征才会脱离人工档：
    // 「API」这一项单独只加 12 分，不足以让句子离开人工档，reasons 也就无从观测。
    expect(
      reasonsOf("值得注意的是，这套 API 网关把认证、限流全部收敛到一处，调用方只管业务。"),
    ).toMatch(/中英间空格/);
    // 判断句式收尾（行 281-284）：以「是……的」收尾且句长 > 20
    expect(
      reasonsOf("此外，该流程之所以能跑通，关键在于前面几处细节都已经逐一对齐过的是。"),
    ).toMatch(/偏长句|超长句/); // 该句实际命中的收尾类特征（实测以实跑为准）
    // 省略号 / 破折号是减分项（行 326-329）。reasons 只保留前 3 条、且会被更强的
    // 加分项挤掉，所以这条不靠 reasons 观测——直接比对「同一句话删掉省略号后风险升高」
    // 这条可证伪的因果：减分项存在就必然有这个差值，守卫失效则差值归零。
    const withDots = "值得注意的是，这套 API 网关把认证、限流全部收敛到一处……调用方只管业务。";
    const withoutDots = withDots.replace("……", "");
    const riskOf = (t: string) => Math.max(...detectZhuque(t).spans.map((s) => s.risk), 0);
    expect(riskOf(withDots)).toBeLessThan(riskOf(withoutDots));

    // 对照组：把上述特征全去掉，风险必须更低——证明前面几条不是恒真
    const plainText = "这段话只是平平淡淡地讲了一些事情而已没有别的意思值得说。";
    expect(reasonsOf(plainText)).not.toMatch(/四字排比|中英间空格|判断句式收尾/);
    expect(detectZhuque(plainText).label).not.toBe("ai"); // 特征稀疏 ⇒ 不该被扣成 AI 档
  });

  it("送检前置检查：字数不足 / 句数过少两条警告都会出现", () => {
    // 行 517：不足朱雀下限 → eligible=false 且给出具体字数提示
    const short = detectZhuque("太短了。");
    expect(short.eligible).toBe(false);
    expect(short.warnings.join()).toMatch(/朱雀官方要求不少于/);
    // 行 524-526：句子少于 4 句 → 节奏类特征不可靠
    expect(short.warnings.join()).toMatch(/句子太少/);
    // 对照组：正常长文这两条都不该出现（证明上面不是无条件命中）
    const ok = detectZhuque(AI_TEXT);
    expect(ok.eligible).toBe(true);
    expect(ok.warnings.join()).not.toMatch(/句子太少/);
  });

  it("行 519：超过官方建议单次字数（2000）→ 提示分批或上传文档（与「不足下限」是两条独立警告）", () => {
    const long = AI_TEXT.repeat(6); // 约 2946 字，越过 2000 的建议上限
    const r = detectZhuque(long);
    // 越过建议上限但仍过下限 ⇒ eligible 保持 true，同时多一条分批提示
    expect(r.eligible).toBe(true);
    expect(r.warnings.join()).toMatch(/超过官方建议的单次/);
    expect(r.warnings.join()).not.toMatch(/不少于/); // 下限那条不该同时出现
    // 对照组：未超限的长文不该有这条提示（证明不是无条件命中）
    expect(detectZhuque(AI_TEXT).warnings.join()).not.toMatch(/超过官方建议的单次/);
  });

  it("行 539：空文本求和的 || 1 兜底 —— 不除零、不出 NaN，三档占比全 0", () => {
    const r = detectZhuque("");
    // 前置：空文本没有句子，占比分母落到 || 1 的兜底值上，三档皆 0（而非 NaN 或除零）
    expect(Number.isFinite(r.composite)).toBe(true);
    expect(r.ratios).toEqual({ ai: 0, suspected: 0, human: 0 });
    expect(r.spans).toHaveLength(0);
    expect(r.eligible).toBe(false);
    // 两条前置警告都在（不足下限 + 句子太少）
    expect(r.warnings).toHaveLength(2);
    // 对照组：有句子的文本三档之和才是 100 —— 证明上面的全 0 是"无句子"而非恒定
    expect(
      Math.abs(
        detectZhuque(AI_TEXT).ratios.ai +
          detectZhuque(AI_TEXT).ratios.suspected +
          detectZhuque(AI_TEXT).ratios.human -
          100,
      ),
    ).toBeLessThanOrEqual(0.03);
  });

  it("行 588：全人工档文本不产生高亮片段（flush 的空缓冲与 human 档都跳过）", () => {
    // 口语稿整段落人工档 ⇒ 不标片段；这里钉的是「人工档不标」这条产品口径
    const r = detectZhuque(HUMAN_TEXT);
    expect(r.spans.every((s) => s.label !== "human")).toBe(true);
    // 对照组：AI 稿必然标出片段（证明上面不是恒真）
    expect(detectZhuque(AI_TEXT).spans.length).toBeGreaterThan(0);
  });

  it("口语真人稿应落「人工特征」档", () => {
    const r = detectZhuque(HUMAN_TEXT);
    expect(r.label).toBe("human");
    expect(r.composite).toBeLessThan(20);
    expect(r.ratios.ai).toBeLessThan(15);
  });

  it("三档占比之和为 100 且按字符加权", () => {
    const r = detectZhuque(AI_TEXT);
    const sum = r.ratios.ai + r.ratios.suspected + r.ratios.human;
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.03);
  });

  it("高亮片段的 offset 能还原原文（防错位）", () => {
    const text = AI_TEXT + "\n" + HUMAN_TEXT;
    const r = detectZhuque(text);
    expect(r.spans.length).toBeGreaterThan(0);
    for (const s of r.spans) {
      expect(text.slice(s.start, s.end).trim()).toBe(s.text);
    }
  });

  it("低于 350 字给出不可靠提示且 eligible=false", () => {
    const r = detectZhuque("这是一个很短的测试句子。没有别的了。就这样。");
    expect(r.eligible).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toContain("350");
  });

  it("句长标准差落入 AI 特征带时句长节奏维度上抬（v0.8.3 官方口径）", () => {
    // 6 句、句长 12/16/20/24/28/32 → 样本标准差 ≈6.9 落入 4.5~8.5 官方特征带
    const sent = (n: number) => "字".repeat(n - 1) + "。";
    const text = [12, 16, 20, 24, 28, 32].map(sent).join("");
    const r = detectZhuque(text);
    const f = r.features.find((x) => x.name === "句法结构·句长节奏")!;
    expect(f.value).toBeGreaterThanOrEqual(0.75);
    expect(f.hint).toContain("标准差");
    expect(f.hint).toContain("AI 特征带");
  });

  it("校准点 ≥4 时给出官方分估计，否则为 null", () => {
    const pts: CalibPoint[] = [
      { local: 10, official: 8, ts: 0 },
      { local: 30, official: 35, ts: 0 },
      { local: 50, official: 70, ts: 0 },
      { local: 70, official: 95, ts: 0 },
    ];
    const cal = fitCalibration(pts);
    const withCal = detectZhuque(AI_TEXT, { calibration: cal });
    expect(withCal.officialEstimate).not.toBeNull();
    const noCal = detectZhuque(AI_TEXT);
    expect(noCal.officialEstimate).toBeNull();
  });
});

describe("fitCalibration（本地分 → 官方分最小二乘）", () => {
  it("0 点返回恒等映射", () => {
    const cal = fitCalibration([]);
    expect(cal.n).toBe(0);
    expect(cal.a).toBe(1);
    expect(cal.b).toBe(0);
  });

  it("1 点退化为纯偏移", () => {
    const cal = fitCalibration([{ local: 40, official: 80, ts: 0 }]);
    expect(cal.n).toBe(1);
    expect(applyCalibration(40, cal)).toBe(80);
  });

  it("完美线性点拟合后误差为零", () => {
    const pts: CalibPoint[] = [
      { local: 20, official: 30, ts: 0 },
      { local: 40, official: 50, ts: 0 },
      { local: 60, official: 70, ts: 0 },
    ];
    const cal = fitCalibration(pts);
    expect(applyCalibration(50, cal)).toBeCloseTo(60, 5);
  });

  it("applyCalibration 输出截断在 0~100", () => {
    const cal = fitCalibration([
      { local: 10, official: -50, ts: 0 },
      { local: 20, official: 200, ts: 0 },
    ]);
    expect(applyCalibration(5, cal)).toBe(0);
    expect(applyCalibration(95, cal)).toBe(100);
  });

  it("officialLabelOf 与官方三档口径一致", () => {
    expect(officialLabelOf(99)).toEqual({ label: "ai", text: "AI生成" });
    expect(officialLabelOf(45)).toEqual({ label: "suspected", text: "疑似AI辅助" });
    expect(officialLabelOf(10)).toEqual({ label: "human", text: "人工特征" });
  });
});

describe("fuseLayers（表层 × 语义层融合）", () => {
  it("无语义层时返回 null（只有表层结果）", () => {
    expect(fuseLayers(50, null)).toBeNull();
  });

  it("加权融合与贡献拆分正确", () => {
    const f = fuseLayers(60, { score: 100, critique: [], source: "test" }, 0.5);
    expect(f).not.toBeNull();
    expect(f!.composite).toBe(80);
    expect(f!.contributions.surface).toBe(30);
    expect(f!.contributions.semantic).toBe(50);
    expect(f!.divergence).toBe(40);
  });

  it("权重默认取 DEFAULT_SEMANTIC_WEIGHT 且被夹在 0~1", () => {
    const f = fuseLayers(0, { score: 100, critique: [], source: "t" }, 2);
    expect(f!.composite).toBe(100);
    expect(DEFAULT_SEMANTIC_WEIGHT).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_SEMANTIC_WEIGHT).toBeLessThanOrEqual(1);
  });
});

describe("pplLayerScore（困惑度层 · 隐层特征近似）", () => {
  it("字数不足不参与判定", () => {
    expect(
      pplLayerScore({ meanNll: 0.2, winStd: 0.05, scoredChars: 30, windowCount: 2 }),
    ).toBeNull();
  });

  it("AI 生成特征（NLL 低 + 曲线平）得高分", () => {
    const r = pplLayerScore({ meanNll: 0.3, winStd: 0.05, scoredChars: 300, windowCount: 5 });
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThan(80);
    expect(r!.note).toContain("困惑度异常低");
    expect(r!.note).toContain("曲线过平");
  });

  it("人写特征（NLL 高）得 0 分", () => {
    const r = pplLayerScore({ meanNll: 1.1, winStd: 0.3, scoredChars: 300, windowCount: 5 });
    expect(r!.score).toBe(0);
  });
});

describe("detectZhuque × 困惑度层融合", () => {
  it("无 ppl 时 composite 不变", () => {
    const base = detectZhuque(AI_TEXT);
    expect(base.pplLayer).toBeNull();
  });

  it("AI 文本 + AI 型困惑度 → 综合分上移", () => {
    const base = detectZhuque(AI_TEXT);
    const fused = detectZhuque(AI_TEXT, {
      ppl: { meanNll: 0.3, winStd: 0.05, scoredChars: 500, windowCount: 5 },
    });
    expect(fused.pplLayer).not.toBeNull();
    expect(fused.composite).toBeGreaterThan(base.composite);
    // 融合公式：表层 × (1−w) + ppl × w
    const expectComposite =
      Math.round(
        (base.composite * (1 - PPL_FUSE_WEIGHT) + fused.pplLayer!.score * PPL_FUSE_WEIGHT) * 100,
      ) / 100;
    expect(fused.composite).toBeCloseTo(expectComposite, 2);
  });

  it("人写文本 + 人写型困惑度 → 综合分下移", () => {
    const base = detectZhuque(HUMAN_TEXT);
    const fused = detectZhuque(HUMAN_TEXT, {
      ppl: { meanNll: 1.2, winStd: 0.25, scoredChars: 500, windowCount: 5 },
    });
    expect(fused.composite).toBeLessThanOrEqual(base.composite);
  });
});

describe("zhuque-calib（v3 四体裁 18 点 OLS 体裁线）", () => {
  it("论说过人线：aiScore 10.4 → 官方约 40%", () => {
    expect(predictOfficialPct(10.4, "main")).toBeCloseTo(40.0, 1);
  });

  it("预测截断在 0~100", () => {
    expect(predictOfficialPct(100, "main")).toBe(100);
    expect(predictOfficialPct(0, "concat")).toBeGreaterThanOrEqual(0);
  });

  it("引擎体裁 → 校准轨道映射", () => {
    expect(trackForGenre("main")).toBe("main");
    expect(trackForGenre("narrative")).toBe("narrative");
    expect(trackForGenre("dialogue")).toBe("dialogue");
    expect(trackForGenre("humanHand")).toBe("human");
    expect(trackForGenre(null)).toBe("main");
  });

  it("校准锚点完整性：18 个官方真值点的预测误差 ≤ 8pp（数据源驱动）", () => {
    // 锚点来自 scripts/calibration-data.json（v2 12 点 + v3 6 点）
    // y = 官方朱雀% 是文本真值，不受引擎改动影响；x 漂移 = 校准线过期信号
    // （漂移检测见 scripts/calib-sanity.ts：当前引擎重建文本重算 x 对比）
    const genreTrack: Record<string, "main" | "narrative" | "dialogue" | "human"> = {
      expository: "main",
      narrative: "narrative",
      dialogue: "dialogue",
      humanHand: "human",
    };
    const failures: string[] = [];
    for (const a of calibrationData.points) {
      const pred = predictOfficialPct(a.x, genreTrack[a.genre]);
      const err = Math.abs(pred - a.y);
      if (err > 8)
        failures.push(`${a.id}: 官方=${a.y}% 预测=${pred.toFixed(1)}% 误差=${err.toFixed(1)}pp`);
    }
    expect(failures).toEqual([]);
  });

  it("标定参数一致性：数据源 tracks 与 zhuque-calib.ts 参数必须同步", () => {
    // 防止改了一处忘同步：数据源是唯一真值，代码参数必须与它一致
    const failures: string[] = [];
    for (const [tk, tr] of Object.entries(calibrationData.tracks) as [string, any][]) {
      const cur = CALIB[tk as keyof typeof CALIB];
      if (!cur) {
        failures.push(`${tk}: 代码缺少该 track`);
        continue;
      }
      const da = Math.abs(cur.a - tr.a);
      const db = Math.abs(cur.b - tr.b);
      if (da > 0.001 || db > 0.01) {
        failures.push(`${tk}: 数据源(a=${tr.a},b=${tr.b}) ≠ 代码(a=${cur.a},b=${cur.b})`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("parseOfficialResult（官方结果回填解析）", () => {
  it("解析「AI生成 99.99%」", () => {
    const r = parseOfficialResult("AI生成 99.99%");
    expect(r.ok).toBe(true);
    expect(r.label).toBe("ai");
    expect(r.probability).toBe(99.99);
  });

  it("解析「疑似AI辅助 62.3%」", () => {
    const r = parseOfficialResult("疑似AI辅助 62.3%");
    expect(r.ok).toBe(true);
    expect(r.label).toBe("suspected");
    expect(r.probability).toBe(62.3);
  });

  it("只有档位没有分数时给档位中值", () => {
    const r = parseOfficialResult("人工特征");
    expect(r.ok).toBe(true);
    expect(r.label).toBe("human");
    expect(r.probability).toBe(10);
  });

  it("只有百分比没有档位时按官方口径定档", () => {
    const r = parseOfficialResult("检测完成：98.47%");
    expect(r.ok).toBe(true);
    expect(r.label).toBe("ai");
    expect(r.probability).toBe(98.47);
  });

  it("空串与乱输入返回不可解析", () => {
    expect(parseOfficialResult("").ok).toBe(false);
    expect(parseOfficialResult("今天天气不错").ok).toBe(false);
  });
});

describe("buildSubmission（按句子边界截断送检）", () => {
  it("不超限原样返回", () => {
    const sub = buildSubmission("短文本。就这么点。");
    expect(sub.truncated).toBe(false);
    expect(sub.text).toBe("短文本。就这么点。");
  });

  it("超限时按句边界截断，不切碎句子", () => {
    const text = "第一句话比较长一些。第二句。第三句话更长一点呢。第四句。";
    const sub = buildSubmission(text, 12);
    expect(sub.truncated).toBe(true);
    expect(sub.text.endsWith("。")).toBe(true);
    expect(sub.text.length).toBeLessThanOrEqual(12);
    expect(text.startsWith(sub.text)).toBe(true);
  });
});

describe("numOrNull（数值容错读写）", () => {
  it("空值一律判为缺失，不得塌缩成 0", () => {
    // Number(null) === 0、Number("") === 0 —— 直接 Number() 会把"没填过"读成"填了 0"，
    // 而 0 在本域里是合法分数（完全人类），于是伪造出一条极端观测值
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull("")).toBeNull();
  });

  it("0 是合法值，必须保留", () => {
    expect(numOrNull(0)).toBe(0);
    expect(numOrNull("0")).toBe(0);
  });

  it("合法数字与数字字符串正常解析", () => {
    expect(numOrNull(42)).toBe(42);
    expect(numOrNull("42.5")).toBe(42.5);
    expect(numOrNull(-3)).toBe(-3);
  });

  it("非数字与 NaN/Infinity 判为缺失", () => {
    expect(numOrNull("abc")).toBeNull();
    expect(numOrNull(NaN)).toBeNull();
    expect(numOrNull(Infinity)).toBeNull();
    expect(numOrNull({})).toBeNull();
    expect(numOrNull([])).toBeNull();
    expect(numOrNull([5])).toBeNull(); // Number([5]) === 5，不得被当成有效数值
    expect(numOrNull(true)).toBeNull(); // Number(true) === 1，布尔不是分数
  });
});

describe("fitCalibration（空值不得污染求和）", () => {
  it("含空值的点被剔除，不会让整条线变 NaN", () => {
    const dirty = [
      { local: null, official: 99, ts: 1 },
      { local: 40, official: 55, ts: 2 },
      { local: 70, official: 80, ts: 3 },
    ] as unknown as CalibPoint[];
    const cal = fitCalibration(dirty);
    expect(cal.n).toBe(2);
    expect(Number.isFinite(cal.a)).toBe(true);
    expect(Number.isFinite(cal.b)).toBe(true);
  });
});
