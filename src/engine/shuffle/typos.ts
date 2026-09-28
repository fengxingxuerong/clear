/**
 * 机械扰动层 · P2 反检测特征增强（错别字注入，自 humanize-shuffle.ts 拆出，逐字搬移）。
 * 导入面兼容由 ../humanize-shuffle.ts 门面统一 re-export。
 */
import { pick, isSceneBlockLine } from "../humanize-data.ts";

/**
 * P2-1：极低概率错别字注入（全文 <= 2 处），模拟人类打字手滑。
 *
 * @deprecated v0.9.8 P0 —— **已停用（全体裁关闭），不再产出任何替换**。
 *
 * 停用理由（代价已量化，scripts/_typo_cost.ts，2026-09-14）：
 *   ① 收益为零：叙事体裁 2/10 seed 命中「得时候」，但 avg aiScore 仍是 **0.0** ——
 *      标尺不检测这类错别字（`typoCount * 30` 抓的是另一类更显眼的拼写错）。
 *      即：让文本出现真实语法错误，换不来任何"更像人写"的评分收益。
 *   ② 代价是真实的：首条规则 `的(?=时候)` → ["地","得"] 会把「的时候」写成「得时候」。
 *      这不是"模拟手滑"（真人打错字不会错成这个），而是"为反检测而故意犯错"。
 *      工具卖点是"更自然"，输出带语法错误会直接砸口碑，买家还得自己修错字。
 *   ③ 设计自证：`humanHand` 体裁早已 `disableTyposAnchor: true` —— 设计者本就认它有害。
 *
 * 为何整体关死而非把概率调更低：只要还注入，就一定会留下错误；而它换不来分数。
 * 属"净负收益设计，删除优于调低概率"（同 injectDialect 的处置逻辑）。
 *
 * 保留函数本体与 TYPO_PAIRS 表以备回滚：**不要重新接回主路径**，
 * 除非标尺新增了对"语法级错别字"的检测项（届时需重新量化收益）。
 */
const TYPO_PAIRS: [RegExp, string[]][] = [
  [/(?<![的地得])的(?=方式|方法|原因|结果|时候|问题|情况)/, ["地", "得"]],
  [/(?<![的地得])地(?=说|看|做|想|跑|走|提升|提高|降低)/, ["的", "得"]],
  [/(?<![在再])在(?=说|看|试|去|来|做一遍|想一想)/, ["再"]],
  [/(?<![做作])做(?=为|品|业|用|法|文)/, ["作"]],
  [/(?<![做作])作(?=事|饭|题|实验|测试|对比)/, ["做"]],
];
const TYPO_MAX_GLOBAL = 2;

/** v0.9.8 P0：错别字注入总开关。置 true 可临时回滚（需重新量化收益）。 */
const TYPO_INJECTION_ENABLED = false;

export function injectHumanTypos(text: string, rng: () => number, intensity: number): string {
  if (!TYPO_INJECTION_ENABLED) return text;
  if (intensity < 0.7) return text;
  // P8 场景块保真：场景行区间不计入命中——错别字单字替换会破坏【场景：…】块头，
  // 同时保留全文级 TYPO_MAX_GLOBAL 预算语义不变
  const sceneRanges: [number, number][] = [];
  {
    let pos = 0;
    for (const ln of text.split("\n")) {
      if (isSceneBlockLine(ln)) sceneRanges.push([pos, pos + ln.length]);
      pos += ln.length + 1;
    }
  }
  const inScene = (idx: number) => sceneRanges.some(([a, b]) => idx >= a && idx <= b);
  let injected = 0;
  let out = text;
  for (const [re, tos] of TYPO_PAIRS) {
    if (injected >= TYPO_MAX_GLOBAL) break;
    const hits: number[] = [];
    const reClone = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = reClone.exec(out)) !== null) {
      if (!inScene(m.index)) hits.push(m.index);
    }
    if (hits.length === 0) continue;
    if (rng() > Math.min(0.55, 0.25 + intensity * 0.35)) continue;
    const targetIdx = hits[Math.floor(rng() * hits.length)];
    // 对应正则最后一段匹配长度一般为 1 字，做单字替换
    out = out.slice(0, targetIdx) + pick(rng, tos) + out.slice(targetIdx + 1);
    injected++;
  }
  return out;
}
