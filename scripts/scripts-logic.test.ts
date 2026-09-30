/**
 * scripts 渐进测试（P3 收尾）：humanize-cli 纯逻辑 + check-vocab-hygiene 词表卫生。
 * CLI 的 parseArgs/collectTxtFiles 不依赖终端 I/O，直接导入测试；
 * 词表卫生用断言固化（原脚本以 exit code 表达，这里改成可读断言）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import vm from "vm";
import { VOCAB } from "../src/engine/humanize-vocab";
import { FORMULAIC_EXTRA } from "../src/engine/humanize-vocab-extra";
import { GUARD_AFTER, VERB_PHRASE_AFTER } from "../src/engine/humanize-guard";

/* ---------------- 词表卫生（check-vocab-hygiene.ts 的核心规则固化） ---------------- */

describe("词表卫生（check-vocab-hygiene 规则固化）", () => {
  // 与 check-vocab-hygiene.ts 保持一致的黑名单（KILLER_INTRO + OFFICIALESE + FORMULAIC_EXTRA）
  const KILLER_INTRO = [
    "值得注意的是", "值得一提的是", "毋庸置疑", "毋庸讳言", "不可否认", "众所周知",
    "归根结底", "归根到底", "综上所述", "总而言之", "总的说来", "总的来说",
    "简而言之", "一言以蔽之", "由此可见",
  ];
  const OFFICIALESE = [
    "总体设计", "按图推进", "长期坚持", "夯实根基", "守牢防线", "加深优势", "盘活资产",
    "填平缺口", "拉长长板", "做亮招牌", "排忧解难", "拓宽路子", "架起平台", "顶层规划", "凑成共识",
  ];
  const FORBIDDEN = new Set([...KILLER_INTRO, ...OFFICIALESE, ...FORMULAIC_EXTRA]);

  it("VOCAB 所有替身不得落入高危套话/官方腔黑名单（自 defeats 防复发守卫）", () => {
    const offenders: string[] = [];
    for (const [from, tos] of Object.entries(VOCAB)) {
      for (const to of tos) {
        if (FORBIDDEN.has(to)) offenders.push(`${from} → "${to}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("黑名单本身非空（防止守卫被悄悄清空）", () => {
    expect(FORBIDDEN.size).toBeGreaterThanOrEqual(25);
  });
});

/* ---------------- 搭配卫生（2026-09-30 新增，防 A/B 类病句复发） ---------------- */

describe("搭配卫生（单音节/动补式替身必须带守卫或豁免）", () => {
  /**
   * 缘起：docs/2026-09-30-sentence-defects-report.md —— 词表按词替换、不看搭配，
   * 于是产出「坚持下去→守住下去」「通过引入→借引入」。更糟的是**同类处置会回退**：
   * 2026-08-17 已裁定移除的「保障→守住」后来又出现在词表里。
   *
   * 本测试把"危险替身必须显式声明"钉在单测层——新增危险替身时在 vitest 就红，
   * 不必等到 scan-bugs（那要跑 700+ 次 humanize 才发现）。
   *
   * 判据：替身是单音节动词（搭配能力窄）或 X住/X好 式动补（只能带体词宾语）时，
   * 必须在 GUARD_AFTER 里有守卫、或在豁免清单里并写明理由。
   */
  const COMPLEMENT_RE = /(?:守住|保住|护住|管好|盯住|接住|顶住|对上|贴上|就着)/;
  const isSingleVerb = (w: string) => /^[\u4e00-\u9fa5]$/.test(w);

  /** 豁免清单：名称 → 理由（有理由才准豁免，防止拿豁免当万能挡箭牌） */
  const EXEMPT: Record<string, string> = {
    而且: "连词互替，不影响搭配",
    然而: "连词互替",
    务必: "助动词，等价替换",
    愈发: "副词替换",
    切实: "副词作状语",
    尽量: "副词",
    诸如: "列举引导词",
    坐落于: "处所介词，后接体词",
    力图: "「力图改变/突破」动词短语宾语兼容",
    旨在: "同力图",
    利用: "同为动词，搭配能力相当",
    契合: "作谓语，无补语用法",
    切忌: "祈使语境，等价",
    实施: "已收窄为 ['执行']（2026-09-30）——「干」语体错位、「做起来」不及物；勿回退",
    全面: "弱替身，仅作定语/状语",
    征程: "名词替换",
    促使: "兼语句里通顺，无补语用法",
    打造: "已有 GUARD_AFTER 覆盖术语残缺场景",
    促进: "「促进发展」可通",
    取得: "低危，已由 scan-bugs 金丝雀覆盖",
    针对: "已有 GUARD_AFTER「性」",
    应对: "低危",
    满足: "低危",
    拉齐: "低危",
    对齐: "低危",
    聚焦于: "低危",
    维护: "整条移除（2026-09-30）——在 SCORING_EXCLUDE 内零收益，且动名双词性需额外守卫，净负收益",
    保障: "整条移除（2026-08-17 裁定 + 2026-09-30 纠正回退）",
    驱动: "已移除「拉着」，余项低危",
    牵引: "同驱动",
    借助于: "「借助于X」X 为体词，替身后仍通",
    取得成效: "低危",
  };

  it("单音节/动补式替身必须在 GUARD_AFTER 内或豁免清单内（且有理由）", () => {
    const offenders: string[] = [];
    for (const [from, tos] of Object.entries(VOCAB)) {
      if (!Array.isArray(tos)) continue;
      for (const to of tos) {
        const dangerous = isSingleVerb(to) || COMPLEMENT_RE.test(to);
        if (!dangerous) continue;
        const guarded = (GUARD_AFTER[from]?.length ?? 0) > 0;
        const exempt = Object.prototype.hasOwnProperty.call(EXEMPT, from);
        if (!guarded && !exempt) offenders.push(`${from} → "${to}"`);
        if (exempt && !EXEMPT[from]?.trim()) offenders.push(`${from}：豁免理由为空`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("豁免清单条目不得为空（防止空理由占位）", () => {
    const empty = Object.entries(EXEMPT).filter(([, why]) => !why.trim());
    expect(empty).toEqual([]);
    expect(Object.keys(EXEMPT).length).toBeGreaterThanOrEqual(20);
  });

  it("已裁定移除/收窄的替身不得复活（回归闸门）", () => {
    // 依据：2026-08-17 裁定 + 2026-09-30 报告 §5.3 / §5.3.1
    const MUST_NOT_EXIST: [string, string][] = [
      ["坚持", "守住"], // 可带补语与动词性宾语，词表无法表达（2026-09-30 移除）
      ["保障", "守住"], // 名词位「提供保障」→ 动词病句（2026-08-17 已裁定）
      ["发挥", "起"], // 单字替身在名词位/被动位全崩（2026-08-17 已裁定）
      ["实施", "干"], // 语体错位："实施新规"→"干新规"（2026-09-30 收窄为 ["执行"]）
      ["实施", "做起来"], // 不及物："实施这项工作"→"做起来这项工作"不成话
      ["维护", "护住"], // 搭配别扭 + 该词有被剔除记录（看"保驾护航"条）
      ["维护", "管好"], // 接抽象宾语别扭："维护秩序"→"管好秩序"
      ["维护", "守住"], // 同上："维护系统"→"守住系统"
    ];
    const alive = MUST_NOT_EXIST.filter(([k, v]) => VOCAB[k]?.includes(v)).map(([k, v]) => `${k}→${v}`);
    expect(alive).toEqual([]);
  });

  it("实施/维护/保障 的替身只保留裁定后的那一个（2026-09-30 裁定，勿回退）", () => {
    // 这条是 MUST_NOT_EXIST 的正面镜像：上面只能断言"不许有谁"，
    // 漏掉"不许只剩谁 / 不许又多出别的"这类缺口。
    expect(VOCAB["实施"]).toEqual(["执行"]);
    // 「维护」整条移除（2026-09-30 按纯收益判断）：SCORING_EXCLUDE 内零收益，
    // 且动名双词性需额外守卫，净负收益。见报告 §5.3.1 ⑩。
    expect(VOCAB["维护"]).toBeUndefined();
  });

  it("「通过+动词短语」守卫存在且为紧邻判据（A/B 类根因守卫）", () => {
    // 实现说明：这条不能放 GUARD_AFTER（那里是 8 字窗口「包含」判据，
    // 拦动词短语会过度拦截：实测「通过三条路径实现了目标」被误判），
    // 故由 humanize-guard.ts 的 VERB_PHRASE_AFTER 按词定制、紧邻匹配。
    for (const w of ["引入", "采用", "实现", "推动", "提升"]) {
      expect(VERB_PHRASE_AFTER.test(w), `「通过${w}」若未被守卫会崩成「借${w}」`).toBe(true);
    }
    // 紧邻语义：动词短语前若已有别的字，不算紧邻（"通过引入的方式"不该被拦）
    expect(VERB_PHRASE_AFTER.test("的方式引入")).toBe(false);
    // 反向：守卫词不得出现在 GUARD_AFTER.通过 里（那会退回 8 字窗口误拦）
    expect(GUARD_AFTER["通过"] ?? []).not.toContain("引入");
  });
});

/* ---------------- humanize-cli 纯逻辑 ---------------- */

// humanize-cli.ts 顶层会执行 main()（依赖 argv），vitest 导入会触发 process.exit。
// 因此不直接 import：用 esbuild 把纯函数段落（parseArgs/collectTxtFiles）转译成 JS 后在沙箱执行，
// 渐进测试不改动 CLI 行为。
import { readFileSync } from "fs";
import { transformSync } from "esbuild";

/** parseArgs 的返回形状（只列断言用到的字段，够用即可） */
interface CliArgs {
  input: string;
  out: string;
  intensity: number;
  zhuque: boolean;
  style: string;
  suffix: string;
  seed: number;
  api: boolean;
  model: string;
  judgeModel: string;
  deep: boolean;
  contest: number;
  outFormat: string;
}

function loadCliFns(): {
  parseArgs: (argv: string[]) => CliArgs;
    collectInputFiles: (input: string) => string[];
    baseUrlHasProxyPrefix: (baseUrl: string) => boolean;
  } {
  const src = readFileSync(path.resolve(__dirname, "humanize-cli.ts"), "utf-8");
  // 只保留纯函数段：USAGE + parseArgs + buildApiConfig + collectTxtFiles
  // （main 依赖终端 I/O，interface 是 TS 类型）
  //
  // 起点必须包含 USAGE：v0.9.15 起 parseArgs 引用了这个模块级常量，只从
  // "function parseArgs" 切会让它在沙箱里变成未定义标识符。
  const start = src.indexOf("const USAGE");
  // 终点按正则匹配「行首的 async function main / function main」：
  // 直接 indexOf("function main") 会把 `async` 留在切片尾部，转译后成为裸标识符
  // → ReferenceError: async is not defined（v0.9.15 把 main 改成 async 时踩到）。
  const m = /(?:async\s+)?function main/.exec(src);
  const end = m ? m.index : src.length;
  const body = src.slice(start, end).replace(/^import .*$/gm, "");
  const js = transformSync(body, { loader: "ts", format: "cjs" }).code;
  const sandbox: { fs: typeof fs; path: typeof path; module: { exports: Record<string, unknown> } } = {
    fs,
    path,
    module: { exports: {} },
  };
  vm.runInNewContext(
    `${js}\n;module.exports = { parseArgs, collectInputFiles, baseUrlHasProxyPrefix };`,
    sandbox,
  );
  return sandbox.module.exports as {
    parseArgs: never;
    collectInputFiles: never;
    baseUrlHasProxyPrefix: never;
  };
}

const { parseArgs, collectInputFiles, baseUrlHasProxyPrefix } = loadCliFns();

describe("humanize-cli parseArgs", () => {
  const base = (argv: string[]) => ["node", "humanize-cli.ts", ...argv];

  it("最简参数：只给输入路径，其余默认值正确", () => {
    const a = parseArgs(base(["./docs"]));
    expect(a.input).toBe("./docs");
    expect(a.out).toBe("./docs");
    expect(a.intensity).toBe(0.9);
    expect(a.zhuque).toBe(false);
    expect(a.style).toBe("casual");
    expect(a.suffix).toBe(".humanized");
  });

  it(".txt 输入时 out 默认为其所在目录", () => {
    const a = parseArgs(base(["./docs/a.txt"]));
    expect(a.out).toBe("./docs");
  });

  it("全量参数解析：out/intensity/zhuque/style/suffix", () => {
    const a = parseArgs(base(["./in", "--out", "./out", "--intensity", "0.7", "--zhuque", "--style", "academic", "--suffix", ".h"]));
    expect(a.out).toBe("./out");
    expect(a.intensity).toBe(0.7);
    expect(a.zhuque).toBe(true);
    expect(a.style).toBe("academic");
    expect(a.suffix).toBe(".h");
  });

  it("强度越界夹取 0~1", () => {
    expect(parseArgs(base(["./in", "--intensity", "5"])).intensity).toBe(1);
    expect(parseArgs(base(["./in", "--intensity", "-1"])).intensity).toBe(0);
  });

  // v0.9.15：seed 此前硬编码 20260905 不可改，批量结果无法与 UI 对齐复现
  it("--seed 可指定，默认仍是 20260905（向后兼容）", () => {
    expect(parseArgs(base(["./in"])).seed).toBe(20260905);
    expect(parseArgs(base(["./in", "--seed", "42"])).seed).toBe(42);
  });

  // v0.9.15：LLM 通道接线
  it("--api 系列参数解析（默认关闭深度、单候选）", () => {
    const a = parseArgs(base(["./in"]));
    expect(a.api).toBe(false);
    expect(a.deep).toBe(true);
    expect(a.contest).toBe(1);
    const b = parseArgs(
      base(["./in", "--api", "--model", "m1", "--judge-model", "j1", "--no-deep", "--contest", "3"]),
    );
    expect(b.api).toBe(true);
    expect(b.model).toBe("m1");
    expect(b.judgeModel).toBe("j1");
    expect(b.deep).toBe(false);
    expect(b.contest).toBe(3);
  });

  it("--out-format：默认 follow；显式 txt / docx 原样收下", () => {
    expect(parseArgs(base(["./in"])).outFormat).toBe("follow");
    expect(parseArgs(base(["./in", "--out-format", "docx"])).outFormat).toBe("docx");
    expect(parseArgs(base(["./in", "--out-format", "TXT"])).outFormat).toBe("txt");
  });
});

describe("humanize-cli collectInputFiles", () => {
  let tmpDir = "";
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quaiwei-cli-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("单文件输入直接返回该文件", () => {
    const f = path.join(tmpDir, "a.txt");
    fs.writeFileSync(f, "内容");
    expect(collectInputFiles(f)).toEqual([f]);
  });

  it("单文件但扩展名不支持 → 不收（交给上层报「未找到可处理的文件」）", () => {
    const f = path.join(tmpDir, "a.pdf");
    fs.writeFileSync(f, "%PDF-1.7");
    expect(collectInputFiles(f)).toEqual([]);
  });

  it("目录输入：收 .txt/.md/.docx（大小写不敏感），按名称排序，忽略子目录与不支持的扩展名", () => {
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    fs.writeFileSync(path.join(tmpDir, "a.TXT"), "a");
    fs.writeFileSync(path.join(tmpDir, "c.md"), "c");
    fs.writeFileSync(path.join(tmpDir, "d.DOCX"), "d");
    fs.writeFileSync(path.join(tmpDir, "e.pdf"), "不支持");
    fs.mkdirSync(path.join(tmpDir, "sub"));
    fs.writeFileSync(path.join(tmpDir, "sub", "f.txt"), "子目录不算");
    expect(collectInputFiles(tmpDir)).toEqual([
      path.join(tmpDir, "a.TXT"),
      path.join(tmpDir, "b.txt"),
      path.join(tmpDir, "c.md"),
      path.join(tmpDir, "d.DOCX"),
    ]);
  });
});

describe("humanize-cli baseUrlHasProxyPrefix", () => {
  it("UI 同源代理写法抄给 CLI（绝对地址含 /sensenova 路径段）判命中", () => {
    expect(baseUrlHasProxyPrefix("https://token.sensenova.cn/sensenova/v1")).toBe(true);
    expect(baseUrlHasProxyPrefix("http://localhost:3000/sensenova/v1")).toBe(true);
    expect(baseUrlHasProxyPrefix("https://gw.example.com/sensenova/v1/")).toBe(true);
  });

  it("正确直连地址与 host 含 sensenova 的域名不误伤", () => {
    // host 里的 sensenova 前缀是点不是斜杠，不在路径上
    expect(baseUrlHasProxyPrefix("https://token.sensenova.cn/v1")).toBe(false);
    expect(baseUrlHasProxyPrefix("https://api.openai.com/v1")).toBe(false);
    expect(baseUrlHasProxyPrefix("")).toBe(false);
  });

  it("相对路径不越权判定（由 main 里另一条同源相对路径拦截负责）", () => {
    expect(baseUrlHasProxyPrefix("/sensenova/v1")).toBe(false);
    expect(baseUrlHasProxyPrefix("token.sensenova.cn/v1")).toBe(false);
  });
});
