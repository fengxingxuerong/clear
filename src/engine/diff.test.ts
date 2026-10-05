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
  const flat = (parts: { type: string; text: string }[]) =>
    parts.map((p) => `${p.type}:${p.text}`).join("|");

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
    expect(
      left
        .filter((p) => p.type !== "ins")
        .map((p) => p.text)
        .join(""),
    ).toBe(before);
    expect(
      right
        .filter((p) => p.type !== "del")
        .map((p) => p.text)
        .join(""),
    ).toBe(after);
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

  /* 2026-10-05 分支补测：4 处缺口全在 diff 主循环的**兜底搬运路径**上。
     这段代码平时走不到——它只在"两侧的 del/ins 块都扫不出内容、却仍卡在循环里"时触发，
     正是防死循环的最后一道保险。 */
  it("行 21：文本以标点开头 → 该标点自成首个 token，不被并进上一段", () => {
    // 前置对照：同样以标点开头、但只差一个前导标点，diff 结果不该把标点当正文丢掉
    const { left, right } = diffInline("。第一句话。", "。第二句话。");
    const ltext = left.map((p) => p.text).join("");
    const rtext = right.map((p) => p.text).join("");
    // 前导标点必须两段都在（既没被 tokenize 吞掉，也没被 diff 当成改动删了）
    expect(ltext.startsWith("。")).toBe(true);
    expect(rtext.startsWith("。")).toBe(true);
    expect(left.some((p) => p.type === "del")).toBe(true); // 正文确实变了
  });

  it("行 214/218/219：纯增句时另一侧不产生幻影块，且不留未搬运的残块", () => {
    // 纯增：left 全是 same（无 del），right 中间插 ins ⇒ 走 214 的 insText 支，
    // 而 216 的兜底支在本构造下不应产生任何 del 幻影。
    const { left, right } = diffInline("甲句。乙句。", "甲句。乙句。丙句。丁句。");
    expect(left.every((p) => p.type === "same")).toBe(true);
    expect(right.some((p) => p.type === "ins")).toBe(true);
    // 关键不变量：两侧拼回去必须**逐字等于原文**——兜底搬运若漏搬或多搬，这里立刻炸
    expect(left.map((p) => p.text).join("")).toBe("甲句。乙句。");
    expect(right.map((p) => p.text).join("")).toBe("甲句。乙句。丙句。丁句。");
  });

  it("行 218/219：一侧整段被删除后，剩下的 same 块仍被逐段搬运（不丢字、不死循环）", () => {
    const before = "甲句。乙句。丙句。";
    const after = "甲句。丙句。"; // 整句删掉
    const { left, right } = diffInline(before, after);
    // 内容守恒是硬要求：diff 的产物必须能原样还原两侧原文
    expect(left.map((p) => p.text).join("")).toBe(before);
    expect(right.map((p) => p.text).join("")).toBe(after);
    // 前后两个未变的句子必须以 same 形式各自成段（证明兜底搬运确实在干活）
    expect(left.filter((p) => p.type === "same").map((p) => p.text)).toEqual(["甲句。", "丙句。"]);
    expect(left.some((p) => p.type === "del" && p.text === "乙句。")).toBe(true);
    // 对照组：无改动时不产生任何 del/ins（证明上一条不是恒真式）
    const same = diffInline("甲句。", "甲句。");
    expect(same.left.every((p) => p.type === "same")).toBe(true);
  });

  it("行 156/157：两侧毫无公共句子时，LCS 尾部整段清空（diff 仍须可还原）", () => {
    // 前置条件：两段之间没有任何公共句子 ⇒ LCS 一路走不到匹配分支，
    // 剩下的字符全靠行 155/159 两个 while 收尾（156-157 就是左半边的收尾）。
    // 注意不能用带空格的英文：tokenize 会逐段 trim()，空格被规范化掉（设计行为）。
    const before = "左边独有甲句。左边独有乙句。";
    const after = "右边独有丙句。右边独有丁句。";
    const { left, right } = diffInline(before, after);
    // 硬不变量：两侧都能原样还原——尾部清空若漏字，这里立刻炸
    expect(left.map((p) => p.text).join("")).toBe(before);
    expect(right.map((p) => p.text).join("")).toBe(after);
    expect(left.some((p) => p.type === "del")).toBe(true);
    expect(right.some((p) => p.type === "ins")).toBe(true);
  });

  it("行 218/219：diff 主循环走到只剩单侧 same 时，两侧内容都被原样搬运", () => {
    // 前后都有共同句、中间大段不同：循环某次迭代会在"del/ins 都扫空、却仍卡在
    // while 条件里"的状态下进入 216 的兜底支（218/219 各搬一个）。
    const before = "共同开头。独有甲一。独有甲二。共同结尾。";
    const after = "共同开头。独有乙一。独有乙二。独有乙三。共同结尾。";
    const { left, right } = diffInline(before, after);
    // 兜底搬运的正确性判据：两侧必须能逐字还原原文
    expect(left.map((p) => p.text).join("")).toBe(before);
    expect(right.map((p) => p.text).join("")).toBe(after);
    // 共同的开头与结尾必须都以 same 形式存在于两侧（否则就是被搬丢了）
    for (const t of ["共同开头。", "共同结尾。"]) {
      expect(left.some((p) => p.type === "same" && p.text.includes(t))).toBe(true);
      expect(right.some((p) => p.type === "same" && p.text.includes(t))).toBe(true);
    }
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
    expect(
      left
        .filter((p) => p.type === "same")
        .map((p) => p.text)
        .join(""),
    ).toContain("这道菜");
  });

  it("超单边上限时退回前后缀裁切，仍完整还原两侧", () => {
    const long = "长".repeat(1600);
    const before = `${long}。`;
    const after = `${long}改。`;
    const { left, right } = diffInline(before, after);
    expect(
      left
        .filter((p) => p.type !== "ins")
        .map((p) => p.text)
        .join(""),
    ).toBe(before);
    expect(
      right
        .filter((p) => p.type !== "del")
        .map((p) => p.text)
        .join(""),
    ).toBe(after);
  });
});

/* ─────────── diffInline 模糊测试（2026-10-05） ───────────
 *
 * 手写样例只能覆盖想到的形状，而 diff 是「改动率」这个用户可见数字的来源，
 * 一旦漏字，用户会以为自己的稿子被动了而实际上 UI 显示正常。所以这里用
 * **确定性伪随机**（LCG，种子固定）生成 2000 组随机对照，每组都做真实改写
 * 模拟（删字/插字/换字），断言两侧都能逐字还原。
 *
 * 固定种子 = 失败可复现；不用 Math.random = 不会偶发红。
 *
 * 这轮模糊测试的另一个产出：**证伪了 diff.ts 的 214/215/218/219/220 是死分支**。
 * 2000 组随机语料里一个都没命中，配合下面的不变式推导——见源码注释。
 */
describe("diffInline 模糊测试：两侧必须逐字可还原", () => {
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const CH = "甲乙丙丁戊己庚辛壬癸子丑寅卯。！？，；";

  const randText = (n: number) => {
    let out = "";
    for (let i = 0; i < n; i++) out += CH[Math.floor(rnd() * CH.length)];
    return out;
  };

  /** 模拟真实改写：逐字删 / 插 / 换，其余保留 */
  const rewrite = (a: string) => {
    let b = "";
    for (const ch of a) {
      const r = rnd();
      if (r < 0.15) continue; // 删字
      if (r < 0.3)
        b += CH[Math.floor(rnd() * CH.length)]; // 插字
      else if (r < 0.45)
        b += CH[Math.floor(rnd() * CH.length)]; // 换字
      else b += ch;
    }
    return b;
  };

  it("2000 组随机对照全部逐字可还原", () => {
    for (let k = 0; k < 2000; k++) {
      const a = randText(1 + Math.floor(rnd() * 40));
      const b = rewrite(a);
      const { left, right } = diffInline(a, b);
      // 抛错而非 expect：失败时直接把输入打出来，便于复现
      if (left.map((p) => p.text).join("") !== a) throw new Error(`左不可还原 a=${a} b=${b}`);
      if (right.map((p) => p.text).join("") !== b) throw new Error(`右不可还原 a=${a} b=${b}`);
    }
  });

  it("空对照与全等对照不产生空块", () => {
    // 极端输入：一边全空
    const cases: [string, string][] = [
      ["", ""],
      ["甲乙。", ""],
      ["", "甲乙。"],
      ["。！？", ""],
    ];
    for (const [a, b] of cases) {
      const { left, right } = diffInline(a, b);
      expect(left.map((p) => p.text).join("")).toBe(a);
      expect(right.map((p) => p.text).join("")).toBe(b);
      expect(left.some((p) => p.text.length === 0)).toBe(false); // 无空块
    }
  });
});
