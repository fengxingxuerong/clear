/**
 * primitives.test.ts —— 机械扰动层原语（shuffle/primitives.ts）的行级补测。
 *
 * 2026-10-05 全面优化验证轮：该文件此前 87.2% 行 / 75.7% 分支，未覆盖 16 行。
 * 本文件按未覆盖行号逐条打点：47（relaxColon 半角分支）、54（relaxQuotes）、
 * 69/75（splitOnConnectors 两组连接词）、202（varyParagraphs 单换行早退）、
 * 208-211（双短段合并）、214-219（长段对拆）。
 *
 * 第 42 行是**死分支**，任何测试都覆盖不到，原因写在 relaxColon 的用例注释里。
 */
import { describe, it, expect } from "vitest";
import {
  relaxColon,
  relaxQuotes,
  splitOnConnectors,
  varyParagraphs,
} from "./primitives.ts";

/** 全 0：门限必过、下标必取 0 */
const rng0 = (): number => 0;

describe("relaxColon（冒号放松）", () => {
  it("全角冒号：p=1 替换为「，」，p=0 原样", () => {
    expect(relaxColon("他说：继续吧", rng0, 1)).toBe("他说，继续吧");
    expect(relaxColon("他说：继续吧", rng0, 0)).toBe("他说：继续吧");
  });

  // 未覆盖行 47：半角 `:` 的那条 replace 回调（全角那条此前已被覆盖）
  it("半角冒号：CJK:CJK 才替换，两侧不是 CJK 则不动", () => {
    expect(relaxColon("他说:接着干", rng0, 1)).toBe("他说，接着干");
    expect(relaxColon("他说:接着干", rng0, 0)).toBe("他说:接着干");
    expect(relaxColon("key: value", rng0, 1)).toBe("key: value"); // 前置不是 CJK
  });

  // 死分支说明（源码 41-42 行，**不可覆盖**）：
  // replace 回调的 offset 是匹配起点（pre 那个字的下标），所以 `text[offset+1]`
  // 恒等于全角冒号本身，`if (next === '"' …)` 永假；而且正则前瞻 (?=[一-龥])
  // 早就把紧跟引号的情形排除在匹配之外了——两道都不成立，属双重死代码。
  // 这里用引号场景断言「由前瞻兜住、整段不匹配」，是该设计意图目前唯一可观测的面。
  it("引号紧跟冒号的场景由前瞻兜住（源码 41-42 死分支的可观测面）", () => {
    expect(relaxColon("他说：“开始吧”", rng0, 1)).toBe("他说：“开始吧”");
  });
});

describe("relaxQuotes（引号放松）", () => {
  // 未覆盖行 54：`rng() < p ? inner : _m` 这一支
  it("p=1 且门限通过 → 去掉引号只留内文", () => {
    expect(relaxQuotes("他讲“内容在这里”后面", rng0, 1)).toBe("他讲内容在这里后面");
  });

  it("p=0 → 引号原样保留", () => {
    expect(relaxQuotes("他讲“内容在这里”后面", rng0, 0)).toBe("他讲“内容在这里”后面");
  });
});

describe("splitOnConnectors（连接词断句）", () => {
  // 未覆盖行 69：「使得/导致」→ 「。结果」
  it("使得：前段 ≥4 字、后段 ≥3 字时断成「。结果」", () => {
    expect(splitOnConnectors("这套方案使得效率提升明显", rng0, 1)).toBe(
      "这套方案。结果效率提升明显",
    );
  });

  it("p=0 → 连接词原样", () => {
    expect(splitOnConnectors("这套方案使得效率提升明显", rng0, 0)).toBe(
      "这套方案使得效率提升明显",
    );
  });

  // 未覆盖行 75：「这样一来/在此基础上/与此同时/正因如此」→ 「。」+ 原词保留
  it("这样一来：断成句但保留连接词本身", () => {
    expect(splitOnConnectors("经过讨论这样一来大家就明白了", rng0, 1)).toBe(
      "经过讨论。这样一来大家就明白了",
    );
  });

  it("与此同时：同样断句且原词保留", () => {
    expect(splitOnConnectors("双方僵持了很久与此同时局面转好", rng0, 1)).toBe(
      "双方僵持了很久。与此同时局面转好",
    );
  });
});

describe("varyParagraphs（段落节奏变化）", () => {
  // 未覆盖行 202：含换行但没有空行 ⇒ split(/\n{2,}/) 只得到 1 段 ⇒ 原样返回
  it("单个换行（无空行）：不足两段，原样返回", () => {
    const src = "第一段只有一个换行。\n第二段紧跟其后。";
    expect(varyParagraphs(src, rng0, 1)).toBe(src);
  });

  // 未覆盖行 208-211：双短段合并（<25 字），句末有标点则直接相接
  it("两个短段且首段以句号收尾 → 直接合并、不插连接符", () => {
    expect(varyParagraphs("短句甲乙丙。\n\n短句丁戊己。", rng0, 1)).toBe("短句甲乙丙。短句丁戊己。");
  });

  it("两个短段且首段无句末标点 → 用「，」缝合", () => {
    expect(varyParagraphs("没有句号的短甲\n\n短句丁戊己。", rng0, 1)).toBe(
      "没有句号的短甲，短句丁戊己。",
    );
  });

  it("门限不过（rng≥p）→ 两段原样分开", () => {
    const src = "短句甲乙丙。\n\n短句丁戊己。";
    expect(varyParagraphs(src, () => 1, 0.5)).toBe(src);
  });

  // 未覆盖行 214-219：>180 字长段对拆（句子数 ≥4 才拆）
  it("超 180 字的长段对拆成两段，段数与字数都不丢", () => {
    const sentence = "这是一句长度大约二十字用来验证长段对拆分支的中文句子。"; // 26 字含句号
    const longPara = sentence.repeat(8); // 8 句 ≈ 208 字 > 180，且 8 ≥ 4
    const src = `${longPara}\n\n收尾短段。`;

    const out = varyParagraphs(src, rng0, 1);
    const parts = out.split("\n\n");
    expect(parts).toHaveLength(3); // 长段拆 2 + 收尾短段 1
    // 拆分只换分隔位置，不丢任何字（本用例无首尾空白，trim 无损）
    expect(parts.join("")).toBe(src.replace(/\n\n/g, ""));
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("长段但句子不足 4 句 → 不拆，原样保留", () => {
    // 3 句、合计 >180 字：进得了 213 行的长度判断，却过不了 215 行的句子数守卫
    const three =
      "这一句话虽然远远超过了一百八十个字的长度限制，但是全段的句子总数只有三句而已，因此并不满足对拆分支所需要的最低句子数要求。".repeat(3);
    expect(three.length).toBeGreaterThan(180);
    const src = `${three}\n\n收尾短段。`;
    const out = varyParagraphs(src, rng0, 1);
    expect(out.split("\n\n")).toHaveLength(2); // 长段未被拆开
  });
});
