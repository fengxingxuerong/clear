import { describe, it, expect } from "vitest";
import { humanize, mechanicalShuffle } from "./humanize";

/**
 * 保真门禁：内容/实体一个都不能丢或坏（v0.9.24 新增）
 *
 * 对应 `scripts/defect-taxonomy.ts` 的 **「格式损坏」** 类别。
 *
 * ## 为什么这类门禁要独立于语病门禁
 *
 * 语病是「读着别扭」，保真是「**信息没了**」。后者的严重性完全不同：
 * 段落被合并只是排版变了，但 URL 被插进一个「好吧」就是**链接彻底失效**。
 * 而且语病门禁的正则**天生看不见保真问题**——它们找的是特定形态，
 * 找不到「少了东西」。
 *
 * ## 本轮抓到的真实缺陷
 *
 * `mechanicalShuffle` 强度 ≥ 0.5 时，句尾锚点注入器把语气词插进 URL 内部：
 *
 *     https://example.com/docs/api?id=42&v=2
 *   → https://example.com/docs/api好吧?id=42&v=2
 *
 * 根因：`burstiness.ts` 选候选句的 `L` 算法只剔**中文**标点、不剔 ASCII，
 * 纯 URL 串的 L≈42 ≥ 10 被选为「长句」，锚点直接拼在 `raw.slice(insertAt)` 位置。
 *
 * ⚠️ 这条缺陷 `scan-bugs.ts` 的 13 组签名**一条都抓不到**——
 *   v4.3 的「URL/时间乱码」探针用的正则 `/(https[：，]|12[：，]30)/`
 *   只查中文标点混进 URL，而这里是**中文语气词插进 URL**，形态完全不同。
 *
 * ## 探针方法论（本轮又踩了一次）
 *
 * 第一版判据是「段落数变少 = 段落丢失」，扫出 385 + 224 处。逐条看样本才发现：
 * **内容一字未丢**，只是 `shortParagraphMerge` 把短段合并了——那是引擎的
 * 明确设计行为（`scan-bugs.ts` 的 v4.3 探针注释里就写着「避免被短段合并规则吃掉」）。
 *
 * > 判据必须落在「**内容**是否丢失」，不能落在「**分隔符**是否还在」。
 * > 分隔符变化可能是设计，加起来少了字才是损坏。
 *
 * 改判据后：678 → 69，且 69 处全是同一个根因（URL）。
 */

const URL_RE = /https?:\/\/[!-~]+/g;
/**
 * 剥掉 URL 尾部的**中文**标点。
 *
 * ⚠️ 只剥中文，**不能剥 ASCII**：`?` `&` `=` `#` `/` 都是 URL 的合法字符。
 * 第一版写成 `/[，。；：！？、）】」』"']+$/`（含 `！？`），
 * 于是 `https://example.com/docs/api?id=42&v=2` 被剥成
 * `https://example.com/docs/api?` ⇒ **报出 53 处「URL 被改坏」的假阳性**，
 * 而引擎其实一字未动。
 *
 * 这是本轮第三次「探针自己有 bug 却被当成引擎缺陷」：
 *   1. `\\S+` 吃中文 ⇒ URL 假阳性 159 处
 *   2. 段落数判据 ⇒ 609 处假阳性（段合并是设计行为）
 *   3. `！？` 被当 URL 标点剥掉 ⇒ 53 处假阳性
 *
 * > **报「引擎有 bug」之前，先确认探针的判据本身是对的**——
 * > 而且要有反向对照，否则分不清是探针错还是引擎错。
 */
const cleanUrl = (s: string) => s.replace(/[，。；：、）】」』"，]+$/g, "");
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w+/g;
const TIME_RE = /\d{1,2}:\d{2}/g;
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const CJK_RE = /[一-鿿]/g;

/**
 * 四段保真语料。与 `injection-overlap.test.ts` 共用同一批语料 ——
 * 那三条管「不要多出来」，这里管「不要少了」。
 */
const CORPUS: [string, string][] = [
  [
    "剧本",
    "【场景：咖啡馆 内 夜】\n【人物：林薇、店长】\n\n林薇：（搅动着杯子）这杯美式放了三次糖了。\n店长：您说的是糖，还是别的什么？\n\n【旁白】她忽然停住。\n\n林薇：对不起，我再说一遍。",
  ],
  [
    "多段技术",
    "第一段讲性能。我们用 Redis 做缓存，命中率从 62% 提升到 94%。\n\n第二段讲成本。云账单从每月 8400 元降到 2100 元。\n\n第三段讲团队。新增 3 名工程师，代码评审周期缩短一半。\n\n第四段讲未来。计划在 Q3 上线多区域支持。",
  ],
  [
    "含URL时间",
    "文档地址 https://example.com/docs/api?id=42&v=2 ，更新于 2026-03-15 14:30 。\n联系邮箱 test@example.com 或致电 13800138000 。\n版本号 v2.1.3 ，构建号 20260315-abc123 。\n\n第二段保留：金额 1,234.56 元，比例 66.7%，时间 08:00~22:30 。",
  ],
  [
    "多段论说",
    "首先，我们需要明确目标。其次，路径必须可行。\n\n再次，资源要匹配得上。\n\n最后，风险应当可控。\n\n总之，这件事值得推进。",
  ],
];

const INTENSITIES = [0.3, 0.6, 0.9, 1.0] as const;
const SEEDS = Array.from({ length: 30 }, (_, i) => i);

const sorted = (s: string, re: RegExp) => (s.match(re) ?? []).map(cleanUrl).sort().join("|");
const nums = (s: string) =>
  (s.match(/\d+(?:\.\d+)?/g) ?? [])
    .map(Number)
    .sort((a, b) => a - b)
    .join(",");

describe("保真门禁", () => {
  it("URL 不得被插入任何字符（mechanicalShuffle 曾把语气词插进 URL 内部）", () => {
    const hits: string[] = [];
    for (const [label, text] of CORPUS) {
      for (const intensity of INTENSITIES) {
        for (const seed of SEEDS) {
          for (const [pipe, out] of [
            ["humanize", humanize(text, { intensity, seed })],
            ["shuffle", mechanicalShuffle(text, { intensity, seed })],
          ] as const) {
            if (sorted(text, URL_RE) !== sorted(out, URL_RE)) {
              hits.push(`${pipe}/${label}/i${intensity}/s${seed}: ${sorted(out, URL_RE)}`);
            }
          }
        }
      }
    }
    expect(
      hits,
      `${hits.length} 处 URL 被改坏（960 次运行）：\n  ${hits.slice(0, 6).join("\n  ")}`,
    ).toEqual([]);
  });

  /**
   * URL 保护的**专向**用例。
   *
   * 为什么单列：上面的语料扫描只有 1 段含 URL、且 URL 在句中，
   * 而真正的触发形态是**纯 URL 整句**（L 最大，最容易被选为候选句）。
   * 这 8 个形态是本轮探针实测出来会被破坏的，钉住它们。
   */
  it("URL 专向形态：8 类全完好", () => {
    const CASES: [string, string][] = [
      ["纯URL整句", "https://example.com/docs/api?id=42&v=2"],
      ["URL在句首", "见 https://a.cn/p?x=1 这个页面。"],
      ["URL在句中", "详见 https://example.com/docs?id=7 这份文档。"],
      ["URL带锚点", "https://example.com/page#section-3 那一节。"],
      ["URL多行", "https://example.com/a\nhttps://example.com/b"],
      ["www形态", "见 www.example.com/page 这个站点。"],
      ["长query", "见 https://a.cn/p?xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=1 。"],
      ["query含等号", "见 https://a.cn/p?a=1&b=2&c=3 。"],
    ];
    const hits: string[] = [];
    for (const [label, text] of CASES) {
      for (let seed = 0; seed < 30; seed++) {
        const out = mechanicalShuffle(text, { intensity: 0.6, seed });
        for (const u of text.match(URL_RE) ?? []) {
          if (!out.includes(cleanUrl(u))) hits.push(`${label}/s${seed}: 缺「${u}」 → ${out}`);
        }
      }
    }
    expect(hits, `${hits.length} 处被破坏：\n  ${hits.slice(0, 6).join("\n  ")}`).toEqual([]);
  });

  it("邮箱、时间、日期、数字集合不得丢失", () => {
    const hits: string[] = [];
    for (const [label, text] of CORPUS) {
      for (const intensity of INTENSITIES) {
        for (const seed of SEEDS) {
          for (const [pipe, out] of [
            ["humanize", humanize(text, { intensity, seed })],
            ["shuffle", mechanicalShuffle(text, { intensity, seed })],
          ] as const) {
            for (const [kind, re] of [
              ["邮箱", EMAIL_RE],
              ["时间", TIME_RE],
              ["日期", DATE_RE],
            ] as const) {
              if (sorted(text, re) !== sorted(out, re))
                hits.push(`${pipe}/${label}/i${intensity}/s${seed} ${kind}: ${sorted(out, re)}`);
            }
            if (nums(text) !== nums(out))
              hits.push(`${pipe}/${label}/i${intensity}/s${seed} 数字: ${nums(out)}`);
          }
        }
      }
    }
    expect(
      hits,
      `${hits.length} 处实体丢失（960 次运行）：\n  ${hits.slice(0, 6).join("\n  ")}`,
    ).toEqual([]);
  });

  it("汉字净数不得减少（少了就是真丢字）", () => {
    const hits: string[] = [];
    for (const [label, text] of CORPUS) {
      for (const intensity of INTENSITIES) {
        for (const seed of SEEDS) {
          for (const [pipe, out] of [
            ["humanize", humanize(text, { intensity, seed })],
            ["shuffle", mechanicalShuffle(text, { intensity, seed })],
          ] as const) {
            const oc = (text.match(CJK_RE) ?? []).length;
            const nc = (out.match(CJK_RE) ?? []).length;
            if (nc < oc) hits.push(`${pipe}/${label}/i${intensity}/s${seed}: ${oc} → ${nc}`);
          }
        }
      }
    }
    expect(
      hits,
      `${hits.length} 处丢字（960 次运行）：\n  ${hits.slice(0, 6).join("\n  ")}`,
    ).toEqual([]);
  });

  it("剧本块头【场景/人物/旁白】必须原样保留", () => {
    const text = CORPUS[0][1];
    const heads = text.match(/【[^】]+】/g) ?? [];
    const hits: string[] = [];
    for (const intensity of INTENSITIES) {
      for (const seed of SEEDS) {
        for (const [pipe, out] of [
          ["humanize", humanize(text, { intensity, seed })],
          ["shuffle", mechanicalShuffle(text, { intensity, seed })],
        ] as const) {
          for (const h of heads)
            if (!out.includes(h)) hits.push(`${pipe}/i${intensity}/s${seed}: ${h}`);
        }
      }
    }
    expect(hits, `${hits.length} 处块头丢失：${hits.slice(0, 6).join(" | ")}`).toEqual([]);
  });

  /**
   * 反向对照：**证明上面几条不是永真式**。
   *
   * 第一版探针用「段落数变少 = 丢失」，扫出 609 处；逐条看全是假阳性——
   * `shortParagraphMerge` 把短段合并了，内容一字未丢，而那是引擎的**设计行为**。
   *
   * 这里钉住「段落合并不该被当损坏」，防止将来有人把段落数加回判据。
   */
  it("反向对照：段落合并是设计行为，不算损坏", () => {
    const text = CORPUS[1][1];
    const paras = (s: string) => s.split(/\n\s*\n/).filter((x) => x.trim()).length;
    let merged = 0;
    for (let seed = 0; seed < 30; seed++) {
      const out = humanize(text, { intensity: 0.6, seed });
      if (paras(out) < paras(text)) merged++;
      // 无论段落数怎么变，数字必须完整
      expect(nums(out), `seed=${seed} 合并段落时数字丢了`).toBe(nums(text));
    }
    // 本语料确实会触发合并（否则这条反向对照没意义）
    expect(merged, "这段语料没有触发过段落合并，反向对照形同虚设").toBeGreaterThan(0);
  });
});
