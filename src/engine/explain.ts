/**
 * src/engine/explain.ts —— 「为什么这么改」：把一次改写翻译成人能读的裁决清单
 *
 * ## 为什么需要它
 *
 * v0.9.24 ⑨ 对标 `lynote/humanize-text`（公开每步中间产物）与 `baibanbao/qu-ai-wei`
 * （规则冲突逐条裁决并给出依据）后登记的缺口：本仓库一直在做后者，但**只写在源码注释里**，
 * 用户看不到。引擎只返回改写后的字符串（`humanize()` 的签名就是 `string`），
 * 于是"这段为什么被改"只能靠人猜。
 *
 * ## 做法：不改引擎，只做反查
 *
 * 拿原文与改后稿做**句级 diff**（复用 `diff.ts` 的 LCS），再对每个「删除↔新增」句对
 * 反查规则表，判定它属于哪一类改动、依据是哪张表。
 *
 * 这样做的好处：引擎零侵入、零漂移风险（不动任何 pass，不触发 aiScore 棘轮）。
 * 代价是**归因是事后反查，不是引擎自述** —— 所以每条都带 `certain` 字段，
 * 判不准的一律 `certain: false` 并归到 `structure` / `other`，**不瞎编依据**。
 *
 * ## 边界（必须说清）
 *
 * - 多处规则叠加在同一句上时，只报**第一个命中的类别**（按可信度从高到低试），
 *   不是"这句改了 5 处"。要逐处拆开得等引擎自己做 trace，那是另一个量级的改造。
 * - 结构性调整（切句、重排、整句重写）只能归到 `structure` —— 反查不出它是哪条 pass 干的。
 */
import { diffSentences } from "./diff";
import { VOCAB, VOCAB_ENTRIES, LEADING_CONNECTORS, FORMULAIC } from "./humanize-vocab";
import { MECH_CLICHE_REWRITE, PAD_WORDS } from "./humanize-text";

/** 改动类别。排序即"归因可信度从高到低"的尝试顺序。 */
export type ExplainKind =
  | "cliche" // 套话改写（有明确 rewrite 表）
  | "vocab" // 词表替换（有明确替身表）
  | "connector" // 段首/句首连接词删除
  | "pad" // 垫词删除
  | "formulaic" // 公式化表达清理
  | "trim" // 纯删除（无对应新增）
  | "inject" // 纯新增（口语化注入）
  | "structure" // 整句重写 / 结构调整 —— 反查不出是哪条 pass
  | "other"; // 判不出来

export interface ExplainItem {
  kind: ExplainKind;
  /** 原文片段（纯新增时为空串） */
  before: string;
  /** 改写后片段（纯删除时为空串） */
  after: string;
  /** 一句人话：为什么改 */
  reason: string;
  /** 依据出处（哪张表），要能指到文件，不许含糊其辞 */
  basis: string;
  /** true = 命中了明确规则表；false = 推断，判据只是"形态像" */
  certain: boolean;
}

/** 每类改动的人话解释 + 依据出处 */
const REASON: Record<ExplainKind, { reason: string; basis: string }> = {
  cliche: {
    reason: "这是公文/报道套话，AI 写得最多，换成大白话说法",
    basis: "humanize-text.ts 的 MECH_CLICHE_REWRITE（逐条写死的改写表）",
  },
  vocab: {
    reason: "这是 AI 高频词，换成人更常说的同义说法",
    basis: "humanize-vocab.ts 的 VOCAB（词 → 替身表）",
  },
  connector: {
    reason: "段首/句首的连接词删掉，开头不再像议论文",
    basis: "humanize-vocab.ts 的 LEADING_CONNECTORS",
  },
  pad: {
    reason: "这类口语垫词堆多了反而像机器，按次数限额收着用",
    basis: "humanize-text.ts 的 PAD_WORDS（全文级限额去重）",
  },
  formulaic: {
    reason: "公式化表达是检测器的重点特征，清掉",
    basis: "humanize-vocab.ts 的 FORMULAIC",
  },
  trim: {
    reason: "删掉冗余，句子更紧",
    basis: "由 diff 得出：原文有、改后稿没有，且未命中任何规则表（推断）",
  },
  inject: {
    reason: "加入口语化成分，打断机器那种均匀节奏",
    basis: "由 diff 得出：改后稿新增，且未命中任何规则表（推断）",
  },
  structure: {
    reason: "整句重写或结构调整（切句/重排）—— 具体是哪道流程做的，反查不出来",
    basis: "由 diff 得出：前后句都有实质变化但未命中规则表（推断）",
  },
  other: {
    reason: "改了，但判不出属于哪类",
    basis: "无 —— 宁可标不确定，也不编一条依据",
  },
};

/**
 * 在一个「删除句 ↔ 新增句」里找出**所有**规则命中。
 *
 * ⚠️ 第一版只取第一个命中就 `continue`，实测漏报严重：一句里同时换 3 个词时只报 1 条
 * （真实样本 6 处改动只归因出 3 处）。所以这里改成逐个挖：命中一次就把该片段从待查串里
 * 抠掉（换成占位符），再继续找，避免同一个词被重复命中、也避免长词被短词抢先。
 */
function matchAllInPair(
  del: string,
  ins: string,
): Array<{ kind: ExplainKind; before: string; after: string }> {
  const hits: Array<{ kind: ExplainKind; before: string; after: string }> = [];
  let restDel = del;
  let restIns = ins;
  /** 命中后把片段从双方串里抠掉（用不参与匹配的占位符），保证后续不重复计 */
  const carve = (d: string, i: string): void => {
    restDel = restDel.replace(d, "\u0000");
    restIns = restIns.replace(i, "\u0000");
  };

  // 套话**先于词表**匹配：它更长更具体（"具有十分重要的意义" vs 词表里可能的短词）。
  // ⚠️ 表**内部**再按长度降序属防御性写法：变异检验（改成升序）测试不变红，
  //   说明当前 cliche 表里没有相互包含的条目，这个排序暂时等价 —— 留着是防以后加了短条目被抢。
  const cliches = Object.entries(MECH_CLICHE_REWRITE).sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of cliches) {
    if (restDel.includes(from) && restIns.includes(to)) {
      hits.push({ kind: "cliche", before: from, after: to });
      carve(from, to);
    }
  }
  // VOCAB_ENTRIES 已按词长降序，长词先命中
  for (const [word, alts] of VOCAB_ENTRIES) {
    if (!restDel.includes(word)) continue;
    const hit = (alts ?? []).find((a) => a && restIns.includes(a));
    if (hit) {
      hits.push({ kind: "vocab", before: word, after: hit });
      carve(word, hit);
    }
  }
  return hits;
}

/** 删除类：原句命中了某张"该删"的表（返回被命中的词，没命中返回 null） */
function matchRemoval(del: string): { kind: ExplainKind; word: string } | null {
  for (const c of LEADING_CONNECTORS) {
    if (c && del.includes(c)) return { kind: "connector", word: c };
  }
  for (const p of PAD_WORDS) {
    if (p && del.includes(p)) return { kind: "pad", word: p };
  }
  for (const f of FORMULAIC) {
    // FORMULAIC 里混着正则与字面串，只按字面串比（正则没法反过来"包含"判定）
    if (typeof f === "string" && f && del.includes(f)) return { kind: "formulaic", word: f };
  }
  return null;
}

/**
 * 生成「为什么这么改」清单。
 *
 * @param before 原文
 * @param after  改写后文本
 * @returns 逐条裁决。清单为空 = 两稿一致（或短到没进引擎，见 humanize 的 <10 字短路）
 */
export function explainChanges(before: string, after: string): ExplainItem[] {
  if (!before || !after || before === after) return [];

  const { left, right } = diffSentences(before, after);
  // 按出现顺序把"删除段"与"新增段"两两配对；数量不等时多出来的单独成条
  const dels = left.filter((p) => p.type === "del").map((p) => p.text);
  const inss = right.filter((p) => p.type === "ins").map((p) => p.text);
  const pairs = Math.max(dels.length, inss.length);

  const out: ExplainItem[] = [];
  const push = (kind: ExplainKind, b: string, a: string): void => {
    const r = REASON[kind];
    out.push({
      kind,
      before: b,
      after: a,
      reason: r.reason,
      basis: r.basis,
      // 命中明确规则表的才敢标确定；trim / inject / structure / other 都是形态推断
      certain:
        kind === "cliche" ||
        kind === "vocab" ||
        kind === "connector" ||
        kind === "pad" ||
        kind === "formulaic",
    });
  };

  for (let i = 0; i < pairs; i++) {
    const del = dels[i] ?? "";
    const ins = inss[i] ?? "";

    if (del && ins) {
      const hits = matchAllInPair(del, ins);
      if (hits.length) {
        for (const h of hits) push(h.kind, h.before, h.after);
        continue;
      }
      const rm = matchRemoval(del);
      if (rm) {
        push(rm.kind, rm.word, "");
        continue;
      }
      push("structure", del, ins);
      continue;
    }
    if (del) {
      // 纯删除：先看是不是命中了"该删"的表，否则只敢说"删冗余"
      const rm = matchRemoval(del);
      push(rm ? rm.kind : "trim", rm ? rm.word : del, "");
      continue;
    }
    if (ins) {
      push("inject", "", ins);
    }
  }

  return out;
}

/**
 * 汇总：让用户一眼看到"主要动了哪几类"，而不是一条条翻。
 * 只统计 `certain` 的类别 —— 推断类不进汇总，免得把"猜的"说成"确实做了"。
 */
export function explainSummary(items: ExplainItem[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const it of items) {
    if (!it.certain) continue;
    acc[it.kind] = (acc[it.kind] ?? 0) + 1;
  }
  return acc;
}

/** 供 UI/CLI 直接渲染的一行文本（人读优先，不做结构化） */
export function formatExplain(items: ExplainItem[]): string {
  if (!items.length) return "（两稿一致，没有改动）";
  const lines = items.map((it) => {
    const arrow =
      it.before && it.after
        ? `${it.before} → ${it.after}`
        : it.before
          ? `删「${it.before}」`
          : `增「${it.after}」`;
    const flag = it.certain ? "" : "（推断）";
    return `· ${arrow}｜${it.reason}${flag}\n    依据：${it.basis}`;
  });
  const s = explainSummary(items);
  const keys = Object.keys(s);
  const head = keys.length
    ? `确定归因 ${items.filter((i) => i.certain).length} 处（${keys.map((k) => `${k}×${s[k]}`).join("、")}），推断 ${items.filter((i) => !i.certain).length} 处\n`
    : "";
  return head + lines.join("\n");
}

/** 反查单条：给 UI 做"点某处看依据"用（找不到返回 null，不编） */
export function lookupVocab(word: string): string[] | null {
  return VOCAB[word] ?? null;
}
