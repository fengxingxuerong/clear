/**
 * 趣AI味 · v0.9 反「新指纹」层
 * ---------------------------------------------------------
 * 背景：引擎注入的反检测特征本身会变成新 AI 指纹（v0.8.6 glm-5.2 交叉评判
 * 批判点：刻意口语化、对仗工整、模仿痕迹）。本层做四件确定性收口：
 *
 *  A) 长模板跨段复读封顶：自问自答/插话模板（"例子呢？我随便举一个你就懂了"）
 *     全文每种限 1 次，多余出现删除——真人不会每段写一样的插话。
 *  B) 语体门控：正式语体（论说/学术）下，把过度口语替换（快速→"麻利"、
 *     "总的来瞅""唠到底"）还原为书面词，并拆掉"我感觉，总的来瞅，"双连接词叠放。
 *  C) 残句开头守卫：句首独词连接词（并/而/且/但/亦/另）引导的残句修复——
 *     这类词在正常中文里几乎从不出现在句首。
 *  D) 场景块行保护：剧本【场景/人物/背景…】行在逐句注入环节跳过
 *     （语气词/句尾软化/自问自答不得污染块头），供 humanizeSingle 调用。
 *
 * 全部确定性实现（同输入必同输出），零第三方依赖。
 */

/** 是否为剧本块头行（场景/人物/角色/地点/时间/背景/旁白/简介） */
const SCENE_LINE_RE = /【[^】]{0,80}(?:场景|人物|角色|地点|时间|背景|旁白|简介)[^】]{0,80}】/;

export function isSceneMetaLine(line: string): boolean {
  return SCENE_LINE_RE.test(line);
}

/* =========================================================
   A) 长模板复读封顶
   ========================================================= */
/**
 * 复读模板表：按「最长组合优先」排序，每种全文保留首次出现，后续删除。
 * 删除安全前提：这些模板都是独立成句的插话/问句，删掉不影响前后句语义。
 */
const REPEAT_TEMPLATES: { re: RegExp }[] = [
  { re: /你可能会问——这不是理所当然的吗？其实不然。/g },
  { re: /例子呢？我随便举一个你就懂了。/g },
  { re: /真的假的？这事儿还真不是我瞎编。/g },
  { re: /为啥这么说？因为事实就摆在眼前。/g },
  { re: /有人要抬杠了——别急，我慢慢跟你捋。/g },
  { re: /不信？那你自己试试就知道了。/g },
  { re: /这事儿还真不是我瞎编。/g },
  { re: /那你自己试试就知道了。/g },
  { re: /例子呢？/g },
  { re: /我随便举一个你就懂了。/g },
];

/**
 * 核心复读短语（容忍注入环节在中间插入语气词导致完整模板失配）：
 * 全文每种短语限 1 次，第 2+ 次出现连同前邻标点一并删除。
 */
const REPEAT_PHRASES: string[] = [
  "我随便举一个你就懂了",
  "这事儿还真不是我瞎编",
  "别急，我慢慢跟你捋",
  "那你自己试试就知道了",
  "因为事实就摆在眼前",
  "这不是理所当然的吗",
  "有人要抬杠了",
  "真的假的",
  "为啥这么说",
  "例子呢",
  "你可能会问",
  "其实不然",
  "不信？",
  "搁谁都一样",
  "你细品",
  "有意思的是",
  "我寻思着",
  "按我的经验",
  "以我的经验",
  "往实了说",
  "往好听了说",
  "唠到底",
  // v0.9.4 P2：串联迭代实测新增的高频堆积短语（s1 ×5 轮观测：垫词 12→35）——
  // 这些不在注入源 shortFrags 主名单里，正是旧表漏管后堆积的主力
  "你懂的",
  "就这样",
  "这有什么要紧的",
  "要紧的在后头",
  "细想一下还真不是",
  "就这么回事",
  "话又侃回来",
  "侃真的",
  "据我观察",
  "客观讲",
  "老实讲",
  "不瞒你说",
  "不吹不黑",
  "讲道理",
];

/** 全文模板总预算：超过则删尾部（抑制多模板扎堆轰炸，真人不会连珠炮式抛插话） */
const MAX_TEMPLATE_TOTAL = 4;

export function capLongTemplateRepetition(text: string): string {
  let out = text;
  // 第一轮：完整模板去重（保留首次出现）
  for (const { re } of REPEAT_TEMPLATES) {
    const m = re.exec(out);
    if (!m) continue;
    const firstEnd = m.index + m[0].length;
    const tail = out.slice(firstEnd).split(re.source).join("");
    out = out.slice(0, firstEnd) + tail;
  }
  // 第二轮：核心短语计数去重（每种限 1 次，容忍被拆散）
  for (const phrase of REPEAT_PHRASES) {
    let idx = out.indexOf(phrase);
    let count = 0;
    while (idx !== -1) {
      count++;
      if (count > 1) {
        let start = idx;
        const before = out[idx - 1];
        if (
          before === "，" ||
          before === "、" ||
          before === "？" ||
          before === "。" ||
          before === "！"
        ) {
          start = idx - 1;
        }
        out = out.slice(0, start) + out.slice(idx + phrase.length);
        idx = out.indexOf(phrase, start);
      } else {
        idx = out.indexOf(phrase, idx + phrase.length);
      }
    }
  }
  // 第三轮：模板总量封顶（扎堆抑制）——收集全部命中，从后往前删超预算部分
  const hits: { phrase: string; idx: number }[] = [];
  for (const phrase of REPEAT_PHRASES) {
    let idx = out.indexOf(phrase);
    while (idx !== -1) {
      hits.push({ phrase, idx });
      idx = out.indexOf(phrase, idx + phrase.length);
    }
  }
  if (hits.length > MAX_TEMPLATE_TOTAL) {
    hits.sort((a, b) => b.idx - a.idx); // 从后往前
    for (let i = MAX_TEMPLATE_TOTAL; i < hits.length; i++) {
      const { idx } = hits[i];
      let start = idx;
      const before = out[idx - 1];
      if (
        before === "，" ||
        before === "、" ||
        before === "？" ||
        before === "。" ||
        before === "！"
      ) {
        start = idx - 1;
      }
      out = out.slice(0, start) + out.slice(idx + hits[i].phrase.length);
    }
  }
  // 收尾清理：删除模板后可能留下 "。，"、"——。"、"，，" 等坏标点
  out = out
    .replace(/[。！？!?][，,]/g, "。")
    .replace(/，[。！？!?]/g, "。")
    .replace(/，\s*，+/g, "，")
    .replace(/——(?=[。！？!?])/g, "") // 破折号后紧跟句末标点（模板删除残留）→ 删破折号留句号
    .replace(/——[，,]/g, "，") // 破折号后紧跟逗号（注入残留）→ 删破折号留逗号
    .replace(/[。！？!?]{2,}/g, "。")
    .replace(/[，]{2,}/g, "，")
    .replace(/\n{3,}/g, "\n\n");
  return out;
}

/* =========================================================
   B) 语体门控（formal = 论说/公告/学术 等正式语体）
   ========================================================= */
/** 正式语体下需还原的过度口语替换（VOCAB/方言注入产物 → 书面词） */
const FORMAL_RESTORE: [RegExp, string][] = [
  [/麻利发展/g, "快速发展"],
  [/麻利/g, "快速"],
  [/总的来瞅/g, "总的来说"],
  [/唠到底/g, "归根到底"],
  [/说到底，归根到底/g, "归根到底"],
  [/瞅(?:到|见|了)?/g, "看$1"],
  [/唠(?:起|到|一|两)?/g, "谈$1"],
  [/恁/g, "那么"],
  [/咋(?:办|样|能|就)/g, "怎么$1"],
  [/搁(?:在)?/g, "在"],
  [/麻溜/g, "利落"],
  [/贼(?:好|快|多|溜)/g, "非常$1"],
  [/晓得/g, "知道"],
];

/** 双连接词叠放：口语观点词 + 总结词 连续出现时保留一个（不限语体） */
const DOUBLE_CONNECTIVE_RE =
  /(要我说|说白了|讲真|说真的|老实讲|我感觉|我的看法是|总的来瞅|总的来说|归根到底|唠到底|你细品|往好听了说)[，,](?:要我说|说白了|讲真|说真的|老实讲|我感觉|总的来瞅|总的来说|归根到底|唠到底|你细品|往好听了说)[，,]?/g;

/** 双连接词叠放拆解：两个口语引导词连用只留一个（如"我感觉，总的来瞅，"→"我感觉，"） */
export function collapseDoubleConnectives(text: string): string {
  // 注意：首词必须是捕获组（替换串引用 $1），全部 (?:) 会导致输出字面 "$1"
  return text.replace(DOUBLE_CONNECTIVE_RE, "$1，");
}

export function guardFormalRegister(text: string, formal: boolean): string {
  if (!formal) return text;
  let out = text;
  for (const [re, rep] of FORMAL_RESTORE) {
    out = out.replace(re, rep);
  }
  return out;
}

/* =========================================================
   C) 残句开头守卫
   ========================================================= */
/** 几乎不能独立句首的独词连接词：命中则删词（若残句过短则与上一句合并） */
const ORPHAN_LEAD_RE = /(^|[。！？!?]\s*)(并|而|且|但|亦|另)(?=[\u4e00-\u9fa5A-Za-z0-9])/g;
const MERGE_MIN_CHARS = 8;
/** 独立语气词/垫词短句：不得被合并吞掉（它们是句长 CV 的来源，吞掉会触发"句长节奏过平"） */
const PARTICLE_SHORT_RE =
  /^(?:就这样|你懂的|说白了|差不多得了|嗯|哦对|行吧|好吧|是啊|对哦|哦|啊|行|嗯哼|你说得对|是这个理|随你怎么说|咳|呣|啧|诶|嗨|哈|反正|说白了|讲真|说真的)[。！？]?$/;

export function fixOrphanConnectiveLeads(text: string): string {
  // 1) 删句首独词连接词
  const out = text.replace(ORPHAN_LEAD_RE, (_m, pre: string) => pre);
  // 2) 残句合并：删词后过短的句子与上一句合并（上一句以句号/省略号结尾才合并，
  //    问号/叹号句不吞并；独立语气词短句不吞并——它们负责制造 burstiness）
  return out
    .split(/(?<=[。！？!?…])/g)
    .reduce<string[]>((acc, s) => {
      const trimmed = s.trim();
      if (!trimmed) return acc;
      if (
        acc.length > 0 &&
        trimmed.length < MERGE_MIN_CHARS &&
        !PARTICLE_SHORT_RE.test(trimmed) &&
        /[。…]$/.test(acc[acc.length - 1])
      ) {
        acc[acc.length - 1] = acc[acc.length - 1].replace(/[。…]+$/, "") + "，" + trimmed;
        return acc;
      }
      acc.push(s);
      return acc;
    }, [])
    .join("");
}

/* =========================================================
   D) 场景块行保护辅助（humanizeSingle 逐句跳过）
   ========================================================= */
/** 逐句处理时判断：该句是否为剧本块头行（是则跳过全部注入） */
export function isSceneMetaSentence(sentence: string): boolean {
  return SCENE_LINE_RE.test(sentence);
}
