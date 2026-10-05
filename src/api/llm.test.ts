/**
 * runHumanize 统一分发测试（覆盖报告 P2 盲区）：
 * API 优先 / 失败回退本地 / 未启用 API 直走本地 / 本地择优透传 / 长文分块拼接。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { runHumanize } from "./llm";
import { DEFAULT_API } from "./llm-config";
import { aiScore } from "../engine/humanize";

afterEach(() => {
  vi.unstubAllGlobals();
});

function okJson(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。";

/** 改写专家角色判定（质检员/检测员不在 runHumanize 单轮路径出现） */
function stubRewrite(reply: string | (() => Response)) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: { body?: string }) => {
      void init;
      return typeof reply === "string" ? okJson(reply) : reply();
    }),
  );
}

describe("runHumanize 分发", () => {
  it("API 未启用：直走本地引擎，usedApi=false", async () => {
    const cfg = { ...DEFAULT_API, enabled: false };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.usedApi).toBe(false);
    expect(r.engine).toBe("local");
    expect(r.degrade.join("")).toContain("未启用 API");
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.before.score).toBeGreaterThanOrEqual(r.after.score - 5); // 本地分不显著上升
  });

  it("API 启用单轮：走 LLM，输出经 crossChunkCleanup 后返回", async () => {
    stubRewrite("时间往前倒几年，这类工具还没几个人用，现在情况已经完全不一样了，值得慢慢琢磨。");
    // DEFAULT_API.deepMode 默认 true，单轮路径须显式关闭
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: false };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.usedApi).toBe(true);
    expect(r.engine).toBe("llm");
    expect(r.degrade).toEqual([]); // 全程 LLM，不得留降级痕迹
    expect(r.text).toContain("时间往前倒几年");
    expect(r.note).toBe("");
  });

  it("API 失败（404 无退避）：回退本地引擎，note 注明原因，结果不丢", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 404 })),
    );
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: false };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.usedApi).toBe(false);
    // 旧文案在这里会显示「未配置/未启用 API」——用户明明付了调用，那是假话
    expect(r.engine).toBe("local");
    expect(r.degrade.join("")).toContain("API 调用失败");
    expect(r.note.startsWith("⚠️")).toBe(true);
    expect(r.note).toMatch(/API 调用失败，已回退本地引擎/);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("API 空输出：视为失败回退本地（不把空串当结果）", async () => {
    stubRewrite("");
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: false };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.usedApi).toBe(false);
    expect(r.engine).toBe("local");
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("本地择优设置透传：bestOf 开启时返回 tried/rejected 信息", async () => {
    const cfg = { ...DEFAULT_API, enabled: false };
    const r = await runHumanize(SAMPLE, 0.7, cfg, undefined, false, undefined, {
      bestOf: true,
      candidates: 3,
    });
    expect(r.bestOf).toBeDefined();
    expect(r.bestOf!.tried).toBeGreaterThan(0);
    expect(r.bestOf!.tried).toBeLessThanOrEqual(3);
  });

  it("长文分块：超阈值文本逐块处理拼接，note 标注块数", async () => {
    // 每段约 550 字 × 4 段 ≈ 2200 字（> CHUNK_THRESHOLD=1200，CHUNK_SIZE=1000 → 多块）
    const unit =
      "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生，并且在内容生产领域获得了广泛的应用场景，成为了许多从业者日常工作中不可或缺的辅助手段之一，无论是新闻稿件的初稿撰写，还是营销文案的多版本迭代，都能看到这类工具活跃的身影。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本，同时还推动了组织内部协作方式的整体变革与持续演进，让跨部门的信息流转变得更加顺畅透明。然而，技术的变革也带来了一系列值得关注的挑战，比如内容同质化的隐忧、原创性判定的争议，以及对从业者技能结构的重塑压力。与此同时，如何平衡创新与风险，成为至关重要的课题，既不能因噎废食地拒绝新工具，也不能不加甄别地全盘接受，需要在实践探索中逐步建立相应的使用规范与质量标准。";
    const long = Array.from({ length: 4 }, () => unit).join("\n\n");
    stubRewrite("这是改写后的段落内容，读起来像人写的，节奏也更自然了一些。");
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: false };
    const r = await runHumanize(long, 0.7, cfg);
    expect(r.usedApi).toBe(true);
    expect(r.note).toMatch(/长文分块处理（\d+ 块）/);
    expect(r.text).toContain("这是改写后的段落内容");
  });

  it("深度模式：走 humanizeViaApiDeep 闭环，note 汇总各轮评分", async () => {
    // 样本不含英文术语——改写稿假人不保留原词时忠实度校验会打回
    const sample =
      "值得注意的是，随着智能技术的快速发展，写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。";
    // 角色化 mock：改写专家→正文，质检员→PASS，检测员→分数
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { messages: { content: string }[] };
        const sys = body.messages?.[0]?.content ?? "";
        if (sys.includes("质检员")) return okJson("PASS");
        if (sys.includes("改写专家"))
          return okJson(
            "时间往前倒几年，这类工具还没几个人用。现在情况完全不一样了，写作成本降了不少，效率也上来了。不过用得多了，内容同质化的担心也在，使用规范还得慢慢建立。",
          );
        return okJson("句长过于均匀\n35");
      }),
    );
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: true };
    const r = await runHumanize(sample, 0.7, cfg);
    expect(r.usedApi).toBe(true);
    expect(r.roundScores.length).toBeGreaterThan(0);
    expect(r.note).toMatch(/深度去味|评分/);
  });
});

/**
 * v0.9.14 编造否决的**接线**验证：深模式抛出后，runHumanize 必须把它标成
 * "编造否决 + 本地引擎产出"，而不是笼统的"API 调用失败"——两者对用户是不同的事实
 * （前者是我们主动拒收一份有新增断言的稿，后者是通路故障）。只测 deep 层会漏掉这段。
 */
describe("编造否决在 runHumanize 里的落点（v0.9.14）", () => {
  // 必须保留 SAMPLE 的英文术语 "AI"，且长度不低于原文 40%，否则 localHardGate 先把候选
  // 打回，根本走不到编造复核（实测两条报错：英文术语 AI 在改写中丢失 / 严重缩水 41<116×40%）
  const GOOD =
    "时间往前倒几年，AI 写作工具还没几个人用。办公数字化把效率提上来、成本压下去，可怎么在创新和风险之间找平衡，仍是道难题。";

  function stubStrictFidelity(finalReview: string) {
    let reviews = 0;
    const ok = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as {
          messages: { role: string; content: string }[];
        };
        const sys = body.messages?.[0]?.content ?? "";
        if (sys.includes("事实核查员")) {
          reviews++;
          // 复核要的是 JSON（extractJsonObject），给 "PASS" 会抛"未返回有效 JSON"
          return ok(reviews === 1 ? '{"fabrications":[]}' : finalReview);
        }
        if (sys.includes("质检员")) return ok("PASS");
        if (sys.includes("改写专家")) return ok(GOOD);
        return ok("句长过于均匀\n15");
      }),
    );
  }

  it("终审否决 → engine=local，degrade 写「编造复核否决」、note 写「编造否决」，不写「API 调用失败」", async () => {
    stubStrictFidelity('{"fabrications":["出门一天够用：原文只说完全满足日常需求"]}');
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", strictFidelity: true };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.engine).toBe("local");
    expect(r.usedApi).toBe(false);
    expect(r.degrade.join(" ")).toContain("编造复核否决");
    expect(r.note).toContain("编造否决");
    expect(r.note).toContain("出门一天够用");
    expect(r.note).not.toContain("API 调用失败"); // 不能混成通路故障
    expect(r.text.length).toBeGreaterThan(0); // 本地稿照交付，用户不该拿到空结果
  });

  it("终审干净 → 仍按 LLM 稿交付，不留降级痕迹", async () => {
    stubStrictFidelity('{"fabrications":[]}');
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", strictFidelity: true };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.engine).toBe("llm");
    expect(r.degrade).toEqual([]);
    expect(r.text).toContain("时间往前倒几年");
  });
});

/**
 * 深度/边界路径补深（5 案，分批落盘：1/4/5 → 2/3）。
 *
 * 覆盖注释（结构性说明，非用例）：
 * - b21@227（`deep.qcPassed.length ? … : ""` 的 false 支）结构性不可达：
 *   bestText 必在 qcPassed.push **之后**才可能产生——竞争段先 441/447 行
 *   push 再 456 行赋值，主循环先 552 行 push 再 620/647/651 行赋值；
 *   而 deliver 走到 llm.ts:227 时 bestText 必非空（否则 658 行先抛错），
 *   故 qcPassed 必非空，空数组分支没有测试可以触达。
 * - b26@238（`deep.hitTarget ? A : deep.note ? B : C` 的第三支 C
 *   「深度去味完成（未压到 N 以下）…」）结构性不可达：hitTarget=false 只能
 *   从主循环收场（llm-humanize.ts:663）返回，彼时 roundScores.length>0
 *   （push 先行，同上），328 行必把「仅完成 N 轮，未达目标…」appendNote 进
 *   deep.note ⇒ `deep.note` 恒为真，C 支永不可达。
 * - b10@182（分块路径 `rc(text) > 0` 的 false 支）见下方分块用例旁注。
 */
describe("runHumanize 边界与深度路径补深（1~5）", () => {
  it("1 短透传：去空白 <10 字直接跳过，engine=passthrough，fetch 零调用", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k" };
    const r = await runHumanize("短。", 0.7, cfg);
    expect(r.engine).toBe("passthrough");
    // llm.ts:104 逐字文案
    expect(r.note).toBe("文本过短（去空白 <10 字），跳过去味");
    expect(r.usedApi).toBe(false);
    expect(r.text).toBe("短。");
    // llm.ts:96-107 的边界守卫在任何 API 路径之前返回 → 网络零调用
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /* 案2/案3 的分块夹具。三段每段 ≥500 字、纯中文全角标点、零 ASCII——
   * 实测 localHardGate(P,P)=[]、checkFidelityLocal 恒过（见 scratch 复核），
   * 回声改写（桩返回用户消息原文）可稳定过候选门槛，避免修复链改写调用序。 */
  const P1 = `巷口那家修鞋摊还在。老头姓周，做了四十年鞋活，手上的老茧厚得能挡针，案子上摆着锤子、胶水和一摞鞋掌，熟客来了不用说话，把鞋往台面上一放，他扫一眼就知道要怎么收拾。上礼拜我那双皮鞋开胶，顺路扔给他，第二天去取，掌子钉得结结实实，收的钱比商场柜台的零头还少。他一边干活一边念叨，说现在年轻人鞋坏了就扔，肯修的越来越少，好在他不愁没活干，老街坊的鞋总得有人管。天冷的时候他会带个煤炉过来，炉上坐着铝壶，水开了给排队的人倒一杯，谁也不客气，接过来就喝。巷子里的小孩放学早，路过摊子会喊一声周爷爷，他应一声，从工具盒里摸出两颗糖，也不多话，孩子们就蹲在旁边看他敲敲打打。有回一双开了线的布鞋送到他手上，他穿针引线补了半下午，只收了零钱，说这种活不值当要价，顺手的事。来取鞋的人问能不能微信付，他摆摆手，指指摊位角上压着的二维码牌子，说闺女给弄的，扫那个就行。雨天生意清淡，他就整理库存，把回收来的旧鞋底分门别类码好，谁家缺什么配件，他心里有本账。开春那阵子他把摊子挪到梧桐树下，说是风口暖和，胶干得快，一晌午能多接几双活。傍晚收摊时他把木箱搬到三轮车斗里，用麻绳绕两圈扎紧，蹬车走的时候链条响得很有节奏，巷子里的人听声就知道他走了。有人劝他租个门面，他摇头，说站惯了街口，进门反而浑身不自在。`;
  const P2 = `菜市场东头卖豆腐的摊子换了人，原先的老陈回老家带孙子去了。新来的是个三十出头的女人，嗓门大，切豆腐下刀利索，一板豆腐在她手里像翻书一样快。她记得住老主顾的口味：王婶要老豆腐，炖汤用；对门早餐铺要嫩的，点卤轻一档；楼上的小伙子只买边角料，说是回去炸丸子。买完菜顺路的人会停下聊两句天气，她一边称重一边接话，秤高秤低从不算计。摊位不大，一块木板架在两只筐上，豆腐分门别类摆开，老的嫩的中间隔着片湿纱布，防止风干。她话密，称完总要多送一小块，说是搭着吃，转头又招呼下一位，手上的活计一点不耽误。清早五点多她就去批发市场进货，来回蹬三轮要四十分钟，回来正好赶第一波买菜的人。有位老太太腿脚不便，隔几天就托人捎话，让她留一块嫩豆腐，等下午孙子放学顺路来拿。入夏以后她换了新冰柜，插上电嗡嗡响，豆腐泡在凉水里能多放半天，街坊都说她这摊子东西新鲜。散场前剩下的边角料她不带回家，便宜卖给旁边开小饭馆的，两边都落个实惠，从不为这几毛钱红脸。她男人送货，两口子一个管做，一个管跑，日子就这样一天天滚起来。有一回下雨，她把遮阳布往里收了收，先拿塑料布盖住码在筐边的豆干，自己淋着也不着急。天热的时候她会切两块豆腐边角泡在盐水里，留给收摊晚的环卫工，谁也不提钱的事。孩子们放学绕过来，她总要塞一小块，说是吃着玩，回头又被家长数落不该占人便宜。`;
  const P3 = `父亲退休以后迷上了养花，阳台那点地方摆了十几盆，茉莉、吊兰、还有一株半死不活的栀子。他每天早上第一件事是端着喷壶挨个喷水，叶子正反面都照顾到，比上班打卡还准时。栀子最娇气，叶子发黄他就紧张，翻书查土的酸碱度，又去花市讨教，来回折腾了一个春天，终于冒出两朵白花。那天他把花搬到客厅中间，谁进门都要介绍一遍，语气里压着得意。母亲嫌他占地方，嘴上抱怨，转头却把花挪到晒得到太阳的位置。阳台的花盆是他从旧货市场淘的，泥瓦的，便宜，透气，比花店里那些釉面盆好使。浇水有讲究，隔三天一次，浇就浇透，盆底渗出水来才停，这套规矩他是从园艺书上抄的。有一盆绿萝长得最疯，藤蔓垂到客厅电视柜上，母亲剪下来插瓶，转眼又活一盆，送给楼下的邻居。夏天蚊子多，他在花盆边上放了几盒驱蚊水，说是花盆积水招虫，顺手的事，谁也不麻烦。邻居上来讨教养花的法子，他也不藏私，把换盆的时间、施肥的分量掰开揉碎了讲，讲完还送两包花肥。花市搬来那年他跑了三趟，最后一趟拉回半人高的架子，靠墙立好，把喜阴的花全挪到下层。他年轻时在厂里做钳工，手上有力气，倒盆换土这种活从不假手于人，说是活动活动筋骨。如今那株栀子年年开花，花期一到，满屋子都是甜的，父亲就坐在旁边看书，也不浇水，只偶尔抬头看一眼。`;
  // 案3 的两块：P1/P2 各再加长 → 单块 <1000 字、两块去空白合计 >1200 → splitIntoChunks 恰好 2 块
  const Q1 =
    P1 +
    `巷尾还有个配钥匙的小摊，老周收摊后会绕过去聊两句，两人从行情聊到孙子的功课，天黑透了才各回各家。雨大的时候两家挤一个棚子下，谁买了热乎的烤红薯就掰开分着吃，谁也不讲究那些客套。钥匙摊老伴儿爱种葱，摊子角上的泡沫箱里插着几根，随手割一把扔进谁的菜篮都没人计较。`;
  const Q2 =
    P2 +
    `到了年关，她提前备了黄豆，说是作坊的货紧，宁可自己多跑两趟，也不让老主顾空手。摊子边上常年搁着个小马扎，谁买完菜歇脚都随便坐，坐久了她还会递杯热水过去。城管过来检查那天她也不慌，手续齐全摆得端正，反倒帮着旁边临时占道的打圆场。`;

  /* b10@182（llm.ts 分块路径 `shrinkRatio = rc(text) > 0 ? … : undefined`）的
   * false 支结构性不可达：能进分块分支即 visibleLen > CHUNK_THRESHOLD=1200
   * （llm.ts:121），故 rc(text) ≥ 1200 > 0 恒真——`rc(text) > 0` 为假的
   * undefined 支没有任何测试可以触达（与 165 行 `s >= 0` 同类防御性写法）。 */
  it("2 深度分块成功：3 块全链（质检员→改写专家→检测员路由），note 汇总评分与质检", async () => {
    let detectCalls = 0;
    let qcCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { messages: { content: string }[] };
        const sys = body.messages?.[0]?.content ?? "";
        // 角色桩路由顺序必须「质检员 → 改写专家 → 检测员」：SYSTEM_PROMPT 文本里
        // 也含「检测员」（开头/第 12 条），先判检测员会把改写调用误路由成评分
        if (sys.includes("质检员")) return okJson(qcCalls++ === 0 ? "PASS" : "");
        if (sys.includes("改写专家")) return okJson(body.messages[1]?.content ?? ""); // 回声改写
        const i = detectCalls++;
        if (i < 3) return okJson("句长过于均匀\n25"); // 块1：judgeScoreStable 3 轮同分
        if (i < 6) return okJson("过渡词残留\n12"); // 块2
        return okJson("这稿子写得很自然，读着没什么毛病。"); // 块3：无数字垃圾 → 评分失败记 -1
      }),
    );
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: true };
    const long = [P1, P2, P3].join("\n\n");
    expect(long.replace(/\s/g, "").length).toBeGreaterThan(1200); // 进分块分支的前提
    const r = await runHumanize(long, 0.7, cfg);
    expect(r.usedApi).toBe(true);
    expect(r.engine).toBe("llm"); // localChunks===0 → 纯 LLM
    expect(r.note).toContain("长文分块处理（3 块）");
    // 块1=25（好区收手）、块2=12、块3 检测员垃圾 → -1 映射为「失败」
    expect(r.note).toContain("各块评分 25、12、失败");
    // qcPassed：块1/块2 各 1 轮 + 块3 两轮（质检空体 throw → catch 放行，pass 带 issues）
    expect(r.note).toContain("质检 4/4 通过");
    expect(r.roundScores).toContain(-1);
    // 三块都由 LLM 回声稿拼成，无本地补位
    expect(r.text).toContain("修鞋摊");
    expect(r.text).toContain("卖豆腐");
    expect(r.text).toContain("养花");
  });

  it("3 混拼失败：块1 改写两档皆空 → LLM 未产出；块2 终审编造否决 → engine=mixed、note 以 ⚠️ 开头", async () => {
    let fabCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { messages: { content: string }[] };
        const sys = body.messages?.[0]?.content ?? "";
        if (sys.includes("质检员")) return okJson("PASS");
        // 事实核查员：候选期第 1 次干净 → 进评分；deliver 收稿终审第 2 次审出编造
        // → FabricationVetoError → 分块循环 catch → 「LLM 稿编造否决」降级文案
        if (sys.includes("事实核查员")) {
          return okJson(
            fabCalls++ === 0
              ? '{"fabrications":[]}'
              : '{"fabrications":["原文没有提到的具体细节：凭空多出的使用年限保证"]}',
          );
        }
        if (sys.includes("改写专家")) {
          // 块1（巷口修鞋摊）：默认档与 token 翻倍档皆回空串 → chatNonEmpty 空 → throw
          if ((body.messages[1]?.content ?? "").includes("巷口那家修鞋摊")) return okJson("");
          return okJson(body.messages[1]?.content ?? ""); // 块2 回声（过硬门槛）
        }
        return okJson("句长过于均匀\n15"); // 检测员
      }),
    );
    const cfg = {
      ...DEFAULT_API,
      enabled: true,
      apiKey: "k",
      deepMode: true,
      strictFidelity: true,
    };
    const long = Q1 + "\n\n" + Q2;
    expect(long.replace(/\s/g, "").length).toBeGreaterThan(1200);
    const r = await runHumanize(long, 0.7, cfg);
    expect(r.usedApi).toBe(true); // 混拼：调用过 API，但两块都被本地补位
    expect(r.engine).toBe("mixed"); // localChunks>0
    // llm.ts:163-166 逐字降级文案
    expect(r.degrade).toContain("第 1/2 块 LLM 未产出，已由本地引擎温和档补位");
    expect(r.degrade).toContain("第 2/2 块 LLM 稿编造否决，已由本地引擎温和档补位");
    expect(r.note.startsWith("⚠️")).toBe(true); // 降级原因前置
    expect(r.note).toContain("长文分块处理（2 块）");
  });

  it("4 单深：检测员三轮返回不可解析内容 → roundScores 含 -1，note 含「AI 味评分（越低越好）」与「失败」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { messages: { content: string }[] };
        const sys = body.messages?.[0]?.content ?? "";
        // 路由顺序：质检员 → 改写专家 →（其余）检测员
        if (sys.includes("质检员")) return okJson(""); // 无输出 → qualityCheck 抛错 → catch 放行
        if (sys.includes("改写专家")) return okJson(body.messages[1]?.content ?? ""); // 回声改写
        return okJson("这稿子读起来挺自然，没什么可说的。"); // 检测员垃圾：无数字 → 解析必败
      }),
    );
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: true };
    const r = await runHumanize(SAMPLE, 0.7, cfg);
    expect(r.usedApi).toBe(true);
    expect(r.engine).toBe("llm");
    // judgeScoreStable 三轮全部「模型未给出数字」→ processCandidate 兜底 score=null → 记 -1
    expect(r.roundScores).toContain(-1);
    // 深度 note（llm.ts:235-242）：hitTarget=false 且 deep.note 非空时按 `${deep.note}：AI 味评分…` 拼
    expect(r.note).toContain("AI 味评分（越低越好）");
    expect(r.note).toContain("失败"); // shown = roundScores 映射的「失败」
  });

  it("5 低 AI 味提示：before<35 且 API 成功 → note 追加「收益有限」提示", async () => {
    // 用 aiScore 实测挑的样本（正式公文 H6）：得分 26 < 35
    const low =
      "为深入贯彻落实数字化转型战略部署，本单位结合业务实际，制定了三年行动方案。方案明确，到 2028 年，核心业务系统上云率不低于 90%，数据治理体系基本建成，跨部门协同机制运转顺畅。";
    expect(aiScore(low).score).toBeLessThan(35);
    stubRewrite("方案定了三年目标，云上系统要全覆盖，数据也得管起来，各部门协作的规矩得写清楚。");
    const cfg = { ...DEFAULT_API, enabled: true, apiKey: "k", deepMode: false };
    const r = await runHumanize(low, 0.7, cfg);
    expect(r.usedApi).toBe(true); // tip 条件：before.score < 35 && usedApi（llm.ts:285）
    expect(r.before.score).toBeLessThan(35);
    // llm.ts:286 逐字文案
    expect(r.note).toContain("（提示：输入 AI 味已较低，本轮收益有限；重复/串联去味不建议）");
  });
});
