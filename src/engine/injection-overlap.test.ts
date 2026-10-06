import { describe, it, expect } from "vitest";
import { humanize, mechanicalShuffle } from "../engine/humanize";

/**
 * 注入叠加类签名门禁（v0.9.24）
 *
 * 对应 `scripts/defect-taxonomy.ts` 的 **「注入叠加」** 类别：
 *
 *   垫词复读 / 双垫词 / 垫词接连接词双开头
 *
 * ## 为什么这一类要单独开测试文件
 *
 * 三条签名原本只在 `scan-bugs.ts` 里跑，而那用的是**另一套语料**
 * （v8.0 的 4 段）。本文件用同一套语料 × 4 档 × 30 种子 × 2 管线
 * 跑 **960 次**，覆盖面比 scan-bugs 那次大得多（scan-bugs 只跑 humanize，
 * 本文件同时跑 mechanicalShuffle——**反指纹层的注入器在后者里**）。
 *
 * ## 为什么必须做缺陷注入验证（这轮的关键）
 *
 * 第一版探针扫出来三条全 0。但「0 处」有两种可能：
 *   ① 真的干净
 *   ② 探针没跑到那条路径（方法论第 19 条）
 *
 * 注入验证结论（实测）：
 *
 *   | 签名 | 注入前 | 注入后 | 判定 |
 *   |---|---|---|---|
 *   | 垫词复读 | 0 | **480** | 敏感 |
 *   | 垫词接连接词 | 0 | **165** | 敏感 |
 *   | 双垫词 | 0 | 0 | 注入形态不匹配（非不敏感，见下） |
 *
 * 「双垫词」注入后仍 0，是因为注入的是**同一个**垫词，而签名要求
 * **两个垫词紧邻**。直接构造「讲真，讲真，」证明它能命中（下方正对照）。
 *
 * ## 这一轮踩的坑（值得记）
 *
 * 第一次注入打了三处都**没生效**，连打两次：
 *   · 第 1590 行 —— 那是 `humanizeWithScore` 的出口，不是 `humanize`
 *   · 第 1101 行 —— 那是 `applyZhuqueFeatures` 的出口
 *   · 第 975 行  —— ✅ 才是 `humanize`
 *
 * `humanize.ts` 里有三个同形状的 `return result;`，**光看代码看不出是哪个函数**。
 * 排查办法：先写一行探针确认「注入到底生效没有」——
 *   humanize(「这是一个测试句子。第二个。」) 里含不含「说真的」？
 * 不含 ⇒ 注入点选错，不是探针不敏感。
 *
 * > **缺陷注入必须先验证注入本身生效**，否则会把「打错位置」误读成「探针不敏感」。
 */

// ✅ 逐字抄自 scan-bugs.ts:326-352。改这里必须同步改那边，否则两处口径分叉。
const PADS = [
  "说真的",
  "其实",
  "说实话",
  "按我的经验",
  "老实讲",
  "讲真",
  "说白了",
  "你别说",
  "要我说",
  "话又说回来",
  "平心而论",
  "客观讲",
  "往实了说",
  "不瞒你说",
  "说句掏心窝的",
  "细想下",
  "反正",
  "拢共",
  "一句话",
  "简说",
  "这么看",
  "照这么说",
  "值得注意的是",
  "总而言之",
  "综上所述",
];

/** 与 scan-bugs.ts:353 的 doublePad 完全一致 */
const DOUBLE_PAD = new RegExp(`(?:${PADS.join("|")})，(?:${PADS.join("|")})，`);

/** 与 scan-bugs.ts:361-363 的「垫词接连接词双开头」完全一致 */
const PAD_CONNECTIVE =
  /(要我说|说真的|说实话|讲真|客观讲|平心而论)，(这期间|另一头|同时，|更要紧的是|还有一点|这么一来)/;

/** 与 scan-bugs.ts:1010-1026 的 V8_CORPUS 逐字一致 */
const CORPUS: [string, string][] = [
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

const INTENSITIES = [0.3, 0.6, 0.9, 1.0] as const;
const SEEDS = Array.from({ length: 30 }, (_, i) => i);

describe("注入叠加类签名", () => {
  it("垫词不得复读：同一垫词出现 >1 次即违规", () => {
    const hits: string[] = [];
    for (const [label, text] of CORPUS) {
      for (const intensity of INTENSITIES) {
        for (const seed of SEEDS) {
          for (const [pipe, out] of [
            ["humanize", humanize(text, { intensity, seed })],
            ["shuffle", mechanicalShuffle(text, { intensity, seed })],
          ] as const) {
            for (const w of PADS) {
              const c = out.split(w + "，").length - 1;
              if (c > 1) hits.push(`${pipe}/${label}/i${intensity}/s${seed} [${w}]x${c}`);
            }
          }
        }
      }
    }
    expect(
      hits,
      `${hits.length} 处垫词复读（960 次运行）：\n  ${hits.slice(0, 8).join("\n  ")}`,
    ).toEqual([]);
  });

  it("双垫词不得相邻：「垫词，垫词，」即违规", () => {
    const hits: string[] = [];
    for (const [label, text] of CORPUS) {
      for (const intensity of INTENSITIES) {
        for (const seed of SEEDS) {
          for (const [pipe, out] of [
            ["humanize", humanize(text, { intensity, seed })],
            ["shuffle", mechanicalShuffle(text, { intensity, seed })],
          ] as const) {
            if (DOUBLE_PAD.test(out)) {
              hits.push(`${pipe}/${label}/i${intensity}/s${seed}: ${out.slice(0, 90)}`);
            }
          }
        }
      }
    }
    expect(
      hits,
      `${hits.length} 处双垫词（960 次运行）：\n  ${hits.slice(0, 8).join("\n  ")}`,
    ).toEqual([]);
  });

  it("垫词不得接连接词双开头：「垫词，同时，」即违规", () => {
    const hits: string[] = [];
    for (const [label, text] of CORPUS) {
      for (const intensity of INTENSITIES) {
        for (const seed of SEEDS) {
          for (const [pipe, out] of [
            ["humanize", humanize(text, { intensity, seed })],
            ["shuffle", mechanicalShuffle(text, { intensity, seed })],
          ] as const) {
            if (PAD_CONNECTIVE.test(out)) {
              hits.push(`${pipe}/${label}/i${intensity}/s${seed}: ${out.slice(0, 90)}`);
            }
          }
        }
      }
    }
    expect(
      hits,
      `${hits.length} 处垫词接连接词（960 次运行）：\n  ${hits.slice(0, 8).join("\n  ")}`,
    ).toEqual([]);
  });

  /**
   * 正反对照：**缺了它，上面三条可能是永真式签名而没人知道**。
   *
   * `scan-bugs.ts` 里 v7.0 有「探针自检」（最小复现输入不得命中签名），
   * 但注入叠加这三条**没有**。这里补上双向的：
   *   · 正对照：目标形态必须命中 ⇒ 证明正则本身还活着
   *   · 反对照：非目标形态必须不命中 ⇒ 证明它不是「见啥都中」
   *
   * ⚠️ 反向对照里 `padConn` 的「说实话，这期间很忙」是 **true**，
   *   而且这是**正确的**——垫词 + 「这期间」确实是目标形态。
   *   所以反对照只取那些右邻不在那 6 个连接词里的例子。
   */
  it("正反对照：签名本身活着，且不是永真式", () => {
    // 正对照：必须命中
    expect(DOUBLE_PAD.test("讲真，讲真，"), "doublePad 对「讲真，讲真，」应命中").toBe(true);
    expect(DOUBLE_PAD.test("说实话，要我说，还是再想想吧。"), "doublePad 对异词相邻应命中").toBe(
      true,
    );
    expect(PAD_CONNECTIVE.test("说实话，要我说，这期间"), "padConn 应命中").toBe(true);
    expect(PAD_CONNECTIVE.test("要我说，另一头"), "padConn 对短连接词应命中").toBe(true);

    // 反对照：必须不命中
    expect(DOUBLE_PAD.test("今天天气不错，阳光明媚。"), "doublePad 不该命中普通句").toBe(false);
    expect(
      PAD_CONNECTIVE.test("说实话，要我说，这件事"),
      "padConn 的右邻不是那 6 个连接词时不应命中",
    ).toBe(false);
    expect(PAD_CONNECTIVE.test("这件事很重要。"), "padConn 不该命中普通句").toBe(false);
  });
});
