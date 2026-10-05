// @vitest-environment happy-dom
/**
 * SettingsModal 渲染级测试：草稿-提交模式（编辑不落盘、保存统一上抛）、
 * Esc 关闭、温度失焦归一化、候选数夹取、三个一键预设。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { DEFAULT_API, SENSENOVA_PRESET } from "../api/llm-config";
import { DEFAULT_DETECTOR } from "../api/detector";
import { DEFAULT_LOCAL } from "../store";
import type { ApiConfig } from "../api/llm-config";
import type { DetectorConfig } from "../api/detector";
import type { LocalSettings } from "../store";

afterEach(() => cleanup());

// 环境桩兜底：Electron 安全存储桥是用例中途挂上去的，
// 即便断言失败也要摘掉，避免串味到后续用例
afterEach(() => {
  delete window.secureStore;
});

function base(overrides: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  return {
    api: { ...DEFAULT_API },
    detector: { ...DEFAULT_DETECTOR },
    zhuqueMode: false,
    pplEnabled: true,
    local: { ...DEFAULT_LOCAL },
    protectedTerms: "",
    onClose: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
}

function numInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
}

// 配置行定位：label.row 的首个 span 即配置名，返回该行的输入控件。
// 为什么不用 getByLabelText：「模型」行里挂了 datalist，label 文本会被
// 选项文本污染，精确匹配会落空；按行内首个 span 取对下拉/复选框/输入框统一。
function rowControl(
  container: HTMLElement,
  name: string,
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const row = Array.from(container.querySelectorAll("label.row")).find(
    (l) => l.querySelector("span")?.textContent?.trim() === name,
  );
  if (!row) throw new Error(`未找到配置行：${name}`);
  const el = row.querySelector("input, select, textarea");
  if (!el) throw new Error(`配置行里没有控件：${name}`);
  return el as HTMLInputElement;
}

describe("SettingsModal（设置弹窗）", () => {
  it("渲染标题与保存按钮", () => {
    const { getByText } = render(<SettingsModal {...base()} />);
    expect(getByText("API 设置（可选）")).toBeTruthy();
    expect(getByText("保存")).toBeTruthy();
  });

  it("Esc 关闭模态", () => {
    const onClose = vi.fn();
    render(<SettingsModal {...base({ onClose })} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("编辑草稿后保存才统一上抛：API Key / 启用 / 温度失焦归一化 / 朱雀增强", () => {
    const onSave = vi.fn();
    const p = base({ onSave });
    const { getByPlaceholderText, container, getByText } = render(<SettingsModal {...p} />);

    // 编辑 Key 与启用
    fireEvent.change(getByPlaceholderText("sk-..."), { target: { value: "sk-new-key" } });
    const enabled = container.querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement;
    fireEvent.click(enabled);

    // 温度：输入 5 越界 → 失焦归一化为 2
    const temp = numInputs(container)[0];
    fireEvent.change(temp, { target: { value: "5" } });
    fireEvent.blur(temp);

    // 朱雀增强
    const zhuque = Array.from(container.querySelectorAll('input[type="checkbox"]')).find((el) =>
      (el as HTMLInputElement).closest("label")?.textContent?.includes("朱雀增强模式"),
    ) as HTMLInputElement;
    fireEvent.click(zhuque);

    fireEvent.click(getByText("保存"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const [api, , zhuqueMode] = onSave.mock.calls[0] as [
      ApiConfig,
      DetectorConfig,
      boolean,
      boolean,
      LocalSettings,
    ];
    expect(api.apiKey).toBe("sk-new-key");
    expect(api.enabled).toBe(true);
    expect(api.temperature).toBe(2);
    expect(zhuqueMode).toBe(true);
    // 上抛的是新对象，不污染传入 props
    expect(p.api.apiKey).toBe(DEFAULT_API.apiKey);
  });

  it("温度清空后失焦回退到原值", () => {
    const onSave = vi.fn();
    const { container, getByText } = render(
      <SettingsModal {...base({ onSave, api: { ...DEFAULT_API, temperature: 0.9 } })} />,
    );
    const temp = numInputs(container)[0];
    fireEvent.change(temp, { target: { value: "" } });
    fireEvent.blur(temp);
    fireEvent.click(getByText("保存"));
    const [api] = onSave.mock.calls[0] as [ApiConfig];
    expect(api.temperature).toBe(0.9);
  });

  it("候选数夹取 1~30：输入 99 保存后为 30", () => {
    const onSave = vi.fn();
    const { container, getByText } = render(<SettingsModal {...base({ onSave })} />);
    const candidates = numInputs(container)[1];
    fireEvent.change(candidates, { target: { value: "99" } });
    fireEvent.click(getByText("保存"));
    const local = onSave.mock.calls[0][4] as LocalSettings;
    expect(local.candidates).toBe(30);
  });

  it("Key 池 textarea 编辑后随保存上抛", () => {
    const onSave = vi.fn();
    const { container, getByText } = render(<SettingsModal {...base({ onSave })} />);
    const pool = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(pool, { target: { value: "k1\nk2" } });
    fireEvent.click(getByText("保存"));
    const [api] = onSave.mock.calls[0] as [ApiConfig];
    expect(api.apiKeys).toBe("k1\nk2");
  });

  it("OpenRouter 预设一键填充并随保存上抛", () => {
    const onSave = vi.fn();
    const { getByText } = render(<SettingsModal {...base({ onSave })} />);
    fireEvent.click(getByText("填入 OpenRouter + Ox Alpha"));
    fireEvent.click(getByText("保存"));
    const [api] = onSave.mock.calls[0] as [ApiConfig];
    expect(api.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(api.model).toBe("stealth/ox-alpha");
    expect(api.reasoningEffort).toBe("max");
    expect(api.enabled).toBe(true);
  });

  it("朱雀检测器预设：官方固定网关 + softmax 路径 + 0-1 刻度，且不替用户开启送检", () => {
    const onSave = vi.fn();
    const { getByText } = render(<SettingsModal {...base({ onSave })} />);
    fireEvent.click(getByText("填入朱雀默认值"));
    fireEvent.click(getByText("保存"));
    const det = onSave.mock.calls[0][1] as DetectorConfig;
    // 预设只填口径不改开关：勾上「启用检测器」等于每次去味都花外部账号的额度
    expect(det.enabled).toBe(false);
    expect(det.url).toBe("https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify");
    expect(det.scorePath).toBe("softmax_confidence");
    expect(det.scale).toBe("0-1");
  });

  // v0.9.15：setProtectedTerms 此前只有测试在调，UI 零入口。这条钉住「编辑 → 保存上抛」，
  // 防止哪天 prop 被摘掉又变回死能力。
  it("自定义保护术语：编辑后随保存上抛第 6 个参数", () => {
    const onSave = vi.fn();
    // 按 class 取：placeholder 是多行文本，getByPlaceholderText 的默认 normalizer
    // 会把换行压成空格，匹配不上
    const { container, getByText } = render(<SettingsModal {...base({ onSave })} />);
    const ta = container.querySelector("textarea.terms-input") as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    fireEvent.change(ta, { target: { value: "量子跃迁式改革\n张三丰算法" } });
    fireEvent.click(getByText("保存"));
    const terms = onSave.mock.calls[0][5] as string;
    expect(terms).toBe("量子跃迁式改革\n张三丰算法");
  });

  it("点遮罩触发 onClose；点弹窗内部不触发", () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsModal {...base({ onClose })} />);
    fireEvent.click(container.querySelector(".modal-mask")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".modal")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsModal 条件分支（v0.9.16 补盲追加）", () => {
  it("baseUrl 以 / 开头显示部署警告横幅，改回 https 消失", () => {
    const { getByText, queryByText, container } = render(
      <SettingsModal {...base()} />,
    );
    // 找到 Base URL 输入（placeholder 为默认值）
    const baseUrlInput = container.querySelector(
      'input[placeholder="https://api.openai.com/v1"]',
    ) as HTMLInputElement;
    fireEvent.change(baseUrlInput, { target: { value: "/sensenova/v1" } });
    expect(getByText(/以 \/ 开头的相对路径只在/)).toBeTruthy();
    fireEvent.change(baseUrlInput, { target: { value: "https://api.openai.com/v1" } });
    expect(queryByText(/以 \/ 开头的相对路径只在/)).toBeNull();
  });

  it("写作风格切换进入草稿，保存后经 onSave 上抛", () => {
    const onSave = vi.fn();
    const { getByText, getByLabelText } = render(
      <SettingsModal {...base({ onSave })} />,
    );
    const styleSelect = getByLabelText("文风") as HTMLSelectElement;
    expect(styleSelect.value).toBe("plain");
    fireEvent.change(styleSelect, { target: { value: "academic" } });
    fireEvent.click(getByText("保存"));
    const savedApi = onSave.mock.calls[0][0] as ApiConfig;
    expect(savedApi.style).toBe("academic");
  });

  it("保存时启用勾选与 Key 一并上抛（草稿态不落盘到 localStorage）", () => {
    const onSave = vi.fn();
    const { getByText, container } = render(
      <SettingsModal {...base({ onSave })} />,
    );
    const keyInput = container.querySelector('input[placeholder="sk-..."]') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "sk-draft-key" } });
    // 未点保存：localStorage 不应有 Key
    expect(JSON.stringify(localStorage)).not.toContain("sk-draft-key");
    fireEvent.click(getByText("保存"));
    const savedApi = onSave.mock.calls[0][0] as ApiConfig;
    expect(savedApi.apiKey).toBe("sk-draft-key");
  });
});

describe("SettingsModal 补盲（逐行覆盖 · 配置行编辑与环境分支）", () => {
  it("非 Esc 按键不触发关闭（keydown 监听只认 Escape）", () => {
    const onClose = vi.fn();
    render(<SettingsModal {...base({ onClose })} />);
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("点标题栏 ✕ 按钮关闭模态", () => {
    const onClose = vi.fn();
    const { getByText } = render(<SettingsModal {...base({ onClose })} />);
    fireEvent.click(getByText("✕"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("模型 / 评判模型 / 备选改写三个文本框编辑后随保存上抛", () => {
    const onSave = vi.fn();
    const { container, getByText } = render(<SettingsModal {...base({ onSave })} />);
    const modelInput = rowControl(container, "模型") as HTMLInputElement;
    fireEvent.change(modelInput, { target: { value: "my-main-model" } });
    fireEvent.change(rowControl(container, "评判模型"), { target: { value: "my-judge-model" } });
    fireEvent.change(rowControl(container, "备选改写"), { target: { value: "my-alt-model" } });
    expect(modelInput.value).toBe("my-main-model"); // 输入框随草稿回显
    fireEvent.click(getByText("保存"));
    const [api] = onSave.mock.calls[0] as [ApiConfig];
    expect(api.model).toBe("my-main-model");
    expect(api.judgeModel).toBe("my-judge-model");
    expect(api.altModel).toBe("my-alt-model");
  });

  it("推理强度：选「高」落草稿；切回「关闭」归一化为 undefined", () => {
    const onSave = vi.fn();
    const { container, getByText } = render(<SettingsModal {...base({ onSave })} />);
    const select = rowControl(container, "推理强度") as HTMLSelectElement;
    expect(select.value).toBe(""); // DEFAULT_API.reasoningEffort 缺省 → 「关闭」档
    fireEvent.change(select, { target: { value: "high" } });
    expect(select.value).toBe("high");
    fireEvent.click(getByText("保存"));
    expect((onSave.mock.calls[0][0] as ApiConfig).reasoningEffort).toBe("high");
    // 切回「关闭（非推理模型）」→ 空串必须归一化成 undefined，不能把 "" 写进配置
    fireEvent.change(select, { target: { value: "" } });
    expect(select.value).toBe("");
    fireEvent.click(getByText("保存"));
    expect((onSave.mock.calls[1][0] as ApiConfig).reasoningEffort).toBeUndefined();
  });

  it("人味人格分档 / 深度模式关断 / 严格保真勾选随保存上抛", () => {
    const onSave = vi.fn();
    const { container, getByText } = render(<SettingsModal {...base({ onSave })} />);
    fireEvent.change(rowControl(container, "人味人格"), { target: { value: "netgen" } });
    const deep = rowControl(container, "深度模式") as HTMLInputElement;
    expect(deep.checked).toBe(true); // DEFAULT_API.deepMode 默认开
    fireEvent.click(deep);
    expect(deep.checked).toBe(false);
    const strict = rowControl(container, "严格保真") as HTMLInputElement;
    expect(strict.checked).toBe(false);
    fireEvent.click(strict);
    expect(strict.checked).toBe(true);
    fireEvent.click(getByText("保存"));
    const [api] = onSave.mock.calls[0] as [ApiConfig];
    expect(api.persona).toBe("netgen");
    expect(api.deepMode).toBe(false);
    expect(api.strictFidelity).toBe(true);
  });

  it("最长等待 / 调用上限 / 首轮候选数三个下拉随保存上抛", () => {
    const onSave = vi.fn();
    const { container, getByText } = render(<SettingsModal {...base({ onSave })} />);
    fireEvent.change(rowControl(container, "最长等待"), { target: { value: "120" } });
    fireEvent.change(rowControl(container, "调用上限"), { target: { value: "20" } });
    fireEvent.change(rowControl(container, "首轮候选数"), { target: { value: "3" } });
    fireEvent.click(getByText("保存"));
    const [api] = onSave.mock.calls[0] as [ApiConfig];
    expect(api.maxWaitSeconds).toBe(120);
    expect(api.maxApiCalls).toBe(20);
    expect(api.contestSamples).toBe(3);
  });

  it("可选字段全部缺省时：各控件按 ?? / || 兜底值渲染，保存不凭空造值", () => {
    const onSave = vi.fn();
    const api: ApiConfig = {
      ...DEFAULT_API,
      apiKeys: undefined,
      reasoningEffort: undefined,
      maxWaitSeconds: undefined,
      maxApiCalls: undefined,
      contestSamples: undefined,
      persona: undefined,
      strictFidelity: undefined,
    };
    const { container, getByText } = render(<SettingsModal {...base({ onSave, api })} />);
    // 兜底分支：缺省 → 空串 / "" / 0 / 1 / default / false
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect((rowControl(container, "推理强度") as HTMLSelectElement).value).toBe("");
    expect((rowControl(container, "最长等待") as HTMLSelectElement).value).toBe("0");
    expect((rowControl(container, "调用上限") as HTMLSelectElement).value).toBe("0");
    expect((rowControl(container, "首轮候选数") as HTMLSelectElement).value).toBe("1");
    expect((rowControl(container, "人味人格") as HTMLSelectElement).value).toBe("default");
    expect((rowControl(container, "严格保真") as HTMLInputElement).checked).toBe(false);
    // 一个字段都没改就保存：草稿是 props 的浅拷贝，不该把 undefined 洗成 0/""/false
    fireEvent.click(getByText("保存"));
    const saved = onSave.mock.calls[0][0] as ApiConfig;
    expect(saved.apiKeys).toBeUndefined();
    expect(saved.reasoningEffort).toBeUndefined();
    expect(saved.maxWaitSeconds).toBeUndefined();
    expect(saved.maxApiCalls).toBeUndefined();
    expect(saved.contestSamples).toBeUndefined();
    expect(saved.persona).toBeUndefined();
    expect(saved.strictFidelity).toBeUndefined();
  });

  it("困惑度检查与多候选择优：勾选态跟 props，关断后随保存上抛", () => {
    const onSave = vi.fn();
    const { container, getByText } = render(<SettingsModal {...base({ onSave })} />);
    const ppl = rowControl(container, "启用困惑度检查") as HTMLInputElement;
    const bestOf = rowControl(container, "多候选择优") as HTMLInputElement;
    expect(ppl.checked).toBe(true); // base 默认 pplEnabled=true
    expect(bestOf.checked).toBe(true); // DEFAULT_LOCAL.bestOf=true
    fireEvent.click(ppl);
    fireEvent.click(bestOf);
    expect(ppl.checked).toBe(false);
    expect(bestOf.checked).toBe(false);
    fireEvent.click(getByText("保存"));
    const [, , , pplEnabled, local] = onSave.mock.calls[0] as [
      ApiConfig,
      DetectorConfig,
      boolean,
      boolean,
      LocalSettings,
      string,
    ];
    expect(pplEnabled).toBe(false);
    expect(local.bestOf).toBe(false);
    expect(local.candidates).toBe(DEFAULT_LOCAL.candidates); // 另一字段没被误改
  });

  it("初始开关反相渲染：朱雀增强开 / 困惑度关 / 多候选择优关 / 候选数跟 props", () => {
    const { container } = render(
      <SettingsModal
        {...base({
          zhuqueMode: true,
          pplEnabled: false,
          local: { ...DEFAULT_LOCAL, bestOf: false, candidates: 5 },
        })}
      />,
    );
    expect((rowControl(container, "朱雀增强模式") as HTMLInputElement).checked).toBe(true);
    expect((rowControl(container, "启用困惑度检查") as HTMLInputElement).checked).toBe(false);
    expect((rowControl(container, "多候选择优") as HTMLInputElement).checked).toBe(false);
    expect((rowControl(container, "候选数（1~30）") as HTMLInputElement).value).toBe("5");
  });

  it("对标检测器整行编辑：启用 / URL / Key / 分数路径 / 刻度随保存上抛", () => {
    const onSave = vi.fn();
    const { container, getByText } = render(<SettingsModal {...base({ onSave })} />);
    fireEvent.click(rowControl(container, "启用检测器"));
    fireEvent.change(rowControl(container, "接口 URL"), {
      target: { value: "https://my-detector/api" },
    });
    // 检测器的 API Key 行与主配置同名，按占位符「可选」定位
    const detKey = container.querySelector('input[placeholder="可选"]') as HTMLInputElement;
    fireEvent.change(detKey, { target: { value: "dk-1" } });
    fireEvent.change(rowControl(container, "分数路径"), { target: { value: "data.prob" } });
    fireEvent.change(rowControl(container, "刻度"), { target: { value: "0-1" } });
    fireEvent.click(getByText("保存"));
    const det = onSave.mock.calls[0][1] as DetectorConfig;
    expect(det.enabled).toBe(true);
    expect(det.url).toBe("https://my-detector/api");
    expect(det.apiKey).toBe("dk-1");
    expect(det.scorePath).toBe("data.prob");
    expect(det.scale).toBe("0-1");
  });

  it("SenseNova 预置：无 Key 时按钮禁用并解释来源；有 Key 一键填入常驻通道", () => {
    const onSave = vi.fn();
    const savedKeys = [...SENSENOVA_PRESET.keys];
    try {
      // 分支一：环境没配 Key（模拟成清空 keys）→ 禁用 + 文案解释缺 Key 原因
      SENSENOVA_PRESET.keys = [];
      const { getByText, rerender } = render(<SettingsModal {...base({ onSave })} />);
      const btnNoKey = getByText(/填入 SenseNova 常驻通道/) as HTMLButtonElement;
      expect(btnNoKey.disabled).toBe(true);
      expect(btnNoKey.textContent).toContain("（未配置 Key）");
      expect(btnNoKey.title).toContain("未检测到本地 Key");
      // 分支二：配了 Key → 按钮可用，点击把常驻通道参数填进草稿
      SENSENOVA_PRESET.keys = ["sk-sn-1", "sk-sn-2"];
      rerender(<SettingsModal {...base({ onSave })} />);
      const btn = getByText(/填入 SenseNova 常驻通道/) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).not.toContain("（未配置 Key）");
      expect(btn.title).toContain("2 Key 自动轮换");
      fireEvent.click(btn);
      fireEvent.click(getByText("保存"));
      const [api] = onSave.mock.calls[0] as [ApiConfig];
      expect(api.enabled).toBe(true);
      expect(api.baseUrl).toBe("/sensenova/v1");
      expect(api.apiKey).toBe("sk-sn-1");
      expect(api.apiKeys).toBe("sk-sn-1\nsk-sn-2");
      expect(api.model).toBe("deepseek-v4-flash");
      expect(api.judgeModel).toBe("glm-5.2");
      expect(api.altModel).toBe("deepseek-v4-pro");
    } finally {
      SENSENOVA_PRESET.keys = savedKeys;
    }
  });

  it("有安全存储桥（Electron 桌面版）时不再提示明文存储风险", () => {
    const { queryByText, rerender } = render(<SettingsModal {...base()} />);
    // Web 版（无桥）默认提示 Key 明文落 localStorage
    expect(queryByText(/Web 版 Key 以明文存储于浏览器 localStorage/)).toBeTruthy();
    // 挂上 Electron 桥 → 同一段提示必须消失（桌面版走系统级加密存储）
    window.secureStore = { get: async () => null, set: async () => true };
    rerender(<SettingsModal {...base()} />);
    expect(queryByText(/Web 版 Key 以明文存储于浏览器 localStorage/)).toBeNull();
  });

  it("Base URL 带前后空白的相对路径同样触发部署警告", () => {
    const { container, getByText, queryByText } = render(<SettingsModal {...base()} />);
    const baseUrlInput = container.querySelector(
      'input[placeholder="https://api.openai.com/v1"]',
    ) as HTMLInputElement;
    fireEvent.change(baseUrlInput, { target: { value: "  /dev/api  " } });
    expect(getByText(/以 \/ 开头的相对路径只在/)).toBeTruthy();
    fireEvent.change(baseUrlInput, { target: { value: "  https://x.y/v1  " } });
    expect(queryByText(/以 \/ 开头的相对路径只在/)).toBeNull();
  });

  it("候选数：0 夹到 1，非数字回退默认 8", () => {
    const onSave = vi.fn();
    const { container, getByText } = render(<SettingsModal {...base({ onSave })} />);
    const candidates = numInputs(container)[1]; // [0]=温度，[1]=候选数
    fireEvent.change(candidates, { target: { value: "0" } });
    fireEvent.click(getByText("保存"));
    expect((onSave.mock.calls[0][4] as LocalSettings).candidates).toBe(1);
    // parseInt 出 NaN → Number.isFinite 不过 → 回退 8（不写 NaN 进配置）
    fireEvent.change(candidates, { target: { value: "abc" } });
    fireEvent.click(getByText("保存"));
    expect((onSave.mock.calls[1][4] as LocalSettings).candidates).toBe(8);
  });
});
