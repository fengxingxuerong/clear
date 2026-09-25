/**
 * humanize-shuffle 第四轮行为锁：injectFirstPersonAnchorPoints（P3-4 第一人称锚点）。
 *
 * 关键设计约定（对齐「严禁编造铁律」）：锚点池只表达主观看法，不得声称任何
 * 具体经历/资历/资料来源（无法被证伪为假）——测试对此做专门的「编造红线」断言。
 */
import { describe, expect, it } from "vitest";
import { injectFirstPersonAnchorPoints } from "./humanize-shuffle.ts";

const rngMid = () => 0.5;

/** 构造 ≥200 字、含数据句的论说文本（每句挂 DATA_MARK 触发词之一） */
function buildExpoText(): string {
  const parts = [
    "研究显示整个行业的规模在过去一年里保持了比较平稳的增长速度。",
    "报告显示头部的几家厂商合计拿到了六成以上的市场份额和渠道资源。",
    "数据显示中低端产品的出货量其实一直在缓慢地下滑和收缩。",
    "同比来看今年的单价水平比去年低了大概一成半到两成之间。",
    "白皮书显示多数团队的落地周期比立项时的预估要长出一大截。",
    "调研显示用户对售后响应速度的敏感度远高于对参数的敏感度。",
    "统计结果表明渠道库存的周转天数已经接近历史区间的上限。",
    "根据相关调研中小商家的真实痛点其实是在资金而非流量。",
  ];
  let text = "";
  for (const p of parts) {
    text += p;
    if (text.replace(/\s/g, "").length >= 620) break;
  }
  return text;
}

describe("injectFirstPersonAnchorPoints（P3-4 第一人称锚点）", () => {
  it("强度 < 0.85 原样返回", () => {
    const t = buildExpoText();
    expect(injectFirstPersonAnchorPoints(t, rngMid, 0.84)).toBe(t);
  });

  it("不足 200 字原样返回（短文本不塞锚）", () => {
    const t = "研究显示行业规模平稳增长。报告显示头部厂商份额集中。数据显示中低端出货下滑。";
    expect(injectFirstPersonAnchorPoints(t, rngMid, 0.95)).toBe(t);
  });

  it("达标文本：锚点数量 = floor(chars/300)（至少 1）", () => {
    const t = buildExpoText();
    const chars = t.replace(/\s/g, "").length;
    const target = Math.max(1, Math.floor(chars / 300));
    const out = injectFirstPersonAnchorPoints(t, rngMid, 0.95);
    const before = t.split(/(?<=[。！？])/).length;
    const after = out.split(/(?<=[。！？])/).length;
    expect(after - before).toBe(target);
  });

  it("锚点全部来自主观看法池：含「我」且不声称具体经历/资料来源（编造红线）", () => {
    const t = buildExpoText();
    const out = injectFirstPersonAnchorPoints(t, rngMid, 0.95);
    const inserted = out
      .split(/(?<=[。！？])/)
      .filter((s) => !t.includes(s) && s.trim().length > 0);
    expect(inserted.length).toBeGreaterThanOrEqual(1);
    for (const s of inserted) {
      expect(s).toContain("我"); // 池内 6 条全部第一人称口吻
      // 红线：不得声称具体经历/资历/内部资料（那些无法被证伪为假）
      expect(s).not.toMatch(/我(去年|之前|曾经|做过|查过|身边有人|在项目里|在老东家)/);
      expect(s).not.toMatch(/(内部报告|内部数据|我朋友|我同事)/);
    }
  });

  it("锚点插在数据句之后（DATA_MARK 优先槽位）", () => {
    const t = buildExpoText();
    const out = injectFirstPersonAnchorPoints(t, rngMid, 0.95);
    const sents = out.split(/(?<=[。！？])/).filter((s) => s.trim());
    // 每个锚的前一句都应含数据触发词（goodSlots 来自 DATA_MARK 命中句的下一槽）
    const DATA_MARK = /(报告显示|数据显示|白皮书显示|调研显示|研究表明|数据表明|占比|同比|达到了|高达|根据[《\w].*?显示)/;
    for (let i = 1; i < sents.length; i++) {
      if (sents[i].startsWith("我个人觉得") || sents[i].startsWith("要我说") || sents[i].startsWith("在我看来") || sents[i].startsWith("我的看法是") || sents[i].startsWith("我觉得") || sents[i].startsWith("这点我持保留意见")) {
        expect(DATA_MARK.test(sents[i - 1])).toBe(true);
      }
    }
  });

  it("无数据句的纯论述也能均匀补槽注入（兜底路径）", () => {
    const t =
      "这个方案的第一个要点是控制预算的上限，避免出现不必要的浪费和重复支出。第二个要点是明确各团队的职责边界与协作方式，减少推诿。" +
      "第三个要点是建立例行的复盘机制，让问题能够被及时暴露出来。第四个要点是保持对外的口径一致，减少沟通中的误解与偏差。" +
      "第五个要点是预留足够的缓冲时间，给意外情况留出应对的余地。第六个要点是定期同步进展给相关方，确保信息不滞后也不失真。" +
      "第七个要点是在关键节点设置检查清单，把容易遗漏的细节提前固化下来。第八个要点是鼓励一线同学直接反馈问题，缩短决策链条。";
    expect(t.replace(/\s/g, "").length).toBeGreaterThanOrEqual(200);
    const out = injectFirstPersonAnchorPoints(t, rngMid, 0.95);
    expect(out).not.toBe(t);
    expect(out.split(/(?<=[。！？])/).length).toBeGreaterThan(
      t.split(/(?<=[。！？])/).length,
    );
  });

  it("确定性：同 rng 同输入输出一致", () => {
    const t = buildExpoText();
    expect(injectFirstPersonAnchorPoints(t, rngMid, 0.95)).toBe(
      injectFirstPersonAnchorPoints(t, rngMid, 0.95),
    );
  });
});
