/**
 * 趣AI味 · 第 8 项困惑度阈值标定脚本（真实 ONNX 推理，CI 之外手动运行）
 *
 * 用法：npx tsx scripts/ppl-calibrate.ts
 * 说明：
 *   - 首次运行会从镜像站下载约 100MB 的 int8 模型缓存到 ./.cache，之后离线可用；
 *   - 打分数学与 src/ppl/ppl-worker.ts 同构（MLM 多位置掩码 + logsumexp），
 *     选点/求值复用共享内核 scorer-core.ts；
 *   - 输出人工写作组与 AI 生成组的 meanNll / 窗间σ 分布，
 *     对照 engine/humanize-metrics.ts 中当前常量给出复核结论。
 */
import {
  MASK_GROUPS,
  aggregateText,
  maskGroups,
  maskedMeanNll,
  nllToPerplexity,
  selectTargets,
} from "../src/ppl/scorer-core.ts";
import type { PplWindow } from "../src/ppl/scorer-core.ts";
import {
  PPL_MAX_WIN_STD,
  PPL_MIN_CHARS,
  PPL_MIN_MEAN_NLL,
  PPL_MIN_WINDOWS,
} from "../src/engine/humanize-metrics.ts";

/* ---------------- 标定语料：人工风格 vs AI 风格，各 4 篇 ---------------- */

const HUMAN: Array<{ label: string; text: string }> = [
  {
    label: "人工·夜宵碎念",
    text: `昨天半夜突然想吃泡面，翻了半天柜子只找到一包过期两个月的，纠结了三分钟还是煮了。说实话味道没什么变化，就是面饼有点受潮，不太脆。我妈要是知道肯定又得念叨我，上回吃冰箱里放了半个月的剩菜，拉了两天肚子，她到现在还拿这事说嘴。今天早上起来嗓子有点疼，可能是昨晚开空调的原因，也可能是泡面上火。反正就是不想上班，想请个假在家躺着刷手机。算了算了，这个月全勤奖还有三百块呢，忍忍就过去了。中午跟老张约好去吃公司楼下新开的那家麻辣烫，听说他家丸子是手工的，也不知道是不是真的，现在商家吹牛不打草稿的太多了。吃到一半他接了个电话，脸色一下就不对，说是老家那边亲戚出事了，饭也没吃完就走了。我一个人坐着把剩下的吃完，汤都喝光了，有点撑，又有点说不出来的难受。下午开会差点睡着，被领导点名站起来回答问题，支支吾吾半天，旁边的小刘偷偷递了张纸条过来，上面写着答案，还好没被看见。`,
  },
  {
    label: "人工·楼下早餐摊",
    text: `我家楼下的早餐摊换了老板，原来那对夫妻回老家带孙子去了。新来的小伙子人挺勤快，就是手艺差了点，煎包底部糊得发苦，豆浆也稀得像水。我提了一嘴，他倒是不恼，笑呵呵说下个月换个炉子。唉，做小本生意不容易，能改就好。前几天降温，摊子边上多了个保温桶，里面是免费的红姜茶，路过喝一杯，心里还挺暖的。这条街十年间换了七八拨人，卖菜的、修鞋的、配钥匙的，来来走走，就我这种吃早饭的一直没变。有时候想想也挺感慨，前几年有个卖糖炒栗子的大爷，冬天凌晨四点就来占位置，后来听说腰坏了回乡下养着，再也没来过。他那栗子是真甜，壳也好剥，现在再没吃过那么好的。新来的小伙子看我天天来，已经记住我的口味了，煎包不要辣、豆浆少糖，有时候忘了找零，下次见面会主动补给我。就这么点小事，倒是让我这租房住的外地人多了一点落脚的感觉。`,
  },
  {
    label: "人工·宜家半日游",
    text: `周末去了趟宜家，本来只想买个置物架，结果推着推车在样板间转了俩小时，出来的时候购物车上堆了蜡烛、相框、还有一个根本用不上的地毯。结账排队的时候前面一对小情侣为了要不要买那个三百多块的落地灯吵架，女孩说要氛围感，男孩说灯是用来照亮的不是用来感的，我在后面听得直乐。回家组装置物架，说明书上的图看半天，装反了一次，拆了重来，弄完一身汗。我老婆在旁边拍照发朋友圈，配文是男人动手能力鉴定现场。你说气人不气人。装到最后多出来两颗螺丝，我俩盯着地上那两颗螺丝研究半天，到底是从哪一步多出来的，最后一致决定当它不存在，反正架子立住了就行。晚上叫了外卖，坐在新置物架旁边吃饭，还专门把手机支架摆上去试了试，稳得很。三百多块钱花出去，买了个铁架子加一下午的折腾，图什么呢？但说不上来，家里好像真的整齐了一点，心情也跟着好了那么一点点。`,
  },
  {
    label: "人工·长文·搬家记",
    text: `这次搬家算是把我这些年的懒账全清了一遍。收拾厨房的时候，翻出一箱从来没拆封的保鲜盒，是三年前双十一凑单买的，包装盒上的字都有点褪色了。我媳妇说扔了吧，我说留着还能用，俩人为这个僵持了十分钟，最后各退一步，留一半扔一半。结果打包的时候那留的一半一个都没用上，白背到了新家。最要命的是书。四个纸箱全是书，大学时候的专业课教材一本都舍不得卖，总觉得哪天还要翻，实际上毕业八年一次都没打开过。搬家公司的小哥扛着箱子问我，哥你是学什么专业的，我说学机械的，现在做运营，小哥笑了，说你这书搬得比人还累。新家在六楼，没电梯。搬完当天晚上我俩瘫在床垫上，连床架都没力气装，点了顿烧烤犒劳自己，吃着吃着就睡着了。第二天醒来浑身疼，但是推开窗一看，楼下有棵特别大的梧桐树，阳光从叶子里漏下来，忽然觉得六楼也挺好的。现在住进来快一个月了，还有些箱子没拆，估计得放到过年。媳妇说我拖延，我说这叫给生活留点悬念，万一哪天拆箱拆出个惊喜呢。其实我们都知道，里面就是我那些再也不看的教材。`,
  },
];

const AI: Array<{ label: string; text: string }> = [
  {
    label: "AI·技术发展",
    text: `随着人工智能技术的快速发展，大语言模型在各个领域的应用日益广泛。从自然语言处理到代码生成，从智能客服到内容创作，人工智能正在深刻改变着我们的工作和生活方式。首先，人工智能技术显著提升了生产效率，为传统行业的数字化转型提供了新的可能。企业通过引入智能化工具，能够大幅降低人力成本，优化业务流程，实现资源的精准配置。其次，人工智能的发展也带来了一系列挑战，包括数据安全问题、算法偏见问题以及就业结构的深刻调整。这些问题如果处理不当，可能会加剧社会的不平等，影响公众对技术的信任。因此，我们需要建立完善的监管体系和技术标准，在鼓励技术创新的同时加强风险防控。政府部门应当加快相关法律法规的制定，明确责任边界；企业应当承担社会责任，确保技术应用符合伦理规范；公众也需要提升数字素养，理性看待技术变革。综上所述，人工智能是一把双刃剑，既蕴含巨大的发展机遇，也伴随着不容忽视的风险。只有政府、企业和公众共同努力，才能推动人工智能朝着造福人类的方向可持续发展。`,
  },
  {
    label: "AI·健康生活",
    text: `健康的生活方式对每个人而言都至关重要。保持健康的身体需要从多个方面入手，形成科学合理的生活习惯。第一，合理的饮食习惯是健康的基础，建议均衡摄入蛋白质、碳水化合物和脂肪，多吃新鲜的蔬菜水果，减少高油高盐和高糖食品的消费，避免暴饮暴食等不良习惯。第二，规律的作息同样不可忽视，充足的睡眠有助于身体的自我修复和免疫系统的正常运转，成年人应当保证每天七到八小时的睡眠时间。第三，适度的体育锻炼能够增强心肺功能，改善血液循环，缓解精神压力，建议每周进行三到五次中等强度的运动，每次持续三十分钟以上。此外，定期体检可以帮助我们及时了解自身的健康状况，做到疾病早发现、早诊断、早治疗。心理健康与身体健康同等重要，学会调节情绪、释放压力，保持积极乐观的心态，是现代生活中不可缺少的能力。总而言之，健康管理是一项长期的系统工程，良好的生活习惯是对自己最有价值的投资，需要持之以恒地坚持。`,
  },
  {
    label: "AI·深度阅读",
    text: `阅读是人类获取知识的重要途径之一。在信息爆炸的时代，深度阅读的价值愈发凸显。一方面，阅读能够拓宽视野，帮助我们跨越时空的限制，了解不同的文化背景与思想观念；另一方面，阅读可以提升思维能力，培养逻辑分析和批判性思考的习惯，使人在面对复杂问题时能够保持清醒的判断。然而，碎片化的浅阅读正在占据人们越来越多的时间，短视频和社交媒体的兴起使得系统性阅读面临严峻挑战。相关调查显示，近年来国民人均纸质图书阅读量增长缓慢，深度阅读的比例仍有待提高。对此，专家建议，应当制定合理的阅读计划，选择经典著作进行精读，并做好读书笔记以加深理解和记忆。同时，家庭和学校也应当共同营造良好的阅读氛围，从儿童时期开始培养阅读兴趣，让阅读成为一种终身受益的生活方式。社会各界可以通过举办读书活动、建设公共图书馆等方式，为全民阅读创造更加便利的条件。唯有如此，阅读才能真正成为个人成长与社会进步的坚实基石。`,
  },
  {
    label: "AI·长文·时间管理",
    text: `时间管理是现代人必须掌握的核心技能之一。在工作和生活节奏不断加快的背景下，如何高效利用有限的时间，已经成为影响个人发展和生活质量的关键因素。首先，明确目标是有效时间管理的前提。没有清晰的目标，时间的投入就会变得盲目而低效。建议采用SMART原则设定目标，即目标应当具体、可衡量、可实现、相关性强并有明确的期限。其次，合理的计划与优先级排序至关重要。经典的四象限法则将事务按照重要性和紧急程度划分为四类，提醒我们优先处理重要而不紧急的事情，避免长期陷入救火式的被动局面。第三，专注力是时间效率的放大器。研究表明，频繁的任务切换会显著降低工作质量，因此建议采用番茄工作法等方法，在工作时段内屏蔽干扰源，保持深度专注。第四，复盘与调整不可或缺。每天结束时回顾时间的实际去向，分析计划与执行之间的偏差，才能持续优化自己的时间分配模式。此外，休息与恢复同样是时间管理的一部分，适当的运动、冥想和社交活动能够帮助大脑维持良好的状态，从而在长期维度上提升整体效率。总而言之，时间管理的本质不是把每一分钟都填满，而是把有限的时间投入到真正重要的事情上，通过持续的规划、执行与反思，实现个人价值与生活幸福的双重提升。`,
  },
];

/* ---------------- 推理部分（与 ppl-worker.ts 的 scoreWindow 同构） ---------------- */

interface TokenizeResult {
  input_ids: unknown;
}
type TokenizerLike = (s: string, o: Record<string, unknown>) => Promise<TokenizeResult>;

function toList(x: unknown): number[] | null {
  if (x == null) return null;
  const obj = x as { tolist?: () => unknown[]; data?: ArrayLike<number> };
  if (typeof obj.tolist === "function") {
    const v = obj.tolist();
    return Array.isArray(v)
      ? (v.flat(Number.POSITIVE_INFINITY) as unknown[]).map(Number)
      : null;
  }
  if (obj.data != null) return Array.from(obj.data, (n) => Number(n));
  return Array.isArray(x)
    ? ((x as unknown[]).flat(Number.POSITIVE_INFINITY) as unknown[]).map(Number)
    : null;
}

async function scoreWindow(
  model: { (input: unknown): Promise<unknown> },
  tokenize: TokenizerLike,
  maskId: number,
  chars: string[],
): Promise<PplWindow | null> {
  const encoded = await tokenize(chars.join(""), { add_special_tokens: true });
  const ids = toList(encoded.input_ids);
  if (!ids || ids.length === 0) throw new Error("tokenizer 输出异常");
  const targets = selectTargets(ids);
  if (targets.length === 0) return null;
  // 分组掩码（与 scorer-core.ts / 引擎一致）：组内掩、组外保留原文
  const t = await import("@huggingface/transformers");
  const TensorCtor = t.Tensor;
  let sumNll = 0;
  for (const g of maskGroups(targets, MASK_GROUPS)) {
    const masked = ids.slice();
    for (const tg of g) masked[tg.pos] = maskId;
    const seqLen = masked.length;
    const inputTensor = new TensorCtor(
      "int64",
      BigInt64Array.from(masked.map((v) => BigInt(v))),
      [1, seqLen],
    );
    const attnTensor = new TensorCtor(
      "int64",
      BigInt64Array.from({ length: seqLen }, () => 1n),
      [1, seqLen],
    );
    const typeTensor = new TensorCtor(
      "int64",
      BigInt64Array.from({ length: seqLen }, () => 0n),
      [1, seqLen],
    );
    const output = (await model({
      input_ids: inputTensor,
      attention_mask: attnTensor,
      token_type_ids: typeTensor,
    })) as unknown as {
      logits: { dims: number[]; data: ArrayLike<number> };
    };
    const lg = output.logits;
    if (!lg || !lg.dims || lg.data == null) throw new Error("模型输出缺少 logits");
    const vocab = Number(lg.dims[lg.dims.length - 1]);
    // 内核 maskedMeanNll 返回的是"组内均值"；乘回组大小还原为该组贡献的总 NLL，
    // 外层再除以 targets.length 即得按目标数严格加权的全局均值。
    sumNll += maskedMeanNll(lg.data, lg.dims[1], vocab, g) * g.length;
  }
  return {
    charStart: 0,
    charEnd: 0,
    scoredCount: targets.length,
    meanNll: sumNll / targets.length,
  };
}

async function scoreText(
  model: { (input: unknown): Promise<unknown> },
  tokenize: TokenizerLike,
  maskId: number,
  text: string,
) {
  const chars: string[] = [];
  const offsets: Array<[number, number]> = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    chars.push(text[i]);
    offsets.push([i, i + 1]);
  }
  const wins: Array<{ chars: string[] }> = [];
  let start = 0;
  while (start < chars.length) {
    const end = Math.min(start + 384, chars.length);
    wins.push({ chars: chars.slice(start, end) });
    if (end >= chars.length) break;
    start += 320;
  }
  const windows: PplWindow[] = [];
  for (const w of wins) {
    const r = await scoreWindow(model, tokenize, maskId, w.chars);
    if (r) windows.push(r);
  }
  return aggregateText(windows);
}

/* ---------------- 主流程 ---------------- */

interface Row {
  label: string;
  chars: number;
  meanNll: number;
  ppl: number;
  winStd: number;
  windows: number;
}

function summarize(name: string, rows: Row[]) {
  const meanNlls = rows.map((r) => r.meanNll);
  const stds = rows.map((r) => r.winStd);
  const min = Math.min(...meanNlls);
  const max = Math.max(...meanNlls);
  const avg = meanNlls.reduce((a, b) => a + b, 0) / rows.length;
  console.log(`\n【${name}】共 ${rows.length} 篇`);
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(10, "　")} 字数=${String(r.chars).padStart(4)}  窗数=${r.windows}  ` +
        `meanNll=${r.meanNll.toFixed(3)} nat  PPL=${r.ppl.toFixed(1)}  窗间σ=${r.winStd.toFixed(3)}`,
    );
  }
  console.log(
    `  ↳ meanNll 分布 min=${min.toFixed(3)} avg=${avg.toFixed(3)} max=${max.toFixed(3)}；窗间σ max=${Math.max(...stds).toFixed(3)}`,
  );
  return { min, max, avg };
}

async function main() {
  const t = await import("@huggingface/transformers");
  t.env.remoteHost = "https://hf-mirror.com";
  t.env.allowLocalModels = true;
  console.log("加载模型 Xenova/bert-base-chinese（int8）…首次运行会下载约 100MB");
  const common = {
    dtype: "q8" as const,
    progress_callback: (p: unknown) => {
      const o = p as { status?: string; file?: string; progress?: number };
      if (o?.status === "progress" && typeof o.progress === "number" && typeof document === "undefined") {
        process.stdout.write(`\r  下载 ${o.file ?? ""} ${o.progress.toFixed(0)}%        `);
      }
    },
  };
  const model = await t.AutoModel.from_pretrained("Xenova/bert-base-chinese", common);
  const tokenizer = await t.AutoTokenizer.from_pretrained("Xenova/bert-base-chinese", common);
  if (!model || !tokenizer) throw new Error("模型或分词器加载失败");
  console.log("\n模型就绪，开始逐篇打分…\n");

  const maskId = (tokenizer as unknown as { mask_token_id: number }).mask_token_id;
  const tokenize = tokenizer as unknown as TokenizerLike;
  const callModel = (input: unknown) => model(input);

  const humanRows: Row[] = [];
  const aiRows: Row[] = [];
  for (const [group, list, sink] of [
    ["人工写作组", HUMAN, humanRows],
    ["AI 生成组", AI, aiRows],
  ] as const) {
    for (const item of list) {
      const f = await scoreText(callModel, tokenize, maskId, item.text);
      sink.push({
        label: item.label,
        chars: f.scoredChars,
        meanNll: f.meanNll,
        ppl: nllToPerplexity(f.meanNll),
        winStd: f.winStd,
        windows: f.windows.length,
      });
      void group;
    }
  }

  const h = summarize("人工写作组", humanRows);
  const a = summarize("AI 生成组", aiRows);

  console.log("\n=== 阈值复核（当前常量）===");
  console.log(`PPL_MIN_MEAN_NLL = ${PPL_MIN_MEAN_NLL} nat`);
  console.log(`PPL_MAX_WIN_STD  = ${PPL_MAX_WIN_STD}`);
  console.log(`PPL_MIN_CHARS    = ${PPL_MIN_CHARS}`);
  console.log(`PPL_MIN_WINDOWS  = ${PPL_MIN_WINDOWS}`);

  console.log("\n=== 建议通道 ===");
  const gapLow = Math.max(h.min, a.min);
  const gapHigh = Math.min(h.max, a.max);
  if (a.max < h.min) {
    const mid = (a.max + h.min) / 2;
    console.log(`两组完全线性可分：AI 组 max(${a.max.toFixed(3)}) < 人工组 min(${h.min.toFixed(3)})`);
    console.log(`建议 PPL_MIN_MEAN_NLL 取区间中点 ≈ ${mid.toFixed(2)} nat`);
  } else if (gapHigh > gapLow) {
    console.log(
      `两组存在重叠区 [${gapLow.toFixed(2)}, ${gapHigh.toFixed(2)}]，均值阈值取重叠区内并接受少量误报`,
    );
  } else {
    console.log(`两组分布交叉严重，均值通道只能作为弱信号（当前 ${PPL_MIN_MEAN_NLL} nat 是否合适需人工判断）`);
  }
  console.log(
    `窗间σ通道：AI 组 max=${Math.max(...aiRows.map((r) => r.winStd)).toFixed(3)}，人工组 max=${Math.max(...humanRows.map((r) => r.winStd)).toFixed(3)}（样本量小，仅作参考）`,
  );
}

main().catch((e: unknown) => {
  console.error("\n标定失败：", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
