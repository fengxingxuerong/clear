/**
 * typos.test.ts —— 错别字注入层（v0.9.8 起**默认停用**）的可测化回归。
 *
 * 背景：injectHumanTypos 里 `TYPO_INJECTION_ENABLED=false` 把实现主体短路在第 40 行，
 * 导致 30 行"保留以备回滚"的实现永远走不到（行覆盖 14.7%、分支 5.6%）。
 * 2026-10-05 把主体抽成 injectTyposImpl(text, rng, intensity, enabled) 之后，
 * 本文件同时锁两件事：
 *   ① **生产路径一个字节都不能变**——默认开关必须在消费任何 rng 之前短路；
 *   ② 保留体的规则表、预算、场景块保真、门限公式仍然按原样工作，
 *      否则真要回滚那天打开开关换出来的就是没人验证过的实现。
 */
import { describe, it, expect } from "vitest";
import { injectHumanTypos, injectTyposImpl } from "./typos.ts";

/** 脚本化 rng：按队列出数并记录每次消费，用于断言「早退不烧 rng」与调用次数 */
function scriptedRng(values: number[]) {
  expect(values.length, "脚本不能为空").toBeGreaterThan(0);
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

/** 全 0：门限必过、下标必取 0、pick 必取首元素 */
const zeroRng = () => scriptedRng([0]);

/** 任何一次调用都让测试失败——用来证明「开关/早退短路在逻辑之前」 */
function forbiddenRng(): number {
  throw new Error("此处不应消费 rng");
}

describe("injectHumanTypos（生产开关 TYPO_INJECTION_ENABLED=false）", () => {
  const samples = [
    "",
    "这的问题他慢慢地看请在说一次",
    "【场景：办公室 日】的问题",
    "别作作事工作做法然后再在说",
  ];

  it("任何输入原样返回，且一次 rng 都不消费", () => {
    for (const s of samples) {
      expect(injectHumanTypos(s, forbiddenRng, 1)).toBe(s);
      expect(injectHumanTypos(s, forbiddenRng, 0.7)).toBe(s);
    }
  });

  it("与 injectTyposImpl(enabled=false) 完全等价（抽离前后行为一致）", () => {
    for (const s of samples) {
      expect(injectTyposImpl(s, forbiddenRng, 1, false)).toBe(s);
    }
  });
});

describe("injectTyposImpl（enabled=true，驱动保留体）", () => {
  it("intensity<0.7 早退：不改字、不消费 rng；0.7 是可注入边界", () => {
    const src = "这的问题";
    expect(injectTyposImpl(src, forbiddenRng, 0.69, true)).toBe(src);

    const { rng, calls } = scriptedRng([0]);
    expect(injectTyposImpl(src, rng, 0.7, true)).toBe("这地问题");
    expect(calls).toHaveLength(3); // 门限 + 下标 + pick
  });

  it("门限公式 Math.min(0.55, 0.25 + intensity*0.35)：卡在阈值上跳过、阈值下注入", () => {
    const src = "这的问题";
    // intensity 0.7 → 阈值 0.495
    const skipAt07 = scriptedRng([0.5]);
    expect(injectTyposImpl(src, skipAt07.rng, 0.7, true)).toBe(src);
    expect(skipAt07.calls).toHaveLength(1); // 门限不过，后续下标/pick 不消费

    const hitAt07 = scriptedRng([0.4]);
    expect(injectTyposImpl(src, hitAt07.rng, 0.7, true)).toBe("这地问题");
    expect(hitAt07.calls).toHaveLength(3);

    // intensity 1.0 → 0.6 被 0.55 封顶：0.56 跳过、0.54 注入（证明 min 生效）
    const skipAt10 = scriptedRng([0.56]);
    expect(injectTyposImpl(src, skipAt10.rng, 1, true)).toBe(src);
    expect(skipAt10.calls).toHaveLength(1);

    const hitAt10 = scriptedRng([0.54, 0, 0]); // 只有门限这一跳用 0.54，下标/pick 归 0
    expect(injectTyposImpl(src, hitAt10.rng, 1, true)).toBe("这地问题");
    expect(hitAt10.calls).toHaveLength(3);
  });

  it("TYPO_MAX_GLOBAL=2 全局预算：五条规则全命中也只改前两处，且第 3 条起不再消费 rng", () => {
    // 五条规则各命中一次：的/地/在/做/作
    const src = "这种方法的问题，他慢慢地看，请在说一次，他做为，他作事";
    const { rng, calls } = scriptedRng([0]);
    const out = injectTyposImpl(src, rng, 1, true);

    expect(out).toBe("这种方法地问题，他慢慢的看，请在说一次，他做为，他作事");
    expect(calls).toHaveLength(6); // 前两条各 3 次（门限+下标+pick），第 3 条整条 break
    expect(out).not.toBe(src);
    // 预算用完后的三条规则原样保留
    expect(out).toContain("请在说一次");
    expect(out).toContain("他做为");
    expect(out).toContain("他作事");
  });

  it("场景块保真：【场景…】行内的命中不替换，行外照常替换", () => {
    const src = "【场景：办公室 日】的问题\n这也是的问题";
    const { rng, calls } = scriptedRng([0]);
    const out = injectTyposImpl(src, rng, 1, true);

    expect(out).toBe("【场景：办公室 日】的问题\n这也是地问题"); // 场景行逐字保留
    expect(calls).toHaveLength(3);
  });

  it("只有场景行命中时：无候选 → 原样返回且不消费 rng", () => {
    const src = "【场景：办公室 日】的问题";
    expect(injectTyposImpl(src, forbiddenRng, 1, true)).toBe(src);
  });

  it("【】里没有场景关键字就不算场景块，命中照常替换", () => {
    const src = "【备注：这的问题】";
    const { rng, calls } = scriptedRng([0]);
    expect(injectTyposImpl(src, rng, 1, true)).toBe("【备注：这地问题】");
    expect(calls).toHaveLength(3);
  });

  it("五条规则各自的正向替换（rng 全 0 → 取首个候选、pick 首元素）", () => {
    const cases: [string, string][] = [
      ["这的问题", "这地问题"], // 1 的→地
      ["慢慢地看", "慢慢的看"], // 2 地→的
      ["请在说一次", "请再说一次"], // 3 在→再
      ["他做为", "他作为"], // 4 做→作
      ["他作事", "他做事"], // 5 作→做
    ];
    for (const [src, want] of cases) {
      const { rng, calls } = scriptedRng([0]);
      expect(injectTyposImpl(src, rng, 1, true), src).toBe(want);
      expect(calls, src).toHaveLength(3);
    }
  });

  it("lookbehind 回退：前面是的/地得、在/再、做/作 时不命中，一次 rng 都不消费", () => {
    const noHits = [
      "取得的方式", // 的 前是「得」→ 规则1 拦
      "说的地看", // 地 前是「的」→ 规则2 拦（的 本身无候选）
      "然后再在说", // 在 前是「再」→ 规则3 拦
      "工作做法", // 做 前是「作」→ 规则4 拦（作 无候选）
      "别作作事", // 第二个 作 前是「作」→ 规则5 拦
    ];
    for (const s of noHits) {
      expect(injectTyposImpl(s, forbiddenRng, 1, true), s).toBe(s);
    }
  });

  it("多处命中：下标由 rng 决定选第几处，且同输入同 rng 结果可复现", () => {
    const src = "这的问题和那的结果";

    const first = scriptedRng([0, 0, 0]);
    const outA1 = injectTyposImpl(src, first.rng, 1, true);
    expect(outA1).toBe("这地问题和那的结果");
    expect(first.calls).toHaveLength(3);

    const second = scriptedRng([0, 0.99, 0]); // floor(0.99*2)=1 → 第二个候选
    const outB1 = injectTyposImpl(src, second.rng, 1, true);
    expect(outB1).toBe("这的问题和那地结果");
    expect(second.calls).toHaveLength(3);

    // 确定性复现
    expect(injectTyposImpl(src, scriptedRng([0, 0, 0]).rng, 1, true)).toBe(outA1);
    expect(injectTyposImpl(src, scriptedRng([0, 0.99, 0]).rng, 1, true)).toBe(outB1);
    expect(zeroRng().calls).toHaveLength(0); // 记录器本身不预支调用
  });
});
