/**
 * 趣AI味 · 命中护栏：固定搭配守卫（GUARD_BEFORE/AFTER）与记忆化的判定入口。
 */
// 上下文守卫：命中词的紧邻前缀/后缀若在黑名单里，跳过替换，避免打断固定搭配
// 例如"价值最大化"里的"价值"换成"用处"会得到"用处最大化"这种怪话
export const GUARD_BEFORE: Record<string, string[]> = {
  显著: ["具有", "颇具", "甚"],
  价值: ["剩余", "创造", "交换"],
  持续: ["可"], // "可持续发展"内嵌"持续"，替换即崩
  // v0.9.5 P4 长搭配守卫：实测（Phase1 s2）双替身相撞产出病句——
  // "发挥日益重要的作用"被"发挥→起/施展"与"日益→渐渐"各改一头，
  // 拼出"起渐渐重要的作用"；"源源不断"被"不断→接连"腰斩成"源源接连"。
  // 固定搭配整组跳过逐字替换，交由套话清除层做整体处理。
  日益: ["发挥"],
  不断: ["源源"],
  // v0.8.9 技术复合词守卫（P0）：前缀构成固定术语时禁止替换，否则会产生残缺词
  构建: ["预", "重", "再", "可", "搭", "构"], // 预构建→预搭、重构→重搭
  支持: ["不", "支"], // 不支持→"不帮"（语义错误）
  基于: ["是", "都", "也"], // 基于→"拿"后接判断句时语法崩坏
  生成: ["预", "再"], // 预生成/再生成
  编译: ["预", "交叉"], // 预编译/交叉编译
  部署: ["热", "灰度", "自动化"], // 热部署/灰度部署
  加载: ["预", "懒", "热"], // 预加载/懒加载/热加载
};
export const GUARD_AFTER: Record<string, string[]> = {
  价值: [
    "最大化",
    "化",
    "观",
    "链",
    "百",
    "千",
    "万",
    "亿",
    "元",
    "连城",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
  ],
  发挥: ["日益"], // "发挥日益"整组保护（与 GUARD_BEFORE.日益 配对）
  实现: ["最大化", "共赢"],
  提升: ["到了"], // "提升到了"已完成时态，别再动
  持续: ["性"], // "持续性"
  针对: ["性"], // "针对性"
  通过: ["了", "对"], // "通过了考试"是动词义，"靠了考试"错义；"通过对N"介词义，"借对"病句
  个性化: ["课程", "教学"], // v0.8.5 收窄："学习/方案"前改用"因人而异的"已可搭配，不再全拦
  // v0.8.9 技术复合词守卫（P0）：后缀构成技术术语时禁止替换
  // "构建工具"→"建工具"、"构建机制"→"搭机制" 属于术语残缺，一眼可辨的机器破坏
  构建: [
    "工具",
    "机制",
    "系统",
    "模型",
    "流程",
    "平台",
    "体系",
    "依赖",
    "产物",
    "环境",
    "图",
    "速度",
    "时间",
    "过程",
    "配置",
    "脚本",
    "流水线",
    "索引",
    "缓存",
    "链路",
    "模式",
    "产物链",
    "产物图",
    "任务",
    "服务",
    "管线",
    "镜像",
    "包",
  ],
  // 注意：不要加"数据"——「基于大数据」是黑话清零用例（LEAK_WORDS）里的必替换项，
  // 且"依托数据"语序本身成立，拦了反而造成黑话泄漏。
  基于: [
    "浏览器",
    "原生",
    "ESM",
    "事实",
    "模型",
    "算法",
    "框架",
    "协议",
    "接口",
    "平台",
    "此",
    "上述",
    "以下",
    "规则",
    "模板",
    "引擎",
    "内核",
    "协议栈",
  ],
  支持: ["向量", "度", "率"], // 支持向量机/支持度
  部署: ["流水", "脚本", "工具"], // 部署流水线
};

const guardMemo = new Map<string, boolean>();

/** 带记忆化的命中护栏：同词+同上下文窗口直接复用判定（纯函数，热路径） */
export function guardBlocks(from: string, context: string, before: string): boolean {
  const key = from + "\u0000" + context + "\u0000" + before;
  const hit = guardMemo.get(key);
  if (hit !== undefined) return hit;
  const blocked = judgeGuardBlocks(from, context, before);
  guardMemo.set(key, blocked);
  return blocked;
}

function judgeGuardBlocks(from: string, context: string, before: string): boolean {
  // v0.8.9 混排守卫（P0 安全网）：命中词紧贴 ASCII 标识符/数字/代码符号时跳过替换。
  // 技术文本里中文动词与英文标识符、数字、路径紧邻 = 术语或参数上下文，
  // 替换后极易产生 "不帮 CommonJS"、"预搭阶段" 这类语义错误。
  if (before && /[A-Za-z0-9._\-/]$/.test(before)) return true;
  if (context && /^[A-Za-z0-9._\-/]/.test(context)) return true;

  // v0.9.1 名词位替身守卫：「的+V」是中文名物化修饰结构（"实现的突破"=the realized breakthrough），
  // 替换 V 为口语替身会产出"的弄成的突破"式病句——口语动词不能做名物化定语。
  // scan-bugs v5.2「名词位替身」86 次违规的根因。通用守卫：前缀"的"即跳过。
  if (before && /的$/.test(before)) return true;

  const pre = GUARD_BEFORE[from];
  if (pre) {
    for (const g of pre) {
      if (before.endsWith(g)) return true;
    }
  }
  const post = GUARD_AFTER[from];
  if (post) {
    // 后缀守卫用窗口包含："实现阅读的价值最大化"里"最大化"离动词隔了几个字
    for (const g of post) {
      if (context.slice(0, 8).includes(g)) return true;
    }
  }
  return false;
}

/* ---------------- 剧本场景块全格式保真护栏（P8） ---------------- */
/**
 * 剧本【场景/人物/角色/地点/时间/背景/旁白/简介】块头行判定。
 * 块头是元数据不是行文：relaxColon 会把它改成【场景，…】、injectParentheticals 会
 * 往里塞"——真要说起来——"、injectDialect 会把"从早上八点"改成"打从早上八点"、
 * injectHumanTypos 会单字替换——任何注入/机械改写都应跳过整行。
 * 判定口径：行首为【 且行内含场景块关键字（无锚，行内包含）。
 */
const SCENE_BLOCK_LINE_RE = /【[^】]{0,80}(?:场景|人物|角色|地点|时间|背景|旁白|简介)[^】]{0,80}】/;

export function isSceneBlockLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("【") && SCENE_BLOCK_LINE_RE.test(t);
}

/**
 * 剧本台词行判定（v0.9.8 P0）。
 *
 * 形态：`说话人：台词` 或 `说话人（角色）：台词`，如
 *   「张总（项目经理）：这个季度的指标完成得怎么样了？」
 *   「李工：主流程已经联调完毕。」
 *
 * 为什么需要单独判定：块头保护只认【…】行，台词行会漏网。实测 0.9 档对话体：
 *   injectOpinion 把垫词插到说话人**前面**（「讲真，张总（项目经理）：…」）
 *   injectParentheticals 把插话插到台词**中间**（「收到，往好听了说。我让李工整理好发群里。」）
 * 两者都破坏剧本格式——说话人标签前不得有修饰，台词内不得插叙述。
 * 剧本格式一旦被破坏，整篇台词区的可读性就没了，比一般语体错位更严重。
 *
 * 判定口径：行首 1~12 个汉字（+可选（）角色注）紧跟全角/半角冒号。
 * 只匹配行首，避免把正文里的「注意：…」类短句误判（正文行首通常更长且无冒号紧贴）。
 */
const SCENE_DIALOGUE_LINE_RE = /^[\u4e00-\u9fa5A-Za-z0-9]{1,12}(?:[（(][^）)]{0,12}[）)])?[：:]/;

export function isSceneDialogueLine(line: string): boolean {
  return SCENE_DIALOGUE_LINE_RE.test(line.trimStart());
}

/** 剧本行总判定：块头行或台词行 —— 注入器应跳过（保格式） */
export function isScriptFormatLine(line: string): boolean {
  return isSceneBlockLine(line) || isSceneDialogueLine(line);
}
