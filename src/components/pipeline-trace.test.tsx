// @vitest-environment happy-dom
/**
 * 流水线追踪面板渲染测试。
 *
 * 这个面板的全部价值是「把引擎真的做过的事摊开」，所以测试盯两件事：
 *  1. 数字来自 trace、原样呈现 —— 不许组件自己加工（补文案、改单位、四舍五入）；
 *  2. 没有 trace 就不渲染 —— 不许在没有数据的情况下画一条看起来像流程的假进度条。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { PipelineTracePanel } from "./PipelineTrace";
import { runTracedHumanize } from "../engine/pipeline-trace";

afterEach(() => cleanup());

const SRC =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。";

const trace = runTracedHumanize(SRC, { intensity: 0.9, seed: 20261015 });

describe("PipelineTracePanel", () => {
  it("没有 trace 时什么都不渲染（宁可空着，也不画假进度条）", () => {
    const { container } = render(<PipelineTracePanel trace={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("每个阶段的名称与「为什么」都上屏——这是逻辑透明的主体", () => {
    const { container, getByText } = render(<PipelineTracePanel trace={trace.trace} />);
    for (const s of trace.trace.stages) {
      expect(getByText(s.name), `阶段名缺失：${s.id}`).toBeTruthy();
      expect(container.textContent, `阶段 why 缺失：${s.id}`).toContain(s.why);
    }
  });

  it("面板头部汇总的是 trace 里的真实数字，不是另算一套", () => {
    const { container } = render(<PipelineTracePanel trace={trace.trace} />);
    const head = container.querySelector(".pipe-meta")!.textContent ?? "";
    expect(head).toContain(`${trace.trace.stages.length} 阶段`);
    expect(head).toContain(`${trace.trace.eventCount} 条事件`);
    expect(head).toContain(`${trace.trace.inputChars} → ${trace.trace.outputChars} 字`);
  });

  it("快照默认收起，点行展开；按钮可一次全展开", () => {
    const { container, getByText } = render(<PipelineTracePanel trace={trace.trace} />);
    expect(container.querySelector(".pipe-snips")).toBeNull();

    const firstRow = container.querySelectorAll(".pipe-row")[0] as HTMLButtonElement;
    fireEvent.click(firstRow);
    expect(container.querySelectorAll(".pipe-snips").length).toBe(1);

    fireEvent.click(getByText("展开全部快照"));
    expect(container.querySelectorAll(".pipe-snips").length).toBe(trace.trace.stages.length);
  });

  it("跳过的阶段要灰掉（用户得看出这一步没跑）", () => {
    const { container } = render(<PipelineTracePanel trace={trace.trace} />);
    const skipped = trace.trace.stages.filter((s) => s.skipped);
    expect(skipped.length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".pipe-item.skip").length).toBe(skipped.length);
  });

  it("多候选择优模式要说清「为什么只记了入选那一条」", () => {
    const { container } = render(<PipelineTracePanel trace={trace.trace} bestOfTried={3} />);
    expect(container.textContent).toContain("3 个候选并行跑");
  });

  it("LLM 路径要说明执行过程不在本地", () => {
    const { container } = render(<PipelineTracePanel trace={trace.trace} llmPath />);
    expect(container.textContent).toContain("执行过程在远端");
  });
});
