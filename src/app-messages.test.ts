/**
 * 主界面文案组装纯函数的行为锁（自 App.tsx 抽出时补）。
 *
 * 重点锁「引擎产出如实标注」回归防护（v0.9.15 假话文案修复）：
 * 四种 engine 分支 + 拼接规则 + 短文提示 + 检测器追加段。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildHumanizeNote, formatRestoredNote, ZHUQUE_MIN_CHARS } from "./app-messages";

const DIN = { levelText: "疑似AI", probability: 82 };
const DOUT = { levelText: "人类偏", probability: 35 };
const ZR = { ratios: { ai: 12 }, labelText: "人类创作倾向" };

function base(overrides: Partial<Parameters<typeof buildHumanizeNote>[0]> = {}) {
  return buildHumanizeNote({
    r: { engine: "local", usedApi: false },
    input: "短文本",
    din: DIN,
    dout: DOUT,
    zr: ZR,
    ...overrides,
  });
}

describe("buildHumanizeNote：引擎产出如实标注", () => {
  it("engine=llm 且有 roundScores →「已使用 API 深度去味」", () => {
    const msg = base({ r: { engine: "llm", usedApi: true, roundScores: [88, 42] } });
    expect(msg).toContain("已使用 API 深度去味");
  });

  it("engine=llm 无 roundScores →「已使用 API（LLM）去味」", () => {
    const msg = base({ r: { engine: "llm", usedApi: true, roundScores: [] } });
    expect(msg).toContain("已使用 API（LLM）去味");
  });

  it("engine=mixed → 混拼警告（不能冒充纯 LLM 产出）", () => {
    const msg = base({ r: { engine: "mixed", usedApi: true } });
    expect(msg).toContain("⚠️ 本稿是 LLM + 本地引擎混拼");
    expect(msg).toContain("已本地补位");
  });

  it("engine=passthrough → 文本过短未处理", () => {
    const msg = base({ r: { engine: "passthrough" } });
    expect(msg).toContain("文本过短，未做去味处理");
  });

  it("engine=local 且 usedApi=true → 诚实标注「调用过 API 但最终仍由本地引擎产出」", () => {
    const msg = base({ r: { engine: "local", usedApi: true } });
    expect(msg).toContain("⚠️ 调用过 API 但最终仍由本地引擎产出");
  });

  it("engine=local 且 usedApi=false →「使用本地引擎去味（未走 LLM）」", () => {
    const msg = base({ r: { engine: "local", usedApi: false } });
    expect(msg).toContain("使用本地引擎去味（未走 LLM）");
  });
});

describe("buildHumanizeNote：拼接规则", () => {
  it("r.note 以「 · 」拼接", () => {
    const msg = base({ r: { engine: "local", usedApi: false, note: "深度模式已关闭" } });
    expect(msg).toContain("使用本地引擎去味（未走 LLM） · 深度模式已关闭");
  });

  it("bestOf 择优信息拼接（tried/rejected/seed）", () => {
    const msg = base({
      r: { engine: "local", usedApi: false, bestOf: { tried: 3, rejected: 2, seed: 1 } },
    });
    expect(msg).toContain("多候选择优：3 稿中挑最优（淘汰 2 稿，中选种子 1）");
  });

  it("原文不足 350 字 → 追加朱雀送检门槛提示（含当前字数）", () => {
    const msg = base({ input: "只有十个字" });
    expect(msg).toContain(
      `提示：朱雀检测要求不少于 ${ZHUQUE_MIN_CHARS} 字（当前 5 字），去味本身不受影响`,
    );
  });

  it("原文达到门槛 → 不出现提示", () => {
    const long = "字".repeat(ZHUQUE_MIN_CHARS + 10);
    const msg = base({ input: long });
    expect(msg).not.toContain("提示：朱雀检测要求");
  });

  it("本地检测对照与朱雀口径按固定格式拼接", () => {
    const msg = base({});
    expect(msg).toContain("本地检测：疑似AI(82%) → 人类偏(35%)");
    expect(msg).toContain("朱雀口径：AI特征占比 12%（人类创作倾向）");
  });

  it("detectorNote 追加在末尾（检测器自动送检成功/失败共用）", () => {
    const ok = base({ detectorNote: " · 检测器自动送检：21 分" });
    expect(ok.endsWith(" · 检测器自动送检：21 分")).toBe(true);
    const fail = base({ detectorNote: " · 检测器送检失败：504" });
    expect(fail.endsWith(" · 检测器送检失败：504")).toBe(true);
  });

  it("无 detectorNote → 不追加检测器段", () => {
    const msg = base({});
    expect(msg).not.toContain("检测器");
  });
});

describe("formatRestoredNote：草稿恢复时长文案", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("无时间戳 → 刚刚", () => {
    expect(formatRestoredNote(undefined, 120)).toBe(
      "已恢复刚刚未完成的稿（120 字）。点「清空」可丢弃。",
    );
  });

  it("30 分钟前 → 分钟档", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00"));
    const ts = new Date("2026-09-29T11:30:00").getTime();
    expect(formatRestoredNote(ts, 80)).toContain("已恢复30 分钟前未完成的稿（80 字）");
  });

  it("5 小时前 → 小时档", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00"));
    const ts = new Date("2026-09-29T07:00:00").getTime();
    expect(formatRestoredNote(ts, 80)).toContain("已恢复5 小时前未完成的稿（80 字）");
  });

  it("未来时间戳不出现负数（Math.max(0) 钳制）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00"));
    const ts = new Date("2026-09-29T12:10:00").getTime();
    expect(formatRestoredNote(ts, 10)).toContain("已恢复刚刚未完成的稿");
  });
});
