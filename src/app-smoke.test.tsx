// @vitest-environment happy-dom
/**
 * App.tsx 渲染冒烟测试（v0.8.7 UI 测试收尾）：
 * 默认空配置下整棵树可挂载、核心区域渲染、主要面板能被按钮唤起。
 * 防白屏级别的回归守卫，不深入业务流转（那由子组件各自测试覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import App from "./App";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => cleanup());

describe("App 冒烟（默认空配置）", () => {
  it("整棵树挂载：标题、双输入面板与主操作按钮全部渲染", () => {
    const { getByText, getByPlaceholderText } = render(<App />);
    expect(getByText("趣AI味 · QuAiWei")).toBeTruthy();
    expect(getByText("原文（AI 稿）")).toBeTruthy();
    expect(getByText("去味后（人写感）")).toBeTruthy();
    expect(getByText("去味")).toBeTruthy();
    expect(getByText("⚙ 设置")).toBeTruthy();
    expect(getByPlaceholderText(/把 AI 写的文章粘进来/)).toBeTruthy();
  });

  it("空输入时依赖输出的按钮禁用；强度滑块默认 60%", () => {
    const { getByText, container } = render(<App />);
    expect((getByText("复制").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("对比").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("指纹体检").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("AI 检测").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain("去味强度 60%");
  });

  it("未配置 API 时不显示深度模式徽章；朱雀增强可点击切换", () => {
    const { container } = render(<App />);
    expect(container.textContent).not.toContain("深度模式");
    const tag = Array.from(container.querySelectorAll(".mode-tag")).find((el) =>
      el.textContent?.includes("朱雀增强"),
    ) as HTMLElement;
    expect(tag.className).not.toContain("active");
    fireEvent.click(tag);
    expect(tag.className).toContain("active");
  });

  it("点「示例」载入样例后，检测类按钮全部可用", () => {
    const { getByText, container } = render(<App />);
    fireEvent.click(getByText("示例"));
    const input = container.querySelector("section.pane textarea") as HTMLTextAreaElement;
    expect(input.value.length).toBeGreaterThan(150);
    expect((getByText("指纹体检").closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect((getByText("AI 检测").closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect((getByText("朱雀检测").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("点「示例」→「指纹体检」渲染体检面板（ppl unsupported 也不崩）", async () => {
    const { getByText, container } = render(<App />);
    fireEvent.click(getByText("示例"));
    await act(async () => {
      fireEvent.click(getByText("指纹体检"));
    });
    expect(container.textContent).toContain("指纹体检");
    // 体检对象是原文（output 为空）
    expect(container.textContent).toContain("检查原文");
  });

  it("点「朱雀检测」渲染朱雀面板（本地近似 + 350 字样例通过门槛）", () => {
    const { getByText, container } = render(<App />);
    fireEvent.click(getByText("示例"));
    fireEvent.click(getByText("朱雀检测"));
    expect(container.textContent).toContain("朱雀检测（本地近似");
    expect(container.textContent).toContain("官方口径");
  });

  it("点「AI 检测」渲染本地检测面板", () => {
    const { getByText, container } = render(<App />);
    fireEvent.click(getByText("示例"));
    fireEvent.click(getByText("AI 检测"));
    expect(container.textContent).toContain("原文");
    expect(container.textContent).toContain("AI生成");
  });

  it("「历史」面板：空库提示；设置弹窗可打开且 Esc 关闭", () => {
    const { getByText, container } = render(<App />);
    fireEvent.click(getByText("历史"));
    expect(container.textContent).toContain("暂无历史记录");
    fireEvent.click(getByText("关闭"));
    fireEvent.click(getByText("⚙ 设置"));
    expect(container.textContent).toContain("API 设置（可选）");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.textContent).not.toContain("API 设置（可选）");
  });

  it("「清空」按钮清空输入输出", () => {
    const { getByText, container } = render(<App />);
    fireEvent.click(getByText("示例"));
    fireEvent.click(getByText("清空"));
    const ta = container.querySelector("section.pane textarea") as HTMLTextAreaElement;
    expect(ta.value).toBe("");
    expect((getByText("指纹体检").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
