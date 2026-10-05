// @vitest-environment happy-dom
/**
 * BenchmarkPanel 渲染级测试：对标评分面板的双通道按钮、v3 体裁轨道联动
 * （自动识别 / 手动 override / 回到自动 / 引擎上抛）、朱雀送检回填行。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { BenchmarkPanel } from "./BenchmarkPanel";
import { DEFAULT_API } from "../api/llm-config";
import { DEFAULT_DETECTOR } from "../api/detector";
import { CALIB } from "../engine/zhuque-calib";
import type { ScoreBreakdown } from "../engine/humanize";

afterEach(() => cleanup());

const EXPO_TEXT =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。";

/** 叙事文样本：自动识别走 rule 3 → narrative，且满足「疑似纯人写原稿」快捷按钮的
 *  特征门槛（narPastRatio 0.089 ≥ 0.04、expoScore 0.15 < 0.35、dlgColonRatio 0 < 0.03） */
const NARR_TEXT =
  "去年春天我去了苏州旅行。到了古镇以后，我们住在一家小旅馆里，老板娘端上了桂花糕。我和朋友沿着河边散步，聊到很晚才回房。第二天我们又去了园林，在假山旁拍了很多照片。回到旅馆时已经下起了小雨，屋檐下的水滴声让人想起从前的日子。";

const after: ScoreBreakdown = {
  score: 20,
  formulaicHits: 2,
  burstiness: 0.4,
  avgLen: 20,
  sentenceCount: 5,
};

function base(overrides: Partial<Parameters<typeof BenchmarkPanel>[0]> = {}) {
  return {
    output: EXPO_TEXT,
    after,
    roundScores: [] as number[],
    judging: false,
    detecting: false,
    api: { ...DEFAULT_API },
    detector: { ...DEFAULT_DETECTOR },
    judgeScore: null,
    judgeCritique: [] as string[],
    detectorScore: null,
    zhuqueManualScore: "",
    onJudge: vi.fn(),
    onDetect: vi.fn(),
    onManualScore: vi.fn(),
    onGenreChange: vi.fn(),
    onNote: vi.fn(),
    ...overrides,
  };
}

describe("BenchmarkPanel（对标评分面板）", () => {
  it("output 为空时整块不渲染", () => {
    const { container } = render(<BenchmarkPanel {...base({ output: "" })} />);
    expect(container.textContent).toBe("");
  });

  it("渲染标题与本地代理分；双通道按钮在未配置时禁用", () => {
    const { getByText } = render(<BenchmarkPanel {...base()} />);
    expect(getByText("对标评分（真实通道，非本地代理分）")).toBeTruthy();
    expect(getByText("20")).toBeTruthy();
    const judge = getByText("用 LLM 评判").closest("button") as HTMLButtonElement;
    const detect = getByText("用外部检测器").closest("button") as HTMLButtonElement;
    expect(judge.disabled).toBe(true);
    expect(detect.disabled).toBe(true);
  });

  it("API/检测器配置后按钮可用并触发回调；结果分显示", () => {
    const onJudge = vi.fn();
    const onDetect = vi.fn();
    const p = base({
      api: { ...DEFAULT_API, enabled: true, apiKey: "sk-x" },
      detector: { ...DEFAULT_DETECTOR, enabled: true, url: "https://d/api" },
      judgeScore: 35,
      judgeCritique: ["口语对仗"],
      detectorScore: 60,
      onJudge,
      onDetect,
    });
    const { getByText } = render(<BenchmarkPanel {...p} />);
    fireEvent.click(getByText("用 LLM 评判"));
    fireEvent.click(getByText("用外部检测器"));
    expect(onJudge).toHaveBeenCalledTimes(1);
    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(getByText("LLM 评判：35")).toBeTruthy();
    expect(getByText("检测器：60")).toBeTruthy();
    expect(getByText(/残留痕迹：口语对仗/)).toBeTruthy();
  });

  it("评判中/检测中状态：按钮换文案且禁用，点击不触发回调", () => {
    const onJudge = vi.fn();
    const onDetect = vi.fn();
    const p = base({
      api: { ...DEFAULT_API, enabled: true, apiKey: "sk-x" },
      detector: { ...DEFAULT_DETECTOR, enabled: true, url: "https://d/api" },
      judging: true,
      detecting: true,
      onJudge,
      onDetect,
    });
    const { getByText } = render(<BenchmarkPanel {...p} />);
    const judge = getByText("评判中…").closest("button") as HTMLButtonElement;
    const detect = getByText("检测中…").closest("button") as HTMLButtonElement;
    expect(judge.disabled).toBe(true);
    expect(detect.disabled).toBe(true);
    fireEvent.click(judge);
    fireEvent.click(detect);
    expect(onJudge).not.toHaveBeenCalled();
    expect(onDetect).not.toHaveBeenCalled();
  });

  it("深度轮次分渲染（含失败轮显示「失败」与目标分）", () => {
    const { getByText } = render(<BenchmarkPanel {...base({ roundScores: [60, -1, 25] })} />);
    expect(getByText(/60 → 失败 → 25/)).toBeTruthy();
    expect(getByText(/目标 ≤10/)).toBeTruthy();
  });

  it("v3 预测区：显示官方朱雀%预测、过人线徽章与建议行动卡", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    expect(container.textContent).toContain("官方朱雀%预测");
    // main 线：2.014 × 20 + 19.06 ≈ 59.3% → 离 40% 过人线还差
    expect(container.textContent).toContain("离过人线还差");
    expect(container.textContent).toContain("💡 建议行动");
  });

  /* ---- v3 建议行动卡的三档预测分支（pct ≤20 / 20~40 / >80 + 饱和区） ---- */

  it("预测 ≤20% 且非人写线：建议行动给「已稳过」，徽章显示领先边际", () => {
    // aiScore=0 → main 线 2.014×0+19.06=19.06% ≤20：走 pct≤20 的 recAction（非 humanWarn 那档）
    const { container } = render(<BenchmarkPanel {...base({ after: { ...after, score: 0 } })} />);
    expect(container.textContent).toContain("已稳过。如果还想更稳");
    expect(container.textContent).toContain("✅ 19.1%");
    expect(container.textContent).toContain("✅ 领先过人线 20.9 pp 边际");
  });

  it("预测 20~40%：建议行动给「已过但离过线近」，🟢 图标 + 过人线 tip", () => {
    // aiScore=10 → main 线 2.014×10+19.06≈39.2%：走 20<pct≤40 的 recAction + 🟢 图标档
    const { container } = render(<BenchmarkPanel {...base({ after: { ...after, score: 10 } })} />);
    expect(container.textContent).toContain("已过但离过线近");
    expect(container.textContent).toContain("🟢 39.2%");
    expect(container.textContent).toContain(
      "已过 论说过人线 aiScore ≤ 10.4；如需更稳，再跑一轮 0.9 朱雀档",
    );
    expect(container.textContent).toContain("✅ 领先过人线 0.8 pp 边际");
  });

  it("预测恰好压在 40% 过人线上：徽章显示「刚好过人线」边界文案", () => {
    // score 取 (40-b)/a 使预测浮点恰为 40 → gapToPass === 0 的边界分支
    const edge = (40 - CALIB.main.b) / CALIB.main.a;
    const { container } = render(<BenchmarkPanel {...base({ after: { ...after, score: edge } })} />);
    expect(container.textContent).toContain("🟢 40.0%");
    expect(container.textContent).toContain("🤏 刚好过人线");
  });

  it("预测进入饱和区（aiScore ≥ satX）：饱和 tip + 接近饱和建议 + 60pp 差距徽章", () => {
    // aiScore=50 ≥ main 线 satX=40.2 → 预测 clamp 到 100%：saturated tip + pct>80 的 recAction
    const { container } = render(<BenchmarkPanel {...base({ after: { ...after, score: 50 } })} />);
    expect(container.textContent).toContain("🔴 100.0%");
    expect(container.textContent).toContain(
      "预测已饱和到 98~99% 区（aiScore≥40 进入饱和），官方基本必判 AI",
    );
    expect(container.textContent).toContain("接近饱和！先用 humanize-vocab");
    expect(container.textContent).toContain("⚠️ 离过人线还差 60.0 pp");
  });

  it("预测 80~98% 高危区间：越过 🟠 档落入空 else，保持默认红色图标与「严重 AI 味」", () => {
    // aiScore=35 → main 线 ≈89.5%：既不 ≤80（🟠 档）也未到 98/饱和 → 图标保持初始 🔴
    const { container } = render(<BenchmarkPanel {...base({ after: { ...after, score: 35 } })} />);
    expect(container.textContent).not.toContain("🟠");
    expect(container.textContent).toContain("严重 AI 味（几乎必中官方检测）");
    expect(container.textContent).toMatch(/🔴 89\.[0-9]%/);
    expect(container.textContent).toMatch(/离过人线还差 49\.[0-9] pp/);
  });

  it("副线 concat 低分落在 40~60%：中风险档走 x40<0 的放宽阈值文案", () => {
    // concat 截距 57.441、x40 为负：score=0 → pct 57.4 ∈ (40,60] → 🟡 档取 x40<0 分支
    const { container } = render(<BenchmarkPanel {...base({ after: { ...after, score: 0 } })} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "concat" } });
    expect(container.textContent).toContain("🟡 57.4%");
    expect(container.textContent).toContain("中风险（对话/叙事体裁放宽阈值）");
  });

  it("自动识别徽章显示体裁（论说文）且默认轨道为 main", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    expect(container.textContent).toContain("🤖 自动识别");
    expect(container.textContent).toContain("论说文");
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("main");
  });

  it("手动切到对话线：轨道上抛引擎、显示「手动轨道」与「回到自动」", () => {
    const onGenreChange = vi.fn();
    const { container } = render(<BenchmarkPanel {...base({ onGenreChange })} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    expect(onGenreChange).toHaveBeenCalledWith("dialogue");
    expect(container.textContent).toContain("⚙️ 手动轨道");
    const reset = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("回到自动"),
    ) as HTMLButtonElement;
    expect(reset).toBeTruthy();
  });

  it("手动切回与自动识别一致的轨道：override 被解除、徽章回到「自动识别」", () => {
    const onGenreChange = vi.fn();
    const { container } = render(<BenchmarkPanel {...base({ onGenreChange })} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    expect(container.textContent).toContain("⚙️ 手动轨道");
    // 再选回 auto.genre（main）→ next === auto.genre，走 else-if 把 override 清掉
    fireEvent.change(select, { target: { value: "main" } });
    expect(onGenreChange).toHaveBeenCalledWith("main");
    expect(select.value).toBe("main");
    expect(container.textContent).toContain("🤖 自动识别");
    expect(container.textContent).not.toContain("⚙️ 手动轨道");
  });

  it("「回到自动」按钮：清 override、轨道按 auto 重切并上抛 null 给引擎", () => {
    const onGenreChange = vi.fn();
    const { container, getByText, queryByText } = render(
      <BenchmarkPanel {...base({ onGenreChange })} />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    expect(getByText("回到自动")).toBeTruthy();
    fireEvent.click(getByText("回到自动"));
    expect(onGenreChange).toHaveBeenLastCalledWith(null);
    expect(select.value).toBe("main");
    expect(container.textContent).toContain("🤖 自动识别");
    expect(container.textContent).not.toContain("⚙️ 手动轨道");
    // override 解除后「回到自动」按钮不再渲染
    expect(queryByText("回到自动")).toBeNull();
  });

  it("未传可选的 onGenreChange：切轨与「回到自动」照常工作且不抛错", () => {
    const { container, getByText } = render(
      <BenchmarkPanel {...base({ onGenreChange: undefined })} />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    expect(select.value).toBe("dialogue");
    expect(container.textContent).toContain("⚙️ 手动轨道");
    // 回到自动走 onGenreChange?.(null) 可选链：缺省时安全跳过
    fireEvent.click(getByText("回到自动"));
    expect(select.value).toBe("main");
    expect(container.textContent).toContain("🤖 自动识别");
  });

  it("预测值随体裁轨道切换重算（对话线截距不同）", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    const before = container.querySelector(".zq-big, .bench")!.textContent!;
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    // 对话线：0.8827 × 20 + 26.5 ≈ 44.2%；与 main 的 59.3% 不同
    const pct = CALIB.dialogue.a * 20 + CALIB.dialogue.b;
    expect(container.textContent).toContain(pct.toFixed(1) + "%");
    expect(before).toBeTruthy();
  });

  it("人写线：切换后触发引擎上抛 humanHand；纯人写稿文案触发警示横幅", () => {
    const onGenreChange = vi.fn();
    const { container } = render(<BenchmarkPanel {...base({ onGenreChange })} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "human" } });
    expect(onGenreChange).toHaveBeenCalledWith("humanHand");
    // 副线 concat 属高级分组：直接切换也应上抛 null
    fireEvent.change(select, { target: { value: "concat" } });
    expect(onGenreChange).toHaveBeenCalledWith(null);
  });

  it("疑似纯人写原稿快捷按钮：点击切 human 负斜率轨道并显示人写警示横幅", () => {
    const onGenreChange = vi.fn();
    const { container, getByText, queryByText } = render(
      <BenchmarkPanel {...base({ output: NARR_TEXT, onGenreChange })} />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("narrative"); // 自动识别命中叙事线（rule 3）
    fireEvent.click(getByText("🚩 疑似纯人写原稿 → 切负斜率轨道(H0 官=15%)"));
    // 上抛 humanHand + 轨道切到 human：-0.3×20+18 = 12.0%
    expect(onGenreChange).toHaveBeenLastCalledWith("humanHand");
    expect(select.value).toBe("human");
    expect(container.textContent).toContain("⚙️ 手动轨道");
    expect(container.textContent).toContain("✅ 12.0%");
    expect(container.textContent).toContain("请不要跑去味"); // humanWarn 警示横幅
    expect(queryByText(/切负斜率轨道/)).toBeNull(); // 切走后快捷按钮消失
    expect(getByText(/回到三分自动识别/)).toBeTruthy(); // 换成「回到三分」按钮
  });

  it("朱雀送检行：手动分数上抛；回填 <30 显示 ✅、≥30 显示 ❌", () => {
    const onManualScore = vi.fn();
    const p = base({ onManualScore });
    const { container, rerender } = render(<BenchmarkPanel {...p} />);
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "28" } });
    expect(onManualScore).toHaveBeenCalledWith("28");
    rerender(<BenchmarkPanel {...base({ onManualScore, zhuqueManualScore: "28" })} />);
    expect(container.textContent).toContain("朱雀：28 ✅");
    rerender(<BenchmarkPanel {...base({ onManualScore, zhuqueManualScore: "65" })} />);
    expect(container.textContent).toContain("朱雀：65 ❌");
  });

  it("朱雀送检按钮：复制去味文本、打开官方送检页并上抛提示语", () => {
    const onNote = vi.fn();
    // 用可断言的桩替换 clipboard 与 window.open，避免真实打开浏览器页
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const { getByText } = render(<BenchmarkPanel {...base({ onNote })} />);
    fireEvent.click(getByText("🔍 朱雀送检（免费网页版）"));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(EXPO_TEXT);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://matrix.tencent.com/ai-detect/ai_gen_txt/",
      "_blank",
    );
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(onNote).toHaveBeenCalledWith(
      "已复制去味文本并打开朱雀检测页——粘贴检测后，在下方填入朱雀分",
    );
    openSpy.mockRestore();
  });

  it("API 与检测器都未启用时显示免费路径提示", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    expect(container.textContent).toContain("对标检测两条路径");
  });

  /* ---- 本地代理分 vs 外部通道分的分歧横幅（2026-09-22 外评证据） ---- */

  it("本地分低报：渲染 severe 横幅，点名通道并写明别看降幅", () => {
    // 本地 20（人写带内）/ 评判 85 → gap 65，实测形态与「政务报告 本地 2 / 外部 90」同类
    const { container } = render(<BenchmarkPanel {...base({ judgeScore: 85 })} />);
    expect(container.textContent).toContain("本地代理分 20");
    expect(container.textContent).toContain("LLM 评判 85");
    expect(container.textContent).toContain("降幅");
  });

  it("分歧不到门槛就不渲染横幅（本地 20 / 评判 25，差 5）", () => {
    const { container } = render(<BenchmarkPanel {...base({ judgeScore: 25 })} />);
    expect(container.textContent).not.toContain("两把尺分歧");
    expect(container.textContent).not.toContain("低报");
  });

  it("朱雀手动回填的高分同样触发，且文案点名朱雀官方分", () => {
    const { container } = render(<BenchmarkPanel {...base({ zhuqueManualScore: "90" })} />);
    expect(container.textContent).toContain("朱雀官方分 90");
  });

  it("多通道同时分歧：取 severe 里 gap 最大的那条", () => {
    const { container } = render(
      <BenchmarkPanel {...base({ judgeScore: 85, detectorScore: 75 })} />,
    );
    expect(container.textContent).toContain("LLM 评判 85");
    expect(container.textContent).not.toContain("外部检测器 75");
  });

  it("分歧在人写带之外（本地 40 / 评判 90）：warn 级黄色横幅，文案不扣「人写带」帽子", () => {
    // local 40 > AI_SCORE_HUMAN_MAX(27)，gap 50 ≥30、外部 90 ≥60 → warn 而非 severe
    const { container, getByText } = render(
      <BenchmarkPanel {...base({ after: { ...after, score: 40 }, judgeScore: 90 })} />,
    );
    expect(container.textContent).toContain("两把尺分歧 50 分（本地 40 / LLM 评判 90）");
    expect(container.textContent).not.toContain("（人写带）");
    // warn 用黄色底（rgba(250,204,21,0.1)），不是 severe 的红色底
    const row = getByText(/两把尺分歧/).closest(".bench-row") as HTMLElement;
    const style = (row.getAttribute("style") ?? "").replace(/\s/g, "");
    expect(style).toContain("rgba(250,204,21,0.1)");
  });
});
