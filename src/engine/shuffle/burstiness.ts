/**
 * 机械扰动层 · 节奏增强（burstiness）族（自 humanize-shuffle.ts 拆出，逐字搬移）。
 * 导入面兼容由 ../humanize-shuffle.ts 门面统一 re-export。
 */
import {
  splitSentences,
  sentenceStats,
  computeStats,
  findSplitPoint,
  findGuardedCutNear,
  MIN_BURSTINESS_CV,
  PAD_INJECT_CAP,
  countPadHeads,
  RewriteStyle,
  isSceneBlockLine,
} from "../humanize-data.ts";

/**
 * v0.8.9 P0 逻辑锚点签名：句首为序号/因果/承接标记的句子，其前后不插入口语碎片，
 * 也不参与句序重排（重排侧见 SEQUENCE_HEAD_RE）。覆盖「一是…」「因为…」「所以…」等
 * 一旦被打断就伤及论证链的句式。
 */
const LOGIC_ANCHOR_HEAD_RE =
  /^(?:一是|二是|三是|四是|其一|其二|其三|第一|第二|第三|首先|其次|再次|最后|末了|因为|由于|之所以|所以|因此|因而|但是|但|不过|然而|总之|综上|综上所述|总而言之|总的来看)/;

export function boostBurstiness(
  text: string,
  rng: () => number,
  p: number,
  style: RewriteStyle = "casual",
): string {
  // v0.9-D：含剧本【场景/人物/背景…】块头行的段落跳过节奏注入（块头不得被塞极短语气句）
  const isScenePara = (para: string) => para.split("\n").some((ln) => isSceneBlockLine(ln));
  let result: string;
  if (text.includes("\n")) {
    result = text
      .split(/\n\n+/)
      .map((para) => (isScenePara(para) ? para : boostBurstinessSingle(para, rng, p)))
      .join("\n\n");
  } else {
    result = boostBurstinessSingle(text, rng, p);
  }
  const usedFrags = new Set<string>();
  if (result.includes("\n")) {
    result = result
      .split(/\n\n+/)
      .map((para) => (isScenePara(para) ? para : boostBurstinessFragments(para, usedFrags, style)))
      .join("\n\n");
  } else {
    result = boostBurstinessFragments(result, usedFrags, style);
  }
  return result;
}

function boostBurstinessFragments(
  text: string,
  usedFrags: Set<string>,
  style: RewriteStyle = "casual",
): string {
  if (style !== "casual") return text;
  // v0.9.4 P2 跨轮垫词饱和守卫：文本已有垫词达到上限后不再注入碎片——
  // 串联迭代实测（垫词 12→35）堆积全部来自各注入点无跨轮记忆。
  if (countPadHeads(text) >= PAD_INJECT_CAP) return text;
  const sentences = splitSentences(text);
  const stats = sentenceStats(text);
  if (stats.count < 4) return text;
  if (stats.avg > 0 && stats.cv >= MIN_BURSTINESS_CV) return text;

  const shortFrags = [
    "就这样。",
    "你懂的。",
    "说白了。",
    "差不多得了。",
    "嗯。",
    "哦对。",
    "行吧。",
  ];
  let inserted = 0;
  const gap = Math.ceil(sentences.length / 4);
  for (let i = gap; i < sentences.length && inserted < 3; i += gap) {
    // v0.8.9 P0：逻辑锚点处不插碎片。
    // 把「就这样。」「你懂的。」塞在序号句/因果句与其承接句之间，会在论证链上切出断口，
    // 读感像被人中途插了句不相干的话——碎片只在普通叙述句之间落点。
    // 注意用「顺延到下一个安全位」而非直接放弃：碎片本身是拉高句长方差的主力，
    // 少插会让节奏重新落入 AI 的均匀带（scan-bugs v5.3 会报警）。
    const anchorAt = (k: number) => LOGIC_ANCHOR_HEAD_RE.test((sentences[k] ?? "").trim());
    let slot = i;
    if (anchorAt(i - 1) || anchorAt(i)) {
      slot = -1;
      for (let k = i + 1; k < sentences.length; k++) {
        if (!anchorAt(k - 1) && !anchorAt(k)) {
          slot = k;
          break;
        }
      }
      if (slot === -1) continue;
    }
    let frag = shortFrags[inserted % shortFrags.length];
    let g = 0;
    while ((usedFrags.has(frag) || sentences.some((s) => s === frag)) && g < shortFrags.length) {
      g++;
      frag = shortFrags[(inserted + g) % shortFrags.length];
    }
    usedFrags.add(frag);
    sentences.splice(slot, 0, frag);
    inserted++;
    i = slot + 1;
  }
  return sentences.join("");
}

export function boostBurstinessSingle(text: string, _rng: () => number, _p: number): string {
  const sentences = splitSentences(text);
  const lens = sentences.map((s) => s.replace(/[。！？!?；;\n]/g, "").length);
  if (lens.length < 3) return text;
  if (computeStats(lens).cv >= MIN_BURSTINESS_CV) return text;
  for (let round = 0; round < 5; round++) {
    const lens2 = sentences.map((s) => s.replace(/[。！？!?；;\n]/g, "").length);
    if (computeStats(lens2).cv >= MIN_BURSTINESS_CV) break;
    let maxI = 0;
    for (let i = 1; i < lens2.length; i++) if (lens2[i] > lens2[maxI]) maxI = i;
    const s = sentences[maxI];
    const mid = findSplitPoint(s, 25);
    if (mid === -1) break;
    sentences[maxI] = s.slice(0, mid).trim() + "。";
    sentences.splice(maxI + 1, 0, s.slice(mid + 1).trim());
  }
  return sentences.join("");
}

export function boostBurstinessIfLow(
  text: string,
  rng: () => number,
  targetCv = MIN_BURSTINESS_CV,
  maxCuts = 12,
  style: RewriteStyle = "casual",
): string {
  // v0.9 专家修复 P5：academic 文风禁用极短语气锚（「呵。」「啧。」是纯口语装置）。
  // CV 兜底交给 clampAvgSentenceLenUnder25 的纯切句（不打语气词）。
  if (style === "academic") return text;
  // v0.9-D：含剧本【场景/人物/背景…】块头行的段落跳过极短锚注入（块头不得被塞"啧。呣。"）
  const isScenePara = (p: string) => p.split("\n").some((ln) => isSceneBlockLine(ln));
  // P7-F 段落感知：同 clampAvgSentenceLenUnder25，避免 splitSentences→join 合并段落
  // v0.9.16 修复（单块场景保护）：旧实现场景判定只在多段分支生效——单块场景文本
  // （无空行分隔的【场景…】行）会直接进 InBlock 被塞「啧。呣。」。现在单块同样先判场景。
  const result = !text.includes("\n\n")
    ? isScenePara(text)
      ? text
      : boostBurstinessInBlock(text, rng, targetCv, maxCuts)
    : text
        .split(/\n\n+/)
        .map((p) => (isScenePara(p) ? p : boostBurstinessInBlock(p, rng, targetCv, maxCuts)))
        .join("\n\n");
  // v0.8.4 兜底清扫：管线里 IfLow 会被多次调用（朱雀增强 + P5 清尾），跨调用仍可能
  // 拼出「哦。哦。」「是啊。是啊。」式相邻极短句复读——复读本身就是机器指纹
  // （fingerprintCheck 垫词复读同类项），逐字符统计类特征一抓一个准。相邻同串只留一个。
  return result.replace(/([\u4e00-\u9fa5]{1,4}[。！？])(?:\s*)\1+/g, "$1");
}

function boostBurstinessInBlock(
  text: string,
  rng: () => number,
  targetCv: number,
  maxCuts: number,
): string {
  if (maxCuts <= 0) return text;
  let working = text;
  const ULTRA_SHORT_ANCHORS = [
    "对哦。",
    "嗯。",
    "嗨。",
    "好吧。",
    "行。",
    "是啊。",
    "诶。",
    "咳。",
    "哦。",
    "啊。",
    "呵。",
    "啧。",
    "呣。",
  ];
  // v0.8.4 反堆叠：同一句只塞一次锚、锚点同块去重、总量封顶。
  // 依据（multi-case 实测病句）：CV 追不上目标时循环对同一句反复塞锚，
  // 拼出「数字化转型行对哦诶啊嗯呵呣啧」这类粒子串、句尾挂出「是啊。是啊。」——
  // 语气词复读本身就是新的机器指纹（fingerprintCheck 的垫词复读同类项），
  // 比低 CV 危害更大：宁可少塞锚没达标，也不产出可被统计抓到的复读串。
  const ANCHOR_TAIL_RE = /(?:对哦|是啊|好吧|[嗯嗨诶咳呵啧呣哦啊行])[。！？!?…]*$/;
  // 独立语气锚句（跨调用堆积判定用）
  const ANCHOR_STANDALONE_RE = /^(?:对哦|是啊|好吧|[嗯嗨诶咳呵啧呣哦啊行])[。！？!?…]*$/;
  // v0.9 专家修复 P3：锚点单块封顶 4→2；且块内已有任意语气锚（独立句或句尾缀）
  // 时本调用直接跳过——最终 boost 在多注入器之后运行，不查存量会把每段
  // 都挂上「呵。」「啧。」成串（专家实测 0.9 档每段堆积 2-4 条）。
  const ANCHOR_CAP = Math.min(2, Math.max(1, Math.ceil(maxCuts / 4)));
  const alreadyHasParticle = splitSentences(text).some(
    (x) => ANCHOR_STANDALONE_RE.test(x.trim()) || ANCHOR_TAIL_RE.test(x.trim()),
  );
  if (alreadyHasParticle) {
    // v0.9 专家修复 P3 长尾：块内已有语气锚时不再灌锚，但也不能直接躺平——
    // 旧引擎正是靠「啧。」堆积把 CV 顶过线，砍掉灌水后必须有替代手段。
    // 降级为「纯切句」增强：长句在守卫通过的逗号处切两半，既提 CV 又降 avgLen，
    // 且不引入任何新注入痕迹。
    // v0.9.2 修复：直接 return 切句结果而非提前退出——原版「已有锚就整块跳过」
    // 导致 0.6 档 CV 不达标时无兜底（scan-bugs v5.3 实测 6 次节奏过平）。
    return boostBurstinessByCutting(working, targetCv, Math.min(maxCuts, 6));
  }
  const usedAnchors = new Set<string>();
  const endsWithParticle = (s: string) => ANCHOR_TAIL_RE.test(s.trim());
  let injected = 0;
  for (let attempt = 0; attempt < maxCuts && injected < ANCHOR_CAP; attempt++) {
    const cur = sentenceStats(working);
    if (cur.cv >= targetCv) break;
    const sents = splitSentences(working);
    // P5-B 放宽切句门槛 L≥10（原为 14），D2 对话体有更多中等句可供"塞极短锚"
    //
    // v0.9.24：**含 URL 的句子必须排除**。L 的算法只剔中文标点、不剔 ASCII，
    // 于是 `https://example.com/docs/api?id=42&v=2` 的 L≈42 ≥ 10 被选为候选，
    // 锚点直接插进 URL 内部：
    //     https://example.com/docs/api?id=42&v=2
    //   → https://example.com/docs/api好吧?id=42&v=2
    // 这不是语病，是**数据损坏**——链接彻底失效。
    // 实测 30/30 种子稳定复现，触发门槛为 intensity ≥ 0.5
    // （orchestrator 的 `if (intensity >= 0.5)` 才进 structuralShuffleParagraph）。
    //
    // 为什么邮箱/版本号不用管：它们的 L 通常 < 10，进不了候选池（实测 0/30）。
    // 这里只挡 URL 是**最窄的修复**——判据越宽越容易误伤正常句子。
    const URL_IN_SENT_RE = /(?:https?:\/\/|www\.)[!-~]+/i;
    const withIdx = sents
      .map((s, i) => ({
        s,
        i,
        L: s.replace(/[\s。！？!?…—\-，、；：""''「」（）《》【】]/g, "").length,
      }))
      .filter((x) => x.L >= 10 && !endsWithParticle(x.s) && !URL_IN_SENT_RE.test(x.s));
    if (withIdx.length < 1) break;
    withIdx.sort((a, b) => b.L - a.L);
    // 优先切第 2/3 长句，避免同一句反复切
    const choice =
      withIdx.length >= 3
        ? withIdx[Math.floor(rng() * 3)]
        : withIdx.length >= 2
          ? rng() < 0.5
            ? withIdx[0]
            : withIdx[1]
          : withIdx[0];
    const target = choice;
    const fresh = ULTRA_SHORT_ANCHORS.filter((a) => !usedAnchors.has(a));
    // ⚠️ 这行的 break 目前**不可达**（v0.9.24 核实）：ULTRA_SHORT_ANCHORS 有 9 枚，
    // 而本轮注入上限 ANCHOR_CAP = min(2, max(1, ceil(maxCuts/4))) 最多 2 枚，
    // usedAnchors 永远耗不空 9 枚池子。行 279 尾挂锚处同理。
    // 保留理由：CAP 是配置量，一旦调大（或池子被裁剪）这行就是必要的护栏。
    // 与 structure.ts:744 同类——属有意冗余，不是遗忘。
    if (!fresh.length) break;
    const anchorFull = fresh[Math.floor(rng() * fresh.length)];
    usedAnchors.add(anchorFull);
    const raw = target.s;
    let insertAt = raw.length;
    let anchor = anchorFull;
    const lastCh = raw[raw.length - 1] || "";
    // v0.8.5 语体守卫：插入点前若是书面抽象名词或"的"字结构，
    // 语气词缀在名词后形成「行业呀。」「本质嗯。」「本质行。」式语体错位
    //（书面语体 + 口语语气词相接，探针与真人阅读都可感知）——跳过此句。
    // 对有/无句末标点两种情况都生效：剥句号内插与整锚拼接效果等同。
    const before = raw.slice(0, insertAt).replace(/[。！？!?…]$/, "");
    if (
      /[\u4e00-\u9fa5]{0,3}(行业|趋势|教育|技术|发展|本质|方案|融合|转型|体系|机制|模式|能力|水平|质量|效率|价值|意义|作用|目标|战略|格局|态势|工艺|封装|架构|材料|器件|电路|制程|节点|性能|功耗|良率|产能|百分点|万亿元|亿美元|亿元|美元|缺口|占比|增速|规模)$/.test(
        before,
      ) ||
      /的$/.test(before)
    ) {
      continue;
    }
    if ("。！？!?…".includes(lastCh)) {
      // v0.9 专家修复 P3 长尾：问句前禁挂语气锚——「不信嗯？」是抽风式语体错位；
      // 问句自带节奏突变（短+？），无需锚点也贡献 CV
      if (lastCh === "？" || lastCh === "!") continue;
      // 插在句末标点之前时必须去掉锚点自带的句号，否则拼出"。。"
      //（multi-case 实测病句：「挑战哈对哦。啊。。就这样。」）
      insertAt = raw.length - 1;
      anchor = anchorFull.replace(/。$/, "");
    }
    const newStr = raw.slice(0, insertAt) + anchor + raw.slice(insertAt);
    sents[target.i] = newStr;
    working = sents.join("");
    injected++;
  }
  // P5-B 兜底：循环塞完仍 < targetCv → 在文本末尾硬挂 1~2 条独立极短句（暴力双峰：正常20字 vs 1字）
  //        仅用于 D2 这类"中等句多、CV 天生稳"的体裁
  const tailCheck = sentenceStats(working);
  if (tailCheck.cv < targetCv && injected < ANCHOR_CAP + 1) {
    const needMore = targetCv - tailCheck.cv;
    const tails = needMore > 0.04 ? 2 : 1;
    let extra = "";
    for (let i = 0; i < tails; i++) {
      // 同块去重：老实现两次随机可抽中同一锚，挂出「是啊。是啊。」复读串
      const fresh = ULTRA_SHORT_ANCHORS.filter((a) => !usedAnchors.has(a));
      // ⚠️ 同上：ANCHOR_CAP+1 最多 3 枚，池子 9 枚 ⇒ 这行 break 当前不可达（v0.9.24 核实）
      if (!fresh.length) break;
      const a = fresh[Math.floor(rng() * fresh.length)];
      usedAnchors.add(a);
      // 跨调用防复读：IfLow 在管线里会被调用多次（朱雀增强 + P5 清尾），每次调用
      // 的 usedAnchors 都是新建的——上一调用可能已在本块尾挂过同一锚。不依赖
      // 调用内状态，直接实测文本尾：尾端已有同核锚点就跳过这个候选。
      const core = a.replace(/。$/, "");
      if (new RegExp(core + "[。！？!?…]\\s*$").test(working.replace(/\s+$/, ""))) continue;
      extra += a;
    }
    if (extra) {
      // 末尾是句末标点就直接挂；弱标点（逗号/顿号等）先升级成句号再挂，
      // 否则拼出"，。"（multi-case 实测病句：「拉动可持续发展，。说到底」）
      const trimmed = working.replace(/\s+$/, "");
      if (/[。！？!?…]$/.test(trimmed) || trimmed.length === 0) working = trimmed + extra;
      else if (/[，、；：,]$/.test(trimmed))
        working = trimmed.replace(/[，、；：,]$/, "。") + extra;
      else working = trimmed + "。" + extra;
    }
  }
  // v0.9 专家修复 P3 长尾：锚灌注受限（CAP/语体守卫）后 CV 仍不达标 → 纯切句补刀。
  // 切长句零注入痕迹：句长方差上升、avgLen 下降，是节奏兜底的无指纹手段。
  const finalCheck = sentenceStats(working);
  if (finalCheck.cv < targetCv) {
    working = boostBurstinessByCutting(working, targetCv, Math.max(3, Math.floor(maxCuts / 2)));
  }
  return working;
}

/**
 * v0.9 专家修复 P3 长尾：纯切句式 burstiness 增强（零注入）。
 * 块内已有语气锚时用它替代锚点灌注：在守卫全部通过的逗号/分号处把最长句
 * 切成两句——句长方差自然上升、avgLen 同步下降，且不引入任何「呵。啧。」
 * 式新指纹。切点判定复用 findSplitPoint（含括号/状语/光杆谓词全套守卫）。
 * v0.9.2 导出：主流程 cap2 收口后用它兜底（锚灌注与删锚拉锯的死结解法）。
 */
export function boostBurstinessByCutting(text: string, targetCv: number, maxCuts: number): string {
  if (maxCuts <= 0) return text;
  let working = text;
  for (let c = 0; c < maxCuts; c++) {
    const cur = sentenceStats(working);
    if (cur.cv >= targetCv) break;
    const sents = splitSentences(working);
    // 候选：长度 ≥ 22 的长句（切成两半各 ≥ 10，方差贡献最大）
    const ranked = sents
      .map((s, i) => ({
        i,
        s,
        L: s.replace(/[\s。！？!?…—\-，、；：""''「」（）《》【】]/g, "").length,
      }))
      .filter((x) => x.L >= 22)
      .sort((a, b) => b.L - a.L);
    if (ranked.length === 0) break;
    const t = ranked[0];
    // v0.9.2：标准 30%~70% 区间切不动时，给「说起来，……」类插入语引导的长句开一条后路。
    // 起因是 scan-bugs v5.3 seed=28 实测：这类句子首个逗号在句长 15% 附近，标准区间
    // 排除它，于是全部句子均匀中长时一刀也切不了。
    //
    // v0.9.14 修正（原实现是病句发生器）：原注释写着"放宽区间仍走全套守卫，不会切出残句"，
    // 但代码其实是 `mid = firstComma` 一刀裸切，**没有任何守卫**——「总的来看，数字化办公…」
    // 被切成 4 字光杆孤句「总的来看。」，下游 fixOrphanConnectiveLeads 再把它向左粘回上一句尾部，
    // 产出「…AI 写作工具跟着就来了，总的来看。」这种句末悬空连接词病句
    // （UI 示例文本实测 102/280 次运行 = 36.4%，强度 0.55 起）。
    // 现在切点一律落在插入语**之后**，把插入语并入前半句，且走 findGuardedCutNear 的全套守卫。
    let mid = findSplitPoint(t.s, 22);
    if (
      mid === -1 &&
      /^(?:说起来|归结起来|一句话概括|总的来说|总的来看|说到底|有意思的是|值得注意的是|要我说|说白了|按我的经验)/.test(
        t.s.trim(),
      )
    ) {
      const fc = t.s.indexOf("，"); // 插入语边界，绝不允许当切点
      const sc = fc === -1 ? -1 : fc + 1 + t.s.slice(fc + 1).indexOf("，");
      if (sc > fc) {
        const cand = findGuardedCutNear(t.s, sc);
        if (cand > fc) mid = cand;
      }
    }
    if (mid === -1) {
      // 最长句无可守卫切点 → 尝试次长句（最多看 3 条）
      let cut = -1;
      let pickIdx = -1;
      for (let k = 1; k < Math.min(3, ranked.length); k++) {
        const m2 = findSplitPoint(ranked[k].s, 22);
        if (m2 !== -1) {
          cut = m2;
          pickIdx = k;
          break;
        }
      }
      if (pickIdx === -1) break;
      const tk = ranked[pickIdx];
      sents[tk.i] = tk.s.slice(0, cut).trim() + "。";
      sents.splice(tk.i + 1, 0, tk.s.slice(cut + 1).trim());
    } else {
      sents[t.i] = t.s.slice(0, mid).trim() + "。";
      sents.splice(t.i + 1, 0, t.s.slice(mid + 1).trim());
    }
    working = sents.join("");
  }
  // v0.9.8 P0 修复：废除「切无可切 → 相邻句合并」兜底（原 v0.9 专家修复 P3 终段）。
  //
  // 原实现（保留注释备查）：
  //   if (cutsDone === 0) {
  //     while (merged < 2 && sentenceStats(working).cv < targetCv) {
  //       ...把两个句号句并为一个逗号长复句...
  //     }
  //   }
  //
  // 废除理由一（根因与 boostBurstinessIfLow / boostBurstinessFragments 完全相同）：
  //   它唯一的存在目的是把 CV 抬到 targetCv。而标尺 v0.9.6 已删除 burstiness 反向项
  //   （实测 CV 判别力≈0 且方向反：人写口语随笔 CV=0.27 是全场最低）。
  //   为已废除的指标服务的手段，只会制造新标尺要抓的污染。
  //
  // 废除理由二（确定性破坏作者结构，证据 scripts/archive/_shape.ts）：
  //   同一段文本「3 个 20+ 字句」，单段调用时不触发（0.3~0.9 档均保持 3 句），
  //   但在多段调用（NARR_MULTI 等）下 0.5 档起稳定被焊成 1 句——
  //   因为逐段调用时 sentenceStats 的 CV 基准变小，更容易落到 cutsDone===0 分支。
  //   实测影响面（scripts/_merge_impact.ts，0.9 档）：论说最大损失 2 句、人写 1 句。
  //   句子边界是作者的语气与节奏表达（「…汤。我…」焊成「…汤，我…」改变语气），
  //   且丢失断句信息 —— humanize 的职责是去 AI 味，不是重写作者的断句。
  //
  // 废除理由三（函数名自反）：函数叫 ByCutting（切分），内部却做合并；
  //   而真正的切分手段（findSplitPoint + fragmentCanStand 全套守卫）已在上面跑完，
  //   切不动说明"这些话本就不该被切"（守卫否决是有意的设计），不该反手焊回去。
  //
  // 代价评估：去掉后 CV 可能偏低（部分文本），但标尺不再考核该指标，
  //   且 clampAvgSentenceLenUnder25 / 结构层仍各自负责句长与骨架，不产生功能缺口。
  return working;
}
