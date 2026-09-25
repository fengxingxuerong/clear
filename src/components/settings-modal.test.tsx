// @vitest-environment happy-dom
/**
 * SettingsModal 渲染级测试：草稿-提交模式（编辑不落盘、保存统一上抛）、
 * Esc 关闭、温度失焦归一化、候选数夹取、三个一键预设。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { DEFAULT_API } from "../api/llm-config";
import { DEFAULT_DETECTOR } from "../api/detector";
import { DEFAULT_LOCAL } from "../store";
import type { ApiConfig } from "../api/llm-config";
import type { DetectorConfig } from "../api/detector";
import type { LocalSettings } from "../store";

afterEach(() => cleanup());

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
