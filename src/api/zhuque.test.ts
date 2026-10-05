// @vitest-environment happy-dom
/**
 * 朱雀官方送检通道测试
 * ---------------------------------------------------------
 * 本模块是「官方分数」进入校准库的唯一入口：parseOfficialResult 解析错一个数，
 * 校准映射（本地分 ↔ 官方分）就会被静默带偏，而且从 UI 上完全看不出来
 * （校准点照常增加、拟合照常成功，只是整条线歪了）。所以解析必须单测锁死。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ZHUQUE_MIN_CHARS, ZHUQUE_URL } from "../engine/zhuque.ts";
import {
  addCalibPoint,
  buildSubmission,
  clearCalibPoints,
  copyText,
  loadCalibPoints,
  openOfficial,
  parseOfficialResult,
  saveCalibPoints,
  submissionAdvice,
} from "./zhuque.ts";

const LEGACY_KEY = "quaiwei.zhuque.calib";

beforeEach(() => {
  localStorage.clear();
});

/* ------------------------------ 解析 ------------------------------ */

describe("parseOfficialResult（空输入）", () => {
  it("空串与纯空白都判定为解析失败", () => {
    for (const s of ["", "   ", "\n\t"]) {
      const r = parseOfficialResult(s);
      expect(r.ok).toBe(false);
      expect(r.probability).toBeNull();
    }
  });

  it("空输入给出人话提示，而不是静默返回 0", () => {
    expect(parseOfficialResult("").note).toContain("粘贴内容为空");
  });

  it("无法解析时提示正确粘贴格式", () => {
    expect(parseOfficialResult("随便一段话").note).toContain("AI生成 99.99%");
  });
});

describe("parseOfficialResult（档位 + 数值）", () => {
  it("AI生成 99.99%", () => {
    const r = parseOfficialResult("AI生成 99.99%");
    expect(r.ok).toBe(true);
    expect(r.probability).toBe(99.99);
    expect(r.label).toBe("ai");
  });

  it("带冒号与空格的官方文案：AI 生成概率：98.47%", () => {
    const r = parseOfficialResult("AI 生成概率：98.47%");
    expect(r.probability).toBe(98.47);
    expect(r.label).toBe("ai");
  });

  it("疑似AI辅助 62.3%", () => {
    const r = parseOfficialResult("疑似AI辅助 62.3%");
    expect(r.probability).toBe(62.3);
    expect(r.label).toBe("suspected");
  });

  it("AI特征占比 62%", () => {
    const r = parseOfficialResult("AI特征占比 62%");
    expect(r.probability).toBe(62);
    expect(r.label).toBe("ai");
  });

  it("档位词与数字间无空格也能解析", () => {
    expect(parseOfficialResult("AI生成99.99%").probability).toBe(99.99);
  });
});

describe("parseOfficialResult（官方三段占比 —— 核心回归点）", () => {
  // v0.9.10 修复：旧逻辑先按优先级定档为 ai，再取文本里"第一个"百分比，
  // 结果拿到人工特征的 0.01% —— label=ai 却配 probability=0.01，
  // 这种矛盾点进校准库会把映射彻底带偏。
  it("三段占比必须取命中档位那一段的百分比，而不是第一个", () => {
    const r = parseOfficialResult("人工特征 0.01%\n疑似AI辅助 0%\nAI生成 99.99%");
    expect(r.label).toBe("ai");
    expect(r.probability).toBe(99.99);
  });

  it("疑似档同理：不得跨档取到人工特征的 100%", () => {
    const r = parseOfficialResult("疑似AI辅助 0%\n人工特征 100%");
    expect(r.label).toBe("suspected");
    expect(r.probability).toBe(0);
  });

  it("只有疑似与人工两段时取疑似段", () => {
    const r = parseOfficialResult("人工特征 85%\n疑似AI辅助 15%");
    expect(r.label).toBe("suspected");
    expect(r.probability).toBe(15);
  });
});

describe("parseOfficialResult（只有一半信息时互证）", () => {
  it("只有档位没有分数：给档位中值", () => {
    expect(parseOfficialResult("人工特征").probability).toBe(10);
    expect(parseOfficialResult("AI生成").probability).toBe(90);
    expect(parseOfficialResult("疑似AI辅助").probability).toBe(50);
  });

  it("只有分数没有档位：按官方口径定档（≥60 ai / ≥30 suspected）", () => {
    expect(parseOfficialResult("99.99%").label).toBe("ai");
    expect(parseOfficialResult("62%").label).toBe("ai");
    expect(parseOfficialResult("45%").label).toBe("suspected");
    expect(parseOfficialResult("12%").label).toBe("human");
  });

  it("定档边界恰好落在阈值上（60 → ai，30 → suspected）", () => {
    expect(parseOfficialResult("60%").label).toBe("ai");
    expect(parseOfficialResult("59.9%").label).toBe("suspected");
    expect(parseOfficialResult("30%").label).toBe("suspected");
    expect(parseOfficialResult("29.9%").label).toBe("human");
  });
});

describe("parseOfficialResult（异常与夹取）", () => {
  it("超过 100 夹到 100", () => {
    expect(parseOfficialResult("150%").probability).toBe(100);
  });

  it("负百分比不得被读成正数（不吃掉负号）", () => {
    const r = parseOfficialResult("-5%");
    expect(r.ok).toBe(false);
    expect(r.probability).toBeNull();
  });

  it("两位小数精度保留", () => {
    expect(parseOfficialResult("AI生成 62.345%").probability).toBe(62.35);
  });

  it("数字与百分号间有空格也能解析", () => {
    expect(parseOfficialResult("概率： 82 %").probability).toBe(82);
  });

  // 补 clampPct 的 !isFinite 分支（zhuque.ts:210，此前 0 覆盖）：
  // parseFloat 对 309 位以上的数字返回 Infinity，若没有这道兜底，
  // Math.min(100, Infinity) 会把它夹成 100 —— 凭空造出一个满分 AI 判定。
  it("超长数字 parseFloat 出 Infinity 时归 0，而不是被夹成 100", () => {
    const r = parseOfficialResult(`AI生成 ${"9".repeat(400)}%`);
    expect(r.probability).toBe(0);
    expect(r.probability).not.toBe(100);
  });
});

/* ------------------------------ 复制兜底 ------------------------------ */

describe("copyText（剪贴板回退路径）", () => {
  it("clipboard 拒绝 + execCommand 抛错 → 返回 false 且不冒泡（zhuque.ts:94，此前 0 覆盖）", async () => {
    const d = document as Document & { execCommand?: () => boolean };
    const nav = navigator as Navigator & { clipboard?: { writeText?: () => Promise<void> } };
    const origExec = d.execCommand;
    const origClip = nav.clipboard;
    // 第一段：navigator.clipboard 存在但被拒（非安全上下文/权限被拒的真实形态）→ 落到 textarea 降级
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("Write permission denied")) },
    });
    expect(nav.clipboard?.writeText).toBeTruthy(); // 前置条件：桩确实生效，否则测的是第一条路径
    // 第二段：textarea 降级里 execCommand 也不可用 → 走 catch 返回 false
    Object.defineProperty(d, "execCommand", {
      configurable: true,
      value: () => {
        throw new Error("not supported");
      },
    });
    try {
      await expect(copyText("要复制的官方送检文本")).resolves.toBe(false);
    } finally {
      if (origExec)
        Object.defineProperty(d, "execCommand", { configurable: true, value: origExec });
      else Reflect.deleteProperty(d, "execCommand");
      if (origClip)
        Object.defineProperty(nav, "clipboard", { configurable: true, value: origClip });
      else Reflect.deleteProperty(nav, "clipboard");
    }
  });
});

/* ------------------------------ 送检文本 ------------------------------ */

const longText = (n: number, unit = "这是一个用于测试送检截断的中文句子。") => unit.repeat(n);

describe("buildSubmission", () => {
  it("未超限时原样返回且 truncated=false", () => {
    const t = "短文本。";
    const r = buildSubmission(t);
    expect(r.text).toBe(t);
    expect(r.truncated).toBe(false);
    expect(r.chars).toBe(4);
  });

  it("超限时在句子边界截断，不切碎句子", () => {
    const t = longText(120); // 每句 18 字 × 120 = 2160 字 > 2000
    const r = buildSubmission(t, 2000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
    // 截断点必须落在句末标点上
    expect(r.text.endsWith("。")).toBe(true);
    // 截断后（去空白）不超过上限
    expect(r.text.replace(/\s/g, "").length).toBeLessThanOrEqual(2000);
  });

  it("截断后仍满足官方最低字数门槛", () => {
    const r = buildSubmission(longText(120), 2000);
    expect(r.text.replace(/\s/g, "").length).toBeGreaterThanOrEqual(ZHUQUE_MIN_CHARS);
  });

  it("空输入返回空文本与 chars=0（不抛错）", () => {
    const r = buildSubmission("");
    expect(r.text).toBe("");
    expect(r.chars).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("chars 统计不含空白", () => {
    expect(buildSubmission("中 文\n文 本").chars).toBe(4);
  });
});

/* ------------------------------ 门检提示 ------------------------------ */

describe("submissionAdvice", () => {
  it("0 字：没有可送检的内容", () => {
    expect(submissionAdvice(0)).toBe("没有可送检的内容");
  });

  it(`低于 ${ZHUQUE_MIN_CHARS} 字：提示官方大概率不给结果`, () => {
    expect(submissionAdvice(100)).toContain(`${ZHUQUE_MIN_CHARS}`);
    expect(submissionAdvice(100)).toContain("门槛");
  });

  it("区间内：提示符合送检区间", () => {
    expect(submissionAdvice(800)).toContain("符合官方送检区间");
  });

  it("超长：提示已按句子边界截取", () => {
    expect(submissionAdvice(5000)).toContain("截取");
  });

  it("边界值恰好在门槛上不算不达标", () => {
    expect(submissionAdvice(ZHUQUE_MIN_CHARS)).toContain("符合官方送检区间");
  });
});

/* ------------------------------ 校准存储 ------------------------------ */

describe("校准点存储", () => {
  it("saveCalibPoints 后 loadCalibPoints 可读回（往返一致）", () => {
    saveCalibPoints([
      { local: 40, official: 55, ts: 1 },
      { local: 70, official: 88, ts: 2 },
    ]);
    const pts = loadCalibPoints();
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ local: 40, official: 55 });
    expect(pts[1]).toMatchObject({ local: 70, official: 88 });
  });

  it("脏数据（非数字）被过滤而不是污染拟合", () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify([
        { local: "x", official: null },
        { local: 40, official: 55, ts: 1 },
      ]),
    );
    expect(loadCalibPoints()).toHaveLength(1);
  });

  it("存储内容不是数组时返回空而不是抛错", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ a: 1 }));
    expect(loadCalibPoints()).toEqual([]);
  });

  it("只保留最近 50 条", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ local: i, official: i, ts: i }));
    saveCalibPoints(many);
    expect(loadCalibPoints()).toHaveLength(50);
    // 保留的是末尾（最近）那批
    expect(loadCalibPoints()[49]).toMatchObject({ local: 59 });
  });

  it("addCalibPoint 追加一个点并立即重拟合", () => {
    const c1 = addCalibPoint(40, 55);
    expect(c1.n).toBe(1);
    const c2 = addCalibPoint(70, 88);
    expect(c2.n).toBe(2);
    expect(c2.points).toHaveLength(2);
  });

  it("旧版点里的空值不被读成 0，也不会被写回存储（防永久固化伪观测点）", () => {
    // readLegacyPoints 的结果会被 addCalibPoint 原样写回 localStorage，
    // 旧写法把 {local:null} 读成 local=0，等于往库里永久塞一条 (0, 99) 的假点
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify([
        { local: null, official: 99, ts: 1 },
        { local: 40, official: 55, ts: 2 },
      ]),
    );
    const cal = addCalibPoint(70, 80);
    const stored = JSON.parse(localStorage.getItem(LEGACY_KEY) as string) as Array<{
      local: number;
    }>;
    expect(stored.map((p) => p.local).sort((a, b) => a - b)).toEqual([40, 70]);
    expect(cal.n).toBe(2);
  });

  it("official 为空的旧版点同样被剔除", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify([{ local: 40, official: "", ts: 1 }]));
    expect(loadCalibPoints()).toEqual([]);
  });

  it("clearCalibPoints 清空后重拟合退化为空校准", () => {
    addCalibPoint(40, 55);
    clearCalibPoints();
    expect(loadCalibPoints()).toEqual([]);
  });
});

/* ------------------------------ 打开官方页 ------------------------------ */

describe("openOfficial", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("打开官方地址且带 noopener", () => {
    const spy = vi.spyOn(window, "open").mockReturnValue(null);
    openOfficial();
    expect(spy).toHaveBeenCalledWith(ZHUQUE_URL, "_blank", "noopener,noreferrer");
  });

  it("被浏览器拦截（返回 null）时返回 false", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    expect(openOfficial()).toBe(false);
  });

  it("成功打开时返回 true", () => {
    vi.spyOn(window, "open").mockReturnValue({} as Window);
    expect(openOfficial()).toBe(true);
  });
});

/* 2026-10-05 分支补测：4 处缺口（行 63/76/154/203）都是"边界恰好取等"时才走的另一侧。 */
describe("边界另一侧：截断点为 0、剪贴板 API 缺席、档位词与 pct 标签不匹配", () => {
  afterEach(() => vi.restoreAllMocks());

  it("行 63：整段放不进预算（第一句就超限）→ 退到硬切上限，绝不返回空文本", () => {
    // 前置：正文全是长句但**一个句末标点都没有**，splitSentences 只算得出 0 句 ⇒ last 恒为 0，
    // 这正是行 63 三元的左支（`last > 0 ? ... : text.slice(0, limit)`）。
    const noPunct = "文".repeat(500); // 500 个汉字，零标点
    const r = buildSubmission(noPunct, 100);
    expect(r.truncated).toBe(true);
    expect(r.text).not.toBe(""); // 左支失效就会返回空串 → 送检直接废掉
    expect(r.text).toHaveLength(100);
    // 对照组：有句末标点时走右支，长度按句边界而非硬切
    const withPunct = longText(120);
    const r2 = buildSubmission(withPunct, 2000);
    expect(r2.text.endsWith("。")).toBe(true);
    expect(r2.text.length).toBeGreaterThan(100);
  });

  it("行 76：navigator.clipboard 整个不存在 → 直接走 textarea 降级", async () => {
    // happy-dom 上 execCommand 不存在，必须先钉上去；用 try/finally 严格还原，不泄漏给下一条
    const d = document as Document & { execCommand?: () => boolean };
    const nav = navigator as Navigator & { clipboard?: { writeText?: () => Promise<void> } };
    const origExec = Object.getOwnPropertyDescriptor(d, "execCommand");
    const origClip = Object.getOwnPropertyDescriptor(nav, "clipboard");
    // 前置断言：桩生效——clipboard 被整个摘掉（老浏览器/非安全上下文的真实形态）
    Object.defineProperty(nav, "clipboard", { configurable: true, value: undefined });
    expect(nav.clipboard?.writeText).toBeUndefined();
    const rc = vi.fn(() => true);
    Object.defineProperty(d, "execCommand", { configurable: true, value: rc });
    try {
      expect(await copyText("边界文本")).toBe(true);
      expect(rc).toHaveBeenCalled(); // 真的走了 textarea 降级
    } finally {
      if (origExec) Object.defineProperty(d, "execCommand", origExec);
      else Reflect.deleteProperty(d, "execCommand");
      if (origClip) Object.defineProperty(nav, "clipboard", origClip);
      else Reflect.deleteProperty(nav, "clipboard");
    }
    // 对照组：clipboard 存在时成功路径不碰 execCommand（证明上一条的红确实来自缺席）
    const rc2 = vi.fn(() => true);
    Object.defineProperty(d, "execCommand", { configurable: true, value: rc2 });
    try {
      expect(await copyText("对照组")).toBe(true);
      expect(rc2).not.toHaveBeenCalled();
    } finally {
      if (origExec) Object.defineProperty(d, "execCommand", origExec);
      else Reflect.deleteProperty(d, "execCommand");
    }
  });

  it("行 154：行 153 的 find 恒有值，if(false) 是死分支——真正兜底在行 157 的通用正则", () => {
    // label 只能由遍历 LABELED 产出，而三项 label 互异 ⇒ find 必中 ⇒ 行 154 的 else 不可能。
    // 这条用例转而钉住**真实存在的兜底**：档位词与百分比被长句隔开时专用形态失配，
    // 由行 157 的通用正则从全文另找一处百分比，数值不丢。
    const pasted = "先说结论 AI特征 然后是一段很长的说明文字超过十二个字 88%";
    // 前置自检：专用形态确实不命中（否则这条测不到兜底）
    expect(pasted.indexOf("88%") - pasted.indexOf("AI特征")).toBeGreaterThan(12);
    const r = parseOfficialResult(pasted);
    expect(r.label).toBe("ai"); // 档位仍认出来了
    expect(r.probability).toBe(88); // 数值靠通用兜底救回
    // 对照组：两要素挨得近 → 走专用正则（左支），结论一致才说明兜底不是侥幸
    expect(parseOfficialResult("AI特征 88%").probability).toBe(88);
  });

  it("行 203：行 181 的互证逻辑保证出口处 label 与 probability 至少有一个非空", () => {
    // 静态分析把行 203 标成可达，实测是**死分支**，成因写在源码注释里，这里只钉住成因本身：
    // 行 170 先把「两值皆空」提前 return 掉；行 181 再把「只有分数没档位」按官方口径补出档位。
    // 于是走到行 203 时，probability!==null 必然蕴含 label!==null —— 三元的 else 永不触发。
    // 若哪天下掉了行 181 的互证，这条的前置断言就会先红（届时应改断言而不是庆祝）。
    const half = parseOfficialResult("综合得分 88.2%");
    expect(half.probability).toBe(88.2);
    expect(half.label).toBe("ai"); // 行 181-184 按 ≥60 补出档位，不是"解析出的档位"
    expect(half.note).toBe("已识别：AI生成 88.2%");
    // 三种分数各钉一档，证明补档是按官方口径而非恒定值
    expect(parseOfficialResult("综合得分 45%").label).toBe("suspected");
    expect(parseOfficialResult("综合得分 12%").label).toBe("human");
    // 对照组：档位与分数都在时，note 走 true 分支并报出档位词与数值
    expect(parseOfficialResult("AI生成 99.99%").note).toBe("已识别：AI生成/AI特征 99.99%");
    // 对照组：两值皆空是另一条路（行 170 提前 return），note 完全不同
    expect(parseOfficialResult("一段没有任何可识别字段的话").note).toMatch(/没解析出百分比或档位/);
  });
});
