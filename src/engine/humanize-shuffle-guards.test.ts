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
    ["归结起来", "归结起来，人工智能正在深刻改变教育行业，首先可以实现个性化学习，其次能减轻教师负担。"],
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
    const s = "远程办公在过去三年里普及得非常快，员工的时间安排随之变了，企业也开始重新评估固定工位的必要性。";
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
