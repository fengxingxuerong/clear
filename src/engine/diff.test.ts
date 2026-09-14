/**
 * diff.ts 引擎单测：句级 LCS diff 与前后缀裁切。
 * DiffView 只做了渲染级断言，这里锁死算法本身的正确性（保序/还原/边界）。
 */
import { describe, it, expect } from "vitest";
import { diffSentences, trimCommon, type DiffPart } from "./diff";

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
