/**
 * humanize-guard.ts —— 替换层护栏（judgeGuardBlocks / guardBlocks）的直接测试。
 *
 * 为什么单独立文件：此前这个守卫网**只有间接覆盖**
 * （humanize-shuffle-guards.test.ts:483 通过调用方验证），
 * guardBlocks 本身没有任何直接用例。下面几条都是「写错了会静默产出病句」的分支：
 * 拦截一旦失效，替身会直接流进正文，用户看见的是"不帮 CommonJS"这种句子。
 */
import { describe, expect, it } from "vitest";
import { VERB_PHRASE_AFTER, MEDIUM_NOUN_AFTER, guardBlocks } from "./humanize-guard.ts";
import { humanize } from "./humanize.ts";
import { VOCAB } from "./humanize-vocab.ts";

/**
 * 混排守卫（行 184-188）
 *
 * 命中词紧贴 ASCII 标识符/数字/路径符时，替换后会产出「不帮 CommonJS」
 * 「预搭阶段」这类语义错误。探针实测真值见各用例注释。
 */
describe("混排守卫：命中词紧邻 ASCII 就跳过（行 187-188）", () => {
  it("前置以 ASCII 结尾一律拦（字母/数字/点/下划线/连字符/斜杠）", () => {
    const cases: [string, string][] = [
      ["字母", "优化CommonJ"],
      ["数字", "提升20"],
      ["点", "优化 node."],
      ["下划线", "优化 a_"],
      ["连字符", "优化 well-"],
      ["斜杠（路径）", "配置 /usr/lo"],
    ];
    for (const [label, before] of cases) {
      expect(guardBlocks("优化", "把这事", before), label).toBe(true);
    }
  });

  it("前置以中文或标点结尾则放行（不误拦）", () => {
    // 探针实测：这两条都是 false——守卫不是「见中文就拦」
    expect(guardBlocks("优化", "把这事", "我们要好好优化这")).toBe(false);
    expect(guardBlocks("优化", "把这事", "我们要优化这。")).toBe(false);
    expect(guardBlocks("优化", "把这事", "")).toBe(false);
  });

  it("后接词以 ASCII 开头同样拦（行 188）", () => {
    for (const ctx of ["CommonJS 的", "node.js 环境", "20% 的提升", "/usr/local 路径"]) {
      expect(guardBlocks("优化", ctx, ""), ctx).toBe(true);
    }
    // 中文起头不拦
    expect(guardBlocks("优化", "这事的", "")).toBe(false);
  });
});

/**
 * 「通过」+ 名词化动词短语的紧邻判据（行 238-245）
 *
 * 「通过」可带动词短语宾语，而单音节替身「靠/借/用」后不能直接跟动词短语——
 * 「通过引入视觉检测系统」→「借引入视觉检测系统」是病句（实测 113/120 命中）。
 *
 * 判据必须是**紧邻**而非 8 字窗口包含：后者会把
 * 「通过各部门协作，效率得到提升」里的「提升」也算中（实测 17/20 误跳过）。
 */
describe("「通过」动词短语紧邻守卫（行 245）", () => {
  it("命中：from=通过 且后接词紧邻名词化动词", () => {
    // 探针实测真值：这五个 ctx 全部 guard=true
    for (const ctx of ["引入新技术", "采用新方案", "实现自动化", "推动落地", "加强管理"]) {
      expect(VERB_PHRASE_AFTER.test(ctx), `正则侧 ${ctx}`).toBe(true);
      expect(guardBlocks("通过", ctx, ""), `守卫侧 ${ctx}`).toBe(true);
    }
  });

  it("不命中：动词短语不紧邻时放行（这是紧邻判据的意义）", () => {
    // 探针实测 false false——「持续优化」「部门协作」都不在 VERB_PHRASE_AFTER 词表里
    for (const ctx of ["持续优化", "部门协作"]) {
      expect(VERB_PHRASE_AFTER.test(ctx), ctx).toBe(false);
      expect(guardBlocks("通过", ctx, ""), ctx).toBe(false);
    }
  });

  it("from 不是「通过」时，同一个 ctx 也不拦（判据按词定制）", () => {
    // 对照组：证明 245 行的 `from === "通过"` 与短路求值都不是摆设
    expect(guardBlocks("基于", "引入新技术", "")).toBe(false);
    expect(guardBlocks("采用", "引入新技术", "")).toBe(false);
  });

  /**
   * ⚠️ 源码注释与实现的一处出入，实测记录在案。
   *
   * 行 8 的注释写「**必须紧邻匹配**（不加"的"字结构容错——"通过引入的方式"
   * 里的"引入"是名词性的，替身反而可通）」，但行 11 的正则是
   *   /^(?:引入|采用|…)/   ——**没有**「的?」可选量。
   *
   * 探针实测：guardBlocks("通过", "引入的方式", "") === true，**照样被拦**。
   *
   * 方向是保守的（多拦一次而不是漏拦），不构成缺陷，故不改实现；
   * 但注释与实现不一致会误导后来人，所以在此钉住实测口径。
   */
  it("「引入的方式」实测仍被拦——注释说该放行，但正则没有「的?」容错", () => {
    expect(VERB_PHRASE_AFTER.test("引入的方式")).toBe(true);
    expect(guardBlocks("通过", "引入的方式", "")).toBe(true);
  });
});

/**
 * 「通过」媒介名词的**替身降级**（v0.9.41，MEDIUM_NOUN_AFTER + humanize.ts 降级逻辑）。
 *
 * 与上面 VERB_PHRASE_AFTER 的处理方式不同：那条是"跳过替换"，本条是
 * 「靠/借 → 用」的降级（"用短信通知"是通顺的，跳过白丢一次去味）。
 * 所以这里测的是**正则判据**（哪些 ctx 该触发降级），端到端行为由
 * scan-bugs 的「媒介名词配崩」探针兜底。
 */
describe("「通过」媒介名词替身降级（v0.9.41）", () => {
  it("命中：具体媒介/渠道名词（靠短信/靠邮件 崩坏）", () => {
    for (const ctx of ["短信通知", "邮件发送", "电话联系", "微信沟通", "手机App完成"]) {
      expect(MEDIUM_NOUN_AFTER.test(ctx), ctx).toBe(true);
    }
  });

  it("不命中：抽象依托对象照常轮换替身（靠数据分析/靠努力 是合法的）", () => {
    // 这组是降级判据**必须收窄**的证据：把"数据分析"一起降级 = 白白丢掉
    // 「靠数据分析」「借不懈的努力」这些成立的口语变体。
    for (const ctx of ["数据分析", "不懈的努力", "各部门协作", "反复权衡"]) {
      expect(MEDIUM_NOUN_AFTER.test(ctx), ctx).toBe(false);
    }
  });

  it("紧邻判据：媒介词隔了字不算（窗口包含判据会误伤），放行", () => {
    // 真实上下文 = 替换点后 8 字。"通过各部门协作，用短信通知用户"的 context 是
    // "各部门协作，用短信"——「短信」在第 7 字位，若用 GUARD_AFTER 的窗口包含判据
    // 会被误拦（这是 VERB_PHRASE_AFTER 踩过的同一课）。
    expect(MEDIUM_NOUN_AFTER.test("各部门协作，用短信")).toBe(false);
  });
});

describe("名词位替身守卫：前缀「的」即跳过（行 193）", () => {
  it("前置以「的」结尾拦下（名物化修饰结构）", () => {
    expect(guardBlocks("突破", "在于这个", "实现的")).toBe(true);
  });
});

describe("形式动词语槽守卫（行 199）", () => {
  it("前置是进行/予以/加以（含「了」）时跳过替换", () => {
    for (const before of ["进行了", "进行", "予以了", "加以了", "予以"]) {
      expect(guardBlocks("优化", "这件事", before), before).toBe(true);
    }
  });
});

describe("关注/重视 的固定搭配守卫（行 203-205）", () => {
  it("前置是受到/得到/予以/备受（含不超过 4 字状语）时拦下", () => {
    for (const before of ["受到", "得到", "予以", "备受", "受到广泛", "得到充分的"]) {
      expect(guardBlocks("关注", "这件事", before), before).toBe(true);
    }
  });
  it("前置无关时不拦（对照）", () => {
    expect(guardBlocks("关注", "这件事", "我们")).toBe(false);
  });
});

describe("「落地」只能站谓语位（行 215-219）", () => {
  it("前置含使役/助动词 → 谓语位，允许替换（不拦）", () => {
    expect(guardBlocks("落地", "这件事", "推动方案")).toBe(false);
    expect(guardBlocks("落地", "这件事", "加快")).toBe(false);
  });
  it("前置是定语成分 → 定语位，拦下", () => {
    // 源码注释给的实证：「在产业落地层面」被拒绝替换
    expect(guardBlocks("落地", "这件事", "在产业")).toBe(true);
    expect(guardBlocks("落地", "这件事", "")).toBe(true);
  });
});

/**
 * v0.9.50 三条新守卫（由 scripts/realcase 扩语料抓出，每条都有真实产出作证据）
 *
 * 收录顺序 = 严重程度：**改写事实** > 病句 > 语体崩。
 */
describe("v0.9.50 新增守卫", () => {
  it("书名号里的文件标题一字都不得替换（改一个字就是篡改事实）", () => {
    const TITLE = "现将《合肥市智能制造成熟度评估实施细则》印发给你们。";
    for (let seed = 1; seed <= 12; seed++) {
      const out = humanize(TITLE, { intensity: 0.9, seed, genre: "main" });
      expect(out, `seed=${seed}`).toContain("《合肥市智能制造成熟度评估实施细则》");
    }
    // 对照组：同一个词出了书名号照样要换，否则等于"看见《》就整体免改"
    const PLAIN = "公司制定了详细实施细则，请各部门遵照执行。";
    const changed = [1, 2, 3, 4, 5, 6, 7, 8].some(
      (seed) => humanize(PLAIN, { intensity: 0.9, seed, genre: "main" }) !== PLAIN,
    );
    expect(changed, "书名号外的同一词条必须还能被改写").toBe(true);
  });

  it("叠字守卫：替身不得与紧随其后的原文重复（「生态环境」→「环境环境」）", () => {
    const SRC = "由生态环境主管部门责令改正。";
    for (let seed = 1; seed <= 12; seed++) {
      const out = humanize(SRC, { intensity: 0.9, seed, genre: "main" });
      expect(out, `seed=${seed}`).not.toContain("环境环境");
    }
  });

  it("规范性从句不补「了」（「请结合实际认真贯彻落实」不该写成已完成）", () => {
    const CLAUSES = [
      "请结合实际认真贯彻落实。",
      "企业应当按照排污许可证的要求排放污染物。",
      "本细则自印发之日起三十日后施行。",
    ];
    for (const c of CLAUSES) {
      for (let seed = 1; seed <= 8; seed++) {
        const out = humanize(c, { intensity: 0.9, seed });
        const addedLe = /[^了]*[^。！？]了。/.test(out) && !c.includes("了");
        expect(addedLe, `${c} seed=${seed} 产出：${out}`).toBe(false);
      }
    }
  });

  it("对照：论文叙述里的正常完成态仍要保留（别把「了」一刀切）", () => {
    // 这条守的是"上面那条守卫被写成体裁级开关"的过矫正——
    // 正式体裁里也有完全正常的完成态，砍掉它们是把时态整体抹平。
    const NARRATIVE = "我们提出该方法并在三个数据集上验证了效果。";
    const anyLe = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].some((seed) =>
      humanize(NARRATIVE, { intensity: 0.9, seed }).includes("了"),
    );
    expect(anyLe).toBe(true);
  });

  it("并列复合词只替半边 ⇒ 整处跳过替换（「贯彻落实」→「照做落实」）", () => {
    const SRC = "请结合实际认真贯彻落实。";
    for (let seed = 1; seed <= 12; seed++) {
      const out = humanize(SRC, { intensity: 0.9, seed, genre: "main" });
      expect(out, `seed=${seed}`).toContain("贯彻落实");
    }
    // 守卫必须可直接验证：这条 guarantee 是这条缺陷的唯一 enforce 点
    expect(guardBlocks("贯彻", "落实发展理念", "认真")).toBe(true);
  });

  it("共享：定语位置的替身必须是能进定语槽的那一个（不是动宾短语）", () => {
    const SRC = "使共享表征逐步具备领域不变性。";
    for (let seed = 1; seed <= 12; seed++) {
      const out = humanize(SRC, { intensity: 0.9, seed });
      expect(out, `seed=${seed}`).not.toContain("一起用");
    }
    expect(VOCAB["共享"]).not.toContain("一起用");
  });
});
