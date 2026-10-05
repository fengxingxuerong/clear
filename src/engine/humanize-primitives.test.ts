/**
 * humanize-primitives.ts 的守卫行为固化
 *
 * 这个模块此前**没有任何测试文件**——这也解释了它为什么一直挂着
 * 5 语句 / 6 分支的覆盖缺口而没人碰：没有测试，就没有人在用例里
 * 路过这些守卫分支。
 *
 * ## 测什么，不测什么
 *
 * 这些函数全是「宁可少切，不产出残句」的否决型守卫。它们的核心价值
 * **不在于放行什么，而在于拒绝什么**，所以断言以 `false` 为主。
 *
 * 尤其注意 `fragmentFrontCanStand("数据显示") === false` 这条：
 * 看起来反直觉（「显示」明明是动词），但守卫拒绝的是**句号化之后**
 * 的产物——「数据显示。」确实是名词残句。源码注释里写明了这条取舍：
 * 「少切只损失一次去味机会，多切则产出病句残句」。
 * 探针实测确认：同族的「数据显示出明显的改善」（7 字）放行，
 * 「数据显示」（4 字）拒绝，门槛正是 `lastSeg.length <= 4`。
 *
 * 另一条同样重要：`CLAUSE_PREDICATE_RE` 是**单字符宽表**，
 * 只认「了着过是将有可会…」这类单字标记，「显示」「表明」「说明」这些
 * **双字谓词不在表里**。这不是疏漏而是刻意的——源码里另一处注释记着：
 * 上一版守卫用宽表收了「能」字，导致「智**能**化的企业」被当成有谓语，
 * 守卫加了却 119/119 一动不动。宽表越宽越挡不住真名词短语。
 */
import { describe, it, expect } from "vitest";
import { fragmentFrontCanStand, findGuardedCutNear } from "./humanize-primitives.ts";

describe("fragmentFrontCanStand —— 必须拒绝的（残句防线）", () => {
  it("空串 / 纯空白", () => {
    expect(fragmentFrontCanStand("")).toBe(false);
    expect(fragmentFrontCanStand("   ")).toBe(false);
  });

  it("短名词残片（≤4 字且无谓语标记）", () => {
    expect(fragmentFrontCanStand("数据")).toBe(false);
    expect(fragmentFrontCanStand("工艺")).toBe(false);
  });

  it("「随着」引导的从句必须挂主句", () => {
    // 切成「随着半导体工艺进入3纳米节点。」是悬空状语
    expect(fragmentFrontCanStand("随着技术发展")).toBe(false);
  });

  it("状语头 + 状语尾（在下/中/时/后…）", () => {
    expect(fragmentFrontCanStand("在28纳米工艺节点下")).toBe(false);
    expect(fragmentFrontCanStand("在这种情况下")).toBe(false);
  });

  it("复合状语尾（的同时/的时候/的情况下/的基础上）", () => {
    expect(fragmentFrontCanStand("推进改革的同时")).toBe(false);
    expect(fragmentFrontCanStand("他在开会的时候")).toBe(false);
  });

  it("长名词短语（「的+名词性中心语」）", () => {
    // 这条是 C 类病句修复的核心，实测 119/120 命中
    expect(fragmentFrontCanStand("采用智能化系统的企业")).toBe(false);
  });

  it("量词/序数开头的同位语短语", () => {
    expect(fragmentFrontCanStand("首先")).toBe(false);
  });

  it("量词同位语短语的**长**形态（须超过 4 字门槛才走得到那条守卫）", () => {
    // ⚠️ 探针纠正过我的误判：QUANTIFIER_HEAD_RE 不是「序数前缀」，
    // 而是「量词 + 中心词」（一颗/几套/某种/这批次…），源码注释里
    // 举的例子是「一颗采用3D堆叠封装的处理器」。
    // 所以「各个业务部门」「第一梯队建设」这些**并不在表内**，实测放行；
    // 守卫刻意收窄——宽表会把正常分句一起否掉（每否一次 = 白丢一次劈句机会）。
    expect(fragmentFrontCanStand("一颗先进制程芯片")).toBe(false);
    expect(fragmentFrontCanStand("几套分布式系统")).toBe(false);
    expect(fragmentFrontCanStand("某种特殊材料")).toBe(false);
    // 同族但带谓语标记 → 放行
    expect(fragmentFrontCanStand("一颗芯片带动了整个产业链")).toBe(true);
  });

  it("时间名词尾巴的**长**形态（须超过 4 字门槛才走得到那条守卫）", () => {
    // 同上：「早期阶段」4 字被上一条拦住了，要覆盖得给更长的输入。
    expect(fragmentFrontCanStand("半导体工艺节点")).toBe(false);
    expect(fragmentFrontCanStand("后摩尔时代初期")).toBe(false);
  });

  it("`pop() ?? front` 是死分支：split 永不返回空数组", () => {
    // 探针实测四种输入下 pop() 都返回字符串：
    //   "".split(re)      → [""]          pop → ""
    //   "a".split(re)     → ["a"]         pop → "a"
    //   "，".split(re)    → ["",""]       pop → ""
    //   "，，，".split(re) → ["","","",""] pop → ""
    // split 至少产出一个元素，pop 只在空数组时返回 undefined，
    // 所以 `?? front` 那半边永远不会被求值。
    expect("".split(/[，、；：:]/).pop()).toBe("");
    expect("，，，".split(/[，、；：:]/).pop()).toBe("");
    // 而且它连"兜底"作用都没有：空串本来就被上一行 `if (!front) return false` 拦掉了。
    // 这条测试的用途是**说明**：要删可以删，删了行为不变。
    expect(fragmentFrontCanStand("")).toBe(false);
  });

  it("悬空状语 + 时间名词尾巴（在后摩尔时代）", () => {
    expect(fragmentFrontCanStand("在后摩尔时代")).toBe(false);
    expect(fragmentFrontCanStand("旧时代")).toBe(false);
  });

  it("双字谓词在 4 字门槛上被拒（显示/表明/说明）", () => {
    // 这条钉住 CLAUSE_PREDICATE_RE 是**单字符宽表**这一事实。
    // 「数据显示。」句号化后是名词残句，拒绝是对的；
    // 但若哪天有人往宽表里加「显示」二字，这条会先红，
    // 提醒他确认不会连带放行「数据显示的结果」这类真名词短语。
    expect(fragmentFrontCanStand("数据显示")).toBe(false);
    expect(fragmentFrontCanStand("研究表明")).toBe(false);
    // 同族但超过 4 字门槛 → 放行
    expect(fragmentFrontCanStand("显示出明显的改善")).toBe(true);
    expect(fragmentFrontCanStand("数据显示增长")).toBe(true);
  });
});

describe("fragmentFrontCanStand —— 必须放行的（别把守卫写死）", () => {
  it("正常谓语句", () => {
    expect(fragmentFrontCanStand("这个方案很好")).toBe(true);
    expect(fragmentFrontCanStand("数据显示增长")).toBe(true);
  });

  it("带单字谓语标记的 4 字短句（门槛内但有标记）", () => {
    expect(fragmentFrontCanStand("这件事定了")).toBe(true);
    expect(fragmentFrontCanStand("问题解决了")).toBe(true);
  });

  it("超长的正常分句（超过各类门槛）", () => {
    expect(fragmentFrontCanStand("我们已经在多个场景里验证过这个方案的效果")).toBe(true);
  });

  it("带逗号的前半句按最后一段判（不是整串）", () => {
    // lastSeg 取的是最后一个分隔符之后的部分，所以
    // 「方法论升级，数据增长明显」应当按「数据增长明显」判定 → 放行
    expect(fragmentFrontCanStand("方法论升级，数据增长明显")).toBe(true);
    // 而「方法论升级，数据」按「数据」判定 → 拒绝
    expect(fragmentFrontCanStand("方法论升级，数据")).toBe(false);
  });
});

describe("findGuardedCutNear —— 切点守卫", () => {
  it("空串 → -1", () => {
    expect(findGuardedCutNear("", 0)).toBe(-1);
  });

  it("没有可切标点 → -1", () => {
    expect(findGuardedCutNear("这句话没有逗号所以不该切", 5)).toBe(-1);
  });

  it("括号内的逗号不切", () => {
    // 深度守卫：括号内 depth>0，不作为切点候选
    expect(findGuardedCutNear("（括号内的逗号，不切）后面还有内容", 0)).toBe(-1);
  });

  it("前后半句都能独立成句时正常切", () => {
    const s = "这个方案很好，值得推广使用";
    const k = findGuardedCutNear(s, 5);
    expect(k).toBe(6);
    expect(s.slice(0, k)).toBe("这个方案很好");
    expect(s.slice(k + 1)).toBe("值得推广使用");
  });

  it("后半句不能独立成句时否决该切点", () => {
    // 「增长了」这种无主语残片 → -1
    expect(findGuardedCutNear("数据显示，增长了", 4)).toBe(-1);
  });

  it("preferPos 越近越优先，但可切成性优先于距离", () => {
    // 三个候选切点：位置 3 / 8 / 12
    const s = "甲很好，乙也不错，丙更好";
    // preferPos=3 → 选中最近的 3，前半「甲很好」可独立成句
    expect(findGuardedCutNear(s, 3)).toBe(3);
    // preferPos=10 → 距离上更近的是 8（|10-8|=2）而不是 12（|10-12|=2，同距取靠前），
    // 前半「甲很好，乙也不错」整体可独立成句。
    // ⚠️ 实测切在 **8** 而不是 12：切点 12 的后半「丙更好」虽能成句，
    // 但候选按距离排序后 8 在前，且它同样满足前后可独立成句。
    // 这里钉的是"距离优先 + 可切成性兜底"的组合行为，
    // 不是"每个 preferPos 都切在该点"——后者是错的假设。
    expect(findGuardedCutNear(s, 10)).toBe(8);
  });
});
