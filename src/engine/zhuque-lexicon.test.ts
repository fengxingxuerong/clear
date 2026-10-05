/**
 * zhuque-lexicon 共享词表/正则的**防漂移守卫**（v0.9.21）
 *
 * 起因：detector.ts 与 zhuque.ts 曾各自硬编码 5 条特征正则，且 MODAL 已漂移
 * （detector 多 `需要进一步|值得注意的是`）——改一处漏一处是必然事故。
 * v0.9.21 收拢到本文件为单一事实源；此测试是收拢后的守卫，防的不是"现在错了"，
 * 而是"以后又悄悄分叉"。
 *
 * 三条守卫：
 *   1. 正向：5 条特征正则的**字符级内容**必须与预期的单一事实源一致（改了一处
 *      忘了同步测试 → 红）。这条同时防"有人图省事在检测器里再手写一份"。
 *   2. 反向：两个 MODAL 变体的差异**只允许**是那 2 个已登记的词；若哪天差异扩大
 *      （多一个词/少一个词）→ 红，强制走"重拟合标定"的人工判断，不许静默漂移。
 *   3. 自检：守卫本身的"抽取/比对"逻辑失效时也要红——用一个**故意改坏**的副本
 *      跑同一套比对，断言它确实报差异（防空转假绿）。
 */
import { describe, expect, it } from "vitest";
import {
  NOMINAL_SUFFIX,
  rePersonal,
  reConcrete,
  reIdiomLike,
  reModalDetector,
  reModalZhuque,
} from "./zhuque-lexicon";

/** 取正则的 source（不含标志），用于字符级比对 */
const src = (re: RegExp) => re.source;

/** 提取正则里 `(a|b|c)` 形式的交替分支（本文件的 MODAL 就是这种结构） */
function branchesOf(re: RegExp): string[] {
  const m = re.source.match(/^\(([^()]*)\)$/);
  if (!m) throw new Error(`不是单层交替正则，无法抽取分支：${re.source}`);
  return m[1].split("|");
}

describe("zhuque-lexicon 特征正则：单一事实源守卫", () => {
  it("[守卫1-正向] 5 条特征正则的字符级内容与登记值一致", () => {
    // 这些字符串是"契约"。改动检测器口径必须先改这里——逼一次显式确认。
    expect(src(NOMINAL_SUFFIX)).toBe(
      "(性|化|度|感|力|型|式|机制|体系|格局|举措|效能|路径|维度|层面)$",
    );
    expect(src(rePersonal())).toBe(
      "(我|我们|咱|你|您|我觉得|个人|身边|记得|那次|当时|小时候|昨天|上周|我家|朋友)",
    );
    expect(src(reConcrete())).toBe(
      "([0-9０-９]+[年月日%％元块个次万亿度公里分秒]|[一二三四五六七八九十百千万亿两几]{1,3}[块元个年月天次度岁遍]|[A-Za-z][A-Za-z0-9-]{2,}|第[一二三四五六七八九十]+[章节部])",
    );
    expect(src(reIdiomLike())).toBe("[\\u4e00-\\u9fa5]{4}(?:、[\\u4e00-\\u9fa5]{4}){1,}");
  });

  it("[守卫2-反向] 两个 MODAL 变体的差异只允许是 需进一步/值得注意 这两项", () => {
    const det = new Set(branchesOf(reModalDetector()));
    const zq = new Set(branchesOf(reModalZhuque()));

    const onlyDet = [...det].filter((b) => !zq.has(b)).sort();
    const onlyZq = [...zq].filter((b) => !det.has(b)).sort();

    // 已登记的差异：detector 独有这两个分支（`需要进一步` 是死分支，`值得注意的是` 与 FORMULAIC 双计）
    expect(onlyDet).toEqual(["值得注意的是", "需要进一步"]);
    expect(onlyZq).toEqual([]);
  });

  it("[守卫2-反向] 两个 MODAL 变体共有部分逐字相同（防有人只改一边）", () => {
    const det = branchesOf(reModalDetector()).filter(
      (b) => !["需要进一步", "值得注意的是"].includes(b),
    );
    const zq = branchesOf(reModalZhuque());
    expect(new Set(det)).toEqual(new Set(zq));
  });

  it("[守卫3-自检] 比对逻辑本身有效：故意改坏一份副本必须被检出", () => {
    // 用旧版 detector MODAL（zhuque 口径）冒充 detector 版，应被判为差异不符
    const fakeDetector =
      /(应该|应当|必须|需要|有助于|意味着|表明|说明|能够|可以|我们要|既要|也要|不仅|而且)/g;
    const det = new Set(branchesOf(fakeDetector));
    const zq = new Set(branchesOf(reModalZhuque()));
    const onlyDet = [...det].filter((b) => !zq.has(b)).sort();
    // 坏副本下 onlyDet 为空 → 与"应为 2 项"的期望不符 → 证明守卫能抓到漂移
    expect(onlyDet).not.toEqual(["值得注意的", "需要进一步"]);
    expect(onlyDet).toEqual([]);
  });

  it("带 g 标志的正则用 .search() 判定不受 lastIndex 残留影响（本次真 bug 的回归）", () => {
    // 复现 detector.segmentRisk 的原缺陷：同一份 g 正则连续 .test() 会交替 true/false
    const re = reConcrete();
    const s1 = "他昨天买了3个苹果。";
    const viaTest: boolean[] = [];
    for (let i = 0; i < 4; i++) viaTest.push(re.test(s1));
    expect(viaTest).toEqual([true, false, true, false]); // 证明 .test() 确实有状态

    // .search() 稳定（search 是 String 的方法，不读也不写 lastIndex）
    const re2 = reConcrete();
    const viaSearch: boolean[] = [];
    for (let i = 0; i < 4; i++) viaSearch.push(s1.search(re2) >= 0);
    expect(viaSearch).toEqual([true, true, true, true]);
  });
});
