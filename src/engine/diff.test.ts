/**
 * diff.ts 引擎单测：句级 LCS diff 与前后缀裁切。
 * DiffView 只做了渲染级断言，这里锁死算法本身的正确性（保序/还原/边界）。
 */
import { describe, it, expect } from "vitest";
import { diffSentences, diffInline, diffStats, trimCommon, type DiffPart } from "./diff";

function typesOf(parts: DiffPart[]): string {
  return parts.map((p) => p.type).join("");
}

describe("diffSentences（句级 LCS）", () => {
  it("完全相同：左右全 same，无改动", () => {
    const t = "第一句。第二句。第三句。";
    const { left, right } = diffSentences(t, t);
    expect(left.every((p) => p.type === "same")).toBe(true);
    expect(right.every((p) => p.type === "same")).toBe(true);
  });

  it("单句被替换：左 del 右 ins，未变句保持 same", () => {
    const { left, right } = diffSentences(
      "甲句不变。乙句要换。丙句不变。",
      "甲句不变。乙句换了。丙句不变。",
    );
    expect(left.some((p) => p.type === "del")).toBe(true);
    expect(right.some((p) => p.type === "ins")).toBe(true);
    // LCS 保证未变句两侧都保留
    expect(left.filter((p) => p.type === "same").length).toBeGreaterThanOrEqual(2);
    expect(right.filter((p) => p.type === "same").length).toBeGreaterThanOrEqual(2);
  });

  it("右侧新增句子：右 ins、左不动", () => {
    const { left, right } = diffSentences("只有一句。", "只有一句。多出来一句。");
    expect(left.every((p) => p.type === "same")).toBe(true);
    expect(typesOf(right)).toContain("i");
  });

  it("右侧删句：左 del、右全 same", () => {
    const { left, right } = diffSentences("第一句。多余的一句。第二句。", "第一句。第二句。");
    expect(typesOf(left)).toContain("d");
    expect(right.every((p) => p.type === "same")).toBe(true);
  });

  it("完全不同：左全 del、右全 ins（LCS 为空）", () => {
    const { left, right } = diffSentences("苹果香蕉。", "汽车飞机。");
    expect(left.every((p) => p.type === "del")).toBe(true);
    expect(right.every((p) => p.type === "ins")).toBe(true);
  });

  it("空串边界：不抛错，另一侧整体标记", () => {
    const a = diffSentences("", "新文本。");
    expect(a.left).toEqual([]);
    expect(a.right.every((p) => p.type === "ins")).toBe(true);
    const b = diffSentences("旧文本。", "");
    expect(b.left.every((p) => p.type === "del")).toBe(true);
    expect(b.right).toEqual([]);
  });

  it("还原性：left del+same 拼回原文，right ins+same 拼回改后稿", () => {
    const before = "总而言之，效率提升。数据很好。综上，就此结束。";
    const after = "效率提升了不少。数据很扎实。就此结束吧。";
    const { left, right } = diffSentences(before, after);
    expect(left.map((p) => p.text).join("")).toBe(before);
    expect(right.map((p) => p.text).join("")).toBe(after);
  });

  it("保持语序：same 块在左右两侧的相对顺序一致（LCS 保序）", () => {
    const { left, right } = diffSentences("A句。B句。C句。D句。", "B句。X句。C句。");
    const sameLeft = left.filter((p) => p.type === "same").map((p) => p.text);
    const sameRight = right.filter((p) => p.type === "same").map((p) => p.text);
    expect(sameLeft).toEqual(sameRight);
    expect(sameLeft.join("")).toContain("B句。");
    expect(sameLeft.join("")).toContain("C句。");
  });

  it("无结尾标点的句子也能成块", () => {
    const { left } = diffSentences("有标点。没标点", "有标点。");
    expect(left.map((p) => p.text).join("")).toContain("没标点");
  });
});

describe("trimCommon（前后缀裁切）", () => {
  it("中间变更：pre/post 正确切出，midOld/midNew 为差异段", () => {
    const r = trimCommon("本项目的完成度很高", "本项目的完成度不错啊");
    expect(r.pre).toBe("本项目的完成度");
    expect(r.midOld).toBe("很高");
    expect(r.midNew).toBe("不错啊");
    expect(r.post).toBe("");
  });

  it("尾部变更：post 为空", () => {
    const r = trimCommon("前缀相同然后是旧的", "前缀相同然后是新的内容");
    expect(r.pre).toBe("前缀相同然后是");
    expect(r.midOld).toBe("旧的");
    expect(r.midNew).toBe("新的内容");
    expect(r.post).toBe("");
  });

  it("首部变更：pre 为空", () => {
    const r = trimCommon("旧开头，后面一致", "新开头，后面一致");
    expect(r.pre).toBe("");
    // 首字符不同即停，midOld 只含到公共后缀前
    expect(r.midOld).toBe("旧");
    expect(r.post).toBe("开头，后面一致");
    expect(r.pre + r.midOld + r.post).toBe("旧开头，后面一致");
  });

  it("完全相同：midOld/midNew 为空串", () => {
    const r = trimCommon("一模一样", "一模一样");
    expect(r.pre).toBe("一模一样");
    expect(r.midOld).toBe("");
    expect(r.midNew).toBe("");
    expect(r.post).toBe("");
  });

  it("完全不同：pre/post 均为空", () => {
    const r = trimCommon("甲甲甲", "乙乙乙乙");
    expect(r.pre).toBe("");
    expect(r.post).toBe("");
    expect(r.midOld).toBe("甲甲甲");
    expect(r.midNew).toBe("乙乙乙乙");
  });

  it("空串边界：不抛错", () => {
    const a = trimCommon("", "abc");
    expect(a.midOld).toBe("");
    expect(a.midNew).toBe("abc");
    const b = trimCommon("abc", "");
    expect(b.midOld).toBe("abc");
    expect(b.midNew).toBe("");
  });

  it("拼接还原：pre + mid + post 还原两个输入", () => {
    const full = "公共前缀中间变了公共后缀";
    const changed = "公共前缀中间改掉公共后缀";
    const r = trimCommon(full, changed);
    expect(r.pre + r.midOld + r.post).toBe(full);
    expect(r.pre + r.midNew + r.post).toBe(changed);
  });
});

describe("diffInline（字符粒度）", () => {
  const flat = (parts: { type: string; text: string }[]) => parts.map((p) => `${p.type}:${p.text}`).join("|");

  it("句内小改动：只把变的那个词标成 del/ins，其余保持 same", () => {
    const { left, right } = diffInline("值得注意的是，这道菜非常好吃。", "说白了，这道菜挺好吃。");
    expect(flat(left)).toContain("del:值得注意");
    expect(flat(right)).toContain("ins:说白了");
    // 未动的部分必须是 same，不能整句涂色
    expect(flat(left)).toContain("same:，这道菜");
  });

  it("完全相同：左右全 same，无 del/ins", () => {
    const t = "第一句。第二句。";
    const { left, right } = diffInline(t, t);
    expect(left.every((p) => p.type === "same")).toBe(true);
    expect(right.every((p) => p.type === "same")).toBe(true);
  });

  it("还原性：left 的 same+del 拼回原文，right 的 same+ins 拼回改后稿", () => {
    const before = "我们进行了优化，予以了反馈。效率提升了，成本降低了。";
    const after = "我们优化了一遍，给了反馈。效率上来了，成本降了，风险也可控。";
    const { left, right } = diffInline(before, after);
    expect(left.filter((p) => p.type !== "ins").map((p) => p.text).join("")).toBe(before);
    expect(right.filter((p) => p.type !== "del").map((p) => p.text).join("")).toBe(after);
  });

  it("纯增句 / 纯删句：单侧成块，另一侧不产生幻影块", () => {
    const { left, right } = diffInline("第一句。第二句。", "第一句。第二句。第三句。");
    expect(left.some((p) => p.type === "del")).toBe(false);
    expect(right.some((p) => p.type === "ins")).toBe(true);
  });

  it("空串边界：不抛错", () => {
    expect(() => diffInline("", "")).not.toThrow();
    expect(() => diffInline("有内容的一句话。", "")).not.toThrow();
    expect(() => diffInline("", "有内容的一句话。")).not.toThrow();
  });
});

describe("diffStats（改动率）", () => {
  it("无改动：改动率为 0", () => {
    const s = diffStats("同一句话。", "同一句话。");
    expect(s.ratio).toBe(0);
    expect(s.removed + s.added).toBe(0);
  });

  it("改少数几个字：改动率应为个位数百分比，而非整句占比", () => {
    const before = "这道菜的口味非常的好，值得大家去品尝一下。";
    const after = "这道菜的口味挺的好，值得大家去品尝一下。";
    const s = diffStats(before, after);
    expect(s.removed).toBeGreaterThan(0);
    expect(s.ratio).toBeGreaterThan(0);
    expect(s.ratio).toBeLessThan(15);
  });

  it("分母是原文规模：total === kept + removed", () => {
    const s = diffStats("第一句。第二句。", "第一句。第二句改了。");
    expect(s.total).toBe(s.kept + s.removed);
  });

  it("空原文不除零", () => {
    expect(diffStats("", "新增的一句话。").ratio).toBe(0);
  });
});

describe("diffInline（字符粒度的两个硬要求）", () => {
  it("一句内两处独立改动必须分开标注，不得合并成一整块", () => {
    const { left } = diffInline("值得注意的是，这道菜非常好吃。", "说白了，这道菜挺好吃。");
    const dels = left.filter((p) => p.type === "del");
    expect(dels.length).toBeGreaterThanOrEqual(2);
    expect(dels.map((p) => p.text)).toContain("非常");
    expect(left.filter((p) => p.type === "same").map((p) => p.text).join("")).toContain("这道菜");
  });

  it("超单边上限时退回前后缀裁切，仍完整还原两侧", () => {
    const long = "长".repeat(1600);
    const before = `${long}。`;
    const after = `${long}改。`;
    const { left, right } = diffInline(before, after);
    expect(left.filter((p) => p.type !== "ins").map((p) => p.text).join("")).toBe(before);
    expect(right.filter((p) => p.type !== "del").map((p) => p.text).join("")).toBe(after);
  });
});
