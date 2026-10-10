// @vitest-environment happy-dom
/**
 * ExplainPanel 渲染测试。
 *
 * 面板的价值全在「不把推断说成确定」：确定类走绿标 + 具体类别，推断类一律走黄标并显示
 * "推断" 二字。所以这里两组闭环必须都在——只测确定的那组，等于默许把 inferred 混入 summary。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ExplainPanel } from "./ExplainPanel";
import { explainChanges, type ExplainItem } from "../engine/explain";
import { humanize } from "../engine/humanize";

afterEach(() => cleanup());

const BEFORE =
  "值得注意的是，在当今社会，人工智能技术的发展至关重要。事实上，它在一定程度上改变了我们的生活方式。综上所述，这一趋势具有十分重要的意义。";

/** 真引擎产出，不是手搓的改写对 */
const AFTER = humanize(BEFORE, { intensity: 0.9, seed: 20260905 });

function item(p: Partial<ExplainItem> & Pick<ExplainItem, "kind">): ExplainItem {
  return {
    before: "因此",
    after: "",
    reason: "测试用理由",
    basis: "测试用依据",
    certain: false,
    ...p,
  };
}

describe("ExplainPanel", () => {
  it("真引擎改动：显示确定归因条数与依据出处，且依据能指到文件", () => {
    const items = explainChanges(BEFORE, AFTER);
    // 前置：这组样本必须有确定归因，否则下面的断言全是空的
    expect(items.some((i) => i.certain)).toBe(true);

    const { getByText, container } = render(<ExplainPanel items={items} onClose={() => {}} />);
    expect(getByText(/句级 diff 反查规则表/)).toBeTruthy();
    expect(getByText(/确定归因/)).toBeTruthy();
    // 依据必须指到具体文件，不许只说"规则如此"（多条都带同款 basis，故用容器匹配）
    expect(container.textContent).toMatch(/依据：humanize-(vocab|text)\.ts/);
  });

  it("推断类显示「推断」标记，不冒充确定类别", () => {
    const { getByText, queryByText, container } = render(
      <ExplainPanel
        items={[item({ kind: "structure", before: "原句A", after: "新句B" })]}
        onClose={() => {}}
      />,
    );
    expect(getByText("推断")).toBeTruthy();
    // 类别标签属于确定类专用——推断条目不得显示「结构重写」
    expect(queryByText("结构重写")).toBeNull();
    // 摘要行里数字嵌在 <b> 里，getByText 只拼直接文本节点，故走 container
    expect(container.textContent).toContain("推断 1 处");
  });

  it("确定类按类别计数进摘要，推断类不进（猜的不算做过的）", () => {
    const { container } = render(
      <ExplainPanel
        items={[
          item({ kind: "vocab", before: "利用", after: "用", certain: true }),
          item({ kind: "vocab", before: "进行", after: "做", certain: true }),
          item({ kind: "inject", before: "", after: "说真的", certain: false }),
        ]}
        onClose={() => {}}
      />,
    );
    // 期望文案：「确定归因 2 处（词表替换×2） · 推断 1 处」
    const head = container.textContent ?? "";
    expect(head).toContain("确定归因 2 处");
    expect(head).toContain("词表替换×2");
    expect(head).toContain("推断 1 处");
  });

  it("纯删除/纯新增的箭头写法区分得开", () => {
    const { getByText } = render(
      <ExplainPanel
        items={[
          item({ kind: "trim", before: "冗余的话", after: "", certain: false }),
          item({ kind: "inject", before: "", after: "口语插入", certain: false }),
        ]}
        onClose={() => {}}
      />,
    );
    expect(getByText(/删「冗余的话」/)).toBeTruthy();
    expect(getByText(/增「口语插入」/)).toBeTruthy();
  });

  it("空清单（两稿一致）：给出空态文案而不是空白面板", () => {
    const { getByText } = render(<ExplainPanel items={[]} onClose={() => {}} />);
    expect(getByText(/两稿一致，没有改动/)).toBeTruthy();
  });

  it("「收起」真的回调 App 关面板", () => {
    let closed = 0;
    const { getByText } = render(
      <ExplainPanel
        items={[item({ kind: "vocab", certain: true })]}
        onClose={() => (closed += 1)}
      />,
    );
    fireEvent.click(getByText("收起"));
    expect(closed).toBe(1);
  });
});
