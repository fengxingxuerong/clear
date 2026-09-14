/**
 * src/engine/term-protect.ts —— 中文术语/专名保护清单（v0.8.6，竞品对标能力）
 *
 * 背景：竞品（言笔/笔灵/SpeedAI/快降重等）主打「专业术语零改动」——法学"善意取得"、
 * 医学专名、理工科术语被改坏是用户最大痛点。本项目已有事后拦截（checkFidelityLocal
 * 查英文术语/数字丢失），但缺事前保护：中文术语本身不在检查范围。
 *
 * 机制：这些词条禁止被 replaceVocab 替换、禁止被拆句切断——命中即跳过。
 * 与 SCORING_EXCLUDE 互补：那边管"不计分"，这边管"不许动"。
 * 用户可通过 setProtectedTerms() 扩充自定义术语（如论文题目、人名、产品名）。
 */

/** 内置中文术语保护集：跨学科高频易错词（替换/拆句时原样保留） */
const BUILT_IN_TERMS = new Set<string>([
  // 法学
  "善意取得",
  "无因管理",
  "不当得利",
  "表见代理",
  "缔约过失",
  "罪刑法定",
  "正当防卫",
  "紧急避险",
  "诉讼时效",
  "举证责任",
  "物权变动",
  "公示公信",
  // 经济/金融
  "边际效应",
  "机会成本",
  "通货膨胀",
  "量化宽松",
  "供需关系",
  "规模经济",
  "基尼系数",
  "恩格尔系数",
  "国内生产总值",
  "消费者物价指数",
  // 医学
  "细胞凋亡",
  "免疫应答",
  "血脑屏障",
  "基因表达",
  "临床试验",
  "随机对照",
  "不良反应",
  "禁忌症",
  "适应性免疫",
  "获得性免疫",
  // 理工/计算机
  "机器学习",
  "深度学习",
  "神经网络",
  "强化学习",
  "联邦学习",
  "边缘计算",
  "量子纠缠",
  "基因编辑",
  "碳中和",
  "碳达峰",
  "光刻机",
  "芯片制程",
  "操作系统",
  "分布式系统",
  "容错机制",
  "负载均衡",
  "数据挖掘",
  // 教育/社科
  "因材施教",
  "立德树人",
  "核心素养",
  "产教融合",
  "终身学习",
  "城镇化率",
  "基期",
  "同比",
  "环比",
]);

/** 用户自定义扩充集（会话级，UI/调用方可注入） */
const userTerms = new Set<string>();

/** 注入自定义保护术语（如论文题目、人名、产品名、领域专名） */
export function setProtectedTerms(terms: string[]): void {
  userTerms.clear();
  for (const t of terms) {
    const k = t.trim();
    if (k.length >= 2) userTerms.add(k);
  }
}

/** 清空用户自定义术语 */
export function clearProtectedTerms(): void {
  userTerms.clear();
}

/** 是否为受保护术语（原文含该词 → 替换/切分跳过） */
export function isProtectedTerm(text: string, from: number, to: number): boolean {
  const seg = text.slice(from, to);
  if (BUILT_IN_TERMS.has(seg) || userTerms.has(seg)) return true;
  // 词边界延伸：命中词是某受保护术语的子串（如 "机器学习" 在 "机器学习模型" 内）
  for (const term of BUILT_IN_TERMS) {
    if (term.includes(seg) && term !== seg) {
      // 仅当切片前后紧邻字符能拼出完整术语才保护（避免过度拦截）
      const before = text.slice(Math.max(0, from - term.length + seg.length), from);
      const after = text.slice(to, to + term.length - seg.length);
      if ((before + seg + after).includes(term)) return true;
    }
  }
  for (const term of userTerms) {
    if (term.includes(seg) && term !== seg) {
      const before = text.slice(Math.max(0, from - term.length + seg.length), from);
      const after = text.slice(to, to + term.length - seg.length);
      if ((before + seg + after).includes(term)) return true;
    }
  }
  return false;
}

/** 内置保护词列表（测试/展示用） */
export function builtinProtectedTerms(): string[] {
  return [...BUILT_IN_TERMS];
}
