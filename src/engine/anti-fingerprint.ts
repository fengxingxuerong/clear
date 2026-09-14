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
/** 正式语体下需还原的过度口语替换（VOCAB 注入产物 → 书面词） */
const FORMAL_RESTORE: [RegExp, string][] = [
  // v0.9.8 P0 修复：方言还原段**按「是否误伤正常中文」逐条甄别**，不整体删除。
  //
  // 【保留】引擎造出的坏组合 —— 真实用户几乎不会这样写，还原无风险：
  [/麻利发展/g, "快速发展"], // "麻利"+"发展" 硬拼，非正常搭配
  [/总的来瞅/g, "总的来说"], // "总的来说" 的方言化错形
  [/唠到底/g, "归根到底"], // "归根到底" 的方言化错形
  [/说到底，归根到底/g, "归根到底"],
  //
  // 【移除】合法方言词 —— 用户原文可能自带，无条件还原 = 改作者口音。
  //
  // 移除条目（保留备查）：
  //   [/麻利/g,"快速"] [/瞅(到|见|了)?/g,"看$1"] [/唠(起|到|一|两)?/g,"谈$1"]
  //   [/恁/g,"那么"] [/咋(办|样|能|就)/g,"怎么$1"] [/搁(?:在)?/g,"在"]
  //   [/麻溜/g,"利落"] [/贼(好|快|多|溜)/g,"非常$1"] [/晓得/g,"知道"]
  //
  // 移除理由（scripts/_dialect_restore.ts，2026-09-14）：
  //   ① 这些还原原本是为对冲 injectDialect 的注入。injectDialect 已在 v0.9.8 P0
  //      停用（净负收益），还原表失去对冲对象，只剩单边作用。
  //   ② 单边作用的后果是**误伤用户原文**：FORMAL_RESTORE 是无条件全局替换，
  //      分不清「词是引擎注入的」还是「用户自带的」。
  //   ③ 实测（humanHand + academic，用户选"这是我写的、只做轻改"却最严重）：
  //        原文「干活麻利 / 都晓得 / 瞅见他在修车 / 慢慢唠」
  //      输出「干活快速 / 都知道 / 看见他在修车 / 慢慢谈」
  //      —— 作者的地域语言特色被整体抹平，5/5 个方言词全丢。
  //   ④ 方言词是人味最强的信号之一，引擎削它等于反着干。
  //
  // ⚠️ 以上 4 条「保留」项同样适用「必须用捕获组」的约束——它们在替换串里不引用 $N，
  //    故安全。若将来新增引用 $N 的条目，务必用 (…) 而非 (?:…)，否则输出字面 "$1"。

  // ---- v0.9.5 补：网络口语还原 ----
  // 此前门控只覆盖方言词，完全没管 VOCAB 里「书面词 → 网络口语」的映射。
  // 实测后果：一份正式公文被改成「死磕以问题为导向」「根本摆平」
  // 「不断完善 → 一直弄全吧」「打通数据壁垒 → 连上了数据壁垒」。
  // 下面按实测高频次序补还原（vocab-pollution 统计：拔高×18、开花结果×8、
  // 捋顺×6、死磕×5、连上×5、兜住×4、搭起×3、摆平×3、盯紧×3）。
  // ⚠️ 这是补丁；治本方案是给 VOCAB 词条标注「正式语体安全替身」，
  //    在替换阶段就跳过口语化映射（见 humanize-text.ts 的 VOCAB 应用层）。
  // 顺序敏感：必须先整词还原再单词还原。
  // 「久久为功」的 VOCAB 坏替身是"长期死磕"，若只做 死磕→坚持 会得到
  // "长期坚持"——那同样是探针黑名单里的坏替身（换汤不换药）。
  [/长期死磕/g, "久久为功"],
  [/死磕/g, "坚持"],
  [/摆平/g, "解决"],
  [/捋顺/g, "理顺"],
  [/弄全/g, "完善"],
  [/兜好/g, "完善"],
  [/拔高/g, "提升"],
  [/开花结果(?:见效)?/g, "落地见效"],
  [/盯紧/g, "确保"],
  [/把牢/g, "确保"],
  [/兜住(?=不发生|风险|底线)/g, "确保"],
  [/搭起/g, "构建"],
  // 「连上」需搭配守卫：连上网络/连上设备是正常用法，
  // 只有「连上…壁垒」才是把「打通（消除障碍）」错改成「建立连接」的语义反转
  [/连上了?((?:数据|信息|技术)?壁垒)/g, "打通了$1"],
  [/统一安排/g, "统筹"],
  [/稳当/g, "稳步"],
  [/环绕年度/g, "围绕年度"],
  [/统合升级/g, "统筹升级"],
];

/**
 * 静态守卫：替换串里的 $N 引用，正则中必须有第 N 个捕获组。
 *
 * 缘起：FORMAL_RESTORE 曾 4 条规则写成「非捕获组 (?:…) + 替换串引用 $1」，
 * 输出字面 "$1" 污染正文（如「具体来谈$1，可以从以下三个方面入手」）。
 * 同类错误在本文件已出现 3 次（FORMAL_RESTORE ×4、collapseDoubleConnectives、历史若干），
 * 单测虽有 `expect(out).not.toContain("$1")` 兜底，但只在刚好命中该分支时才触发。
 * 故改为模块加载即校验：错就当场炸，不给它静默流向用户的机会。
 */
function assertCaptureRefsValid(
  table: readonly (readonly [RegExp, string])[],
  label: string,
): void {
  for (const [re, rep] of table) {
    const refs = [...rep.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    if (refs.length === 0) continue;
    // 数捕获组：( 后面不是 ? 即是普通捕获组；(?<name>…) 也算；(?:…) (?=…) (?!…) 不算
    const src = re.source;
    let groups = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== "(") continue;
      if (src[i + 1] !== "?") groups++;
      else if (src[i + 2] === "<" && src[i + 3] !== "=" && src[i + 3] !== "!") groups++;
    }
    const maxRef = Math.max(...refs);
    if (maxRef > groups) {
      throw new Error(
        `${label} 替换串引用了 $${maxRef}，但正则只有 ${groups} 个捕获组 ` +
          `→ 会向正文输出字面 "$${maxRef}"。请把 (?:…) 改成 (…) 或删掉引用：` +
          `${re.source} → ${JSON.stringify(rep)}`,
      );
    }
  }
}
assertCaptureRefsValid(FORMAL_RESTORE, "FORMAL_RESTORE");
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
