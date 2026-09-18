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
    localStorage.setItem(LEGACY_KEY, JSON.stringify([{ local: "x", official: null }, { local: 40, official: 55, ts: 1 }]));
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
      JSON.stringify([{ local: null, official: 99, ts: 1 }, { local: 40, official: 55, ts: 2 }]),
    );
    const cal = addCalibPoint(70, 80);
    const stored = JSON.parse(localStorage.getItem(LEGACY_KEY) as string) as Array<{ local: number }>;
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
