/**
 * human-corpus/fetch-wiki.ts —— 从中文维基百科抓「真人撰写」语料（CC BY-SA 4.0）
 *
 * 用法：npx tsx artifacts/human-corpus/fetch-wiki.ts
 *
 * ## 为什么需要它
 *
 * 2026-10-14 的变异器实验最大的坑：**项目内只有 1 段真正的人写文本（381 字）**，
 * 其余标为「原文」的样本审计后发现**本身就是 AI 腔**（`mutator/_audit-baseline.ts`）。
 * 一个数据点撑不起任何指标结论 ⇒ 必须外部补真人语料。
 *
 * ## 为什么选中文维基百科
 *
 * · `api.wikimedia.org` 在本机可达（`zh.wikipedia.org` 域名被墙，但 API 域名通）
 * · 返回体自带 `license: CC BY-SA 4.0`——**可商用、只需署名**，署名信息写进 manifest
 * · 编辑协作撰写，**非 AI 生成**
 * · 体裁覆盖广（人物/地理/科技/历史/文学/生物/医学/法律/艺术）
 *
 * ⚠️ **已知局限（写下来免得将来被当成"真人味标杆"）**：维基百科是**规范化百科体**，
 * 开头句多为"……是……的……"定义式，与日常口语差别不小。
 * 它代表的是「真人写的**百科说明文**」，不是「随手写的口语」。
 * 需要口语化样本时应另配现代口语语料（萌娘百科 / 用户自己的历史文章）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { runAsync } from "../../scripts/run-async.ts";

const UA = "QuAiWei-eval/0.9 (local research; one-off corpus fetch)";
const API = "https://api.wikimedia.org/core/v1/wikipedia/zh/page";

/**
 * ⚠️ **必须用 curl 子进程，不能用 fetch**（2026-10-14 实测）：
 * ① 本机配了代理 `http://127.0.0.1:64146`，**curl 会读 HTTPS_PROXY，
 *    而 Node 内置 fetch（undici）默认不读代理环境变量** ⇒ 直连必然失败。
 * ② spawn("curl") 解析到的是 **Windows 内置 C:\Windows\System32\curl.exe**，
 *    它的 Schannel 栈在本环境下**走不通代理**（exit 28 超时）；
 *    Git 自带的 `C:\Program Files\Git\mingw64\bin\curl.exe` 才通（200）。
 * ⇒ 下面按顺序探测可用的 curl，第一个成功的缓存复用。
 */
const CURL_CANDIDATES = [
  "C:\\Program Files\\Git\\mingw64\\bin\\curl.exe",
  "C:\\Program Files\\Git\\usr\\bin\\curl.exe",
  "C:\\Users\\Admin（无密码）\\.workbuddy\\binaries\\PortableGit\\versions\\1.2.0\\mingw64\\bin\\curl.exe",
  "curl", // 兜底（PATH 里的 Git Bash curl）
];
let curlPath: string | null = null;

async function httpGet(url: string): Promise<{ ok: boolean; body: string }> {
  if (!curlPath) {
    for (const c of CURL_CANDIDATES) {
      const probe = await runAsync(c, ["-sS", "-m", "10", "-o", "NUL", "-w", "%{http_code}", url], {
        timeoutMs: 15_000,
      });
      if (probe.code === 0 && probe.stdout.trim().startsWith("2")) {
        curlPath = c;
        console.log(`\n[fetch] 可用 curl：${c}`);
        break;
      }
    }
    if (!curlPath) return { ok: false, body: "" };
  }
  const r = await runAsync(curlPath, ["-sS", "-m", "25", url], { timeoutMs: 30_000 });
  if (r.code !== 0 || !r.stdout.trim()) return { ok: false, body: "" };
  return { ok: true, body: r.stdout };
}

/** 按体裁取样（每个体裁 2~3 条，覆盖不同领域的写作习惯） */
const PAGES: [genre: string, title: string][] = [
  ["人物-现代作家", "鲁迅"],
  ["人物-现代作家", "老舍"],
  ["人物-科学家", "屠呦呦"],
  ["人物-科学家", "钱学森"],
  ["人物-历史", "诸葛亮"],
  ["地理-城市", "北京市"],
  ["地理-山川", "黄山"],
  ["地理-水体", "长江"],
  ["科技-物理", "量子力学"],
  ["科技-工程", "集成电路"],
  ["科技-通信", "5G"],
  ["历史-朝代", "明朝"],
  ["历史-贸易", "丝绸之路"],
  ["历史-文字", "甲骨文"],
  ["文学-古典", "红楼梦"],
  ["文学-现当代", "骆驼祥子"],
  ["生物-生命科学", "光合作用"],
  ["生物-演化", "进化论"],
  ["生物-细胞", "细胞"],
  ["医学-公共卫生", "疫苗"],
  ["医学-传统医学", "中医"],
  ["法律", "中华人民共和国民法典"],
  ["艺术-书法", "书法"],
  ["艺术-考古", "敦煌莫高窟"],
];

/** wikitext 清洗：去模板/表格/引用/注释，把 [[链接|文本]] 还原成文本 */
function cleanWikitext(s: string): string {
  let t = s;
  // 注释
  t = t.replace(/<!--[\s\S]*?-->/g, "");
  // ref 标签（含嵌套与自闭合）
  t = t.replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  // 模板 {{...}}（逐层剥，处理嵌套）
  for (let i = 0; i < 8 && t.includes("{{"); i++) {
    let depth = 0;
    let out = "";
    for (const ch of t) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      if (depth === 0) out += ch;
    }
    t = out;
  }
  // 表格
  t = t.replace(/\{\|[\s\S]*?\|\}/g, "");
  // 文件链接 [[文件:...]]｜图片
  t = t.replace(/\[\[(?:文件|File|檔案|图像):[^\]]*\]\]/gi, "");
  // 分类
  t = t.replace(/\[\[分类:[^\]]*\]\]/g, "");
  // 内部链接 [[A|B]] → B；[[A]] → A（带管道优先）
  t = t.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, "$1");
  // 外部链接 [文本 URL]
  t = t
    .replace(/\[(?:https?:|www\.)[^\s\]]*\s+([^\]]*)\]/gi, "$1")
    .replace(/\[(?:https?:|www\.)[^\s\]]*\]/gi, "");
  // 强调/小体
  t = t.replace(/'''?/g, "");
  // 列表/标题前缀
  t = t.replace(/^\s*[#*;:]+\s*/gm, "");
  // HTML 标签
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  // 残留的花括号
  t = t.replace(/[{}]/g, "");
  // 章节标题行（== xxx ==）直接删
  t = t.replace(/^\s*=+.*=+\s*$/gm, "");
  return t;
}

/** 段落清洗 + 质量过滤 */
function toProse(clean: string): string {
  const paras = clean
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 60 && p.length <= 1200)
    // 过滤掉残留标记过多的行（清洗不彻底的信号）
    .filter((p) => (p.match(/[<>=|{}[\]]/g) || []).length / p.length < 0.03)
    // 过滤掉以符号/标点开头的残句
    .filter((p) => /^[\u4e00-\u9fa5（(“"]/.test(p));
  return paras.join("\n\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OUT = "artifacts/human-corpus";
mkdirSync(OUT, { recursive: true });

interface ManifestItem {
  genre: string;
  title: string;
  url: string;
  file: string;
  chars: number;
  license: string;
  fetchedAt: string;
}

const manifest: ManifestItem[] = [];
let ok = 0;
let skipped = 0;

for (const [genre, title] of PAGES) {
  const url = `${API}/${encodeURIComponent(title)}`;
  process.stdout.write(`  ${title} … `);
  let j: { source?: string; license?: { url: string; title: string } } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await httpGet(url);
    if (!r.ok) {
      process.stdout.write(`curl(${r.code}) `);
      await sleep(1200 * (attempt + 1));
      continue;
    }
    try {
      j = JSON.parse(r.body) as typeof j;
      if (j?.source) break;
      process.stdout.write("no-source ");
    } catch {
      process.stdout.write("badJSON ");
    }
    await sleep(1000);
  }
  if (!j?.source) {
    process.stdout.write("❌ 跳过\n");
    skipped++;
    continue;
  }
  const prose = toProse(cleanWikitext(j.source));
  if (prose.length < 300) {
    process.stdout.write(`⚠️ 正文太短(${prose.length}) 跳过\n`);
    skipped++;
    continue;
  }
  const file = `${OUT}/${genre}-${title}.txt`;
  writeFileSync(
    file,
    `【来源】中文维基百科「${title}」条目正文\n【URL】https://zh.wikipedia.org/wiki/${encodeURIComponent(title)}\n` +
      `【许可】CC BY-SA 4.0（署名词条标题与 URL）\n【抓取】${new Date().toISOString().slice(0, 10)}\n\n${prose}\n`,
  );
  manifest.push({
    genre,
    title,
    url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    file,
    chars: prose.length,
    license: j.license?.title ?? "CC BY-SA 4.0",
    fetchedAt: new Date().toISOString().slice(0, 10),
  });
  ok++;
  process.stdout.write(`✅ ${prose.length} 字\n`);
  await sleep(700); // 尊重 API 限速
}

writeFileSync(
  `${OUT}/manifest.json`,
  JSON.stringify(
    {
      source: "中文维基百科（MediaWiki REST API via api.wikimedia.org）",
      license: "CC BY-SA 4.0",
      attribution:
        "本目录文本均来自中文维基百科条目，按 CC BY-SA 4.0 要求署名词条标题与 URL（见 manifest）",
      caveat: "百科体为规范化语体，代表「真人撰写的说明文」，不代表日常口语",
      fetchedAt: new Date().toISOString(),
      items: manifest,
    },
    null,
    2,
  ),
);
console.log(`\n抓取完成：${ok} 条成功 / ${skipped} 条跳过 → ${OUT}/manifest.json`);
console.log(`总字数 ${manifest.reduce((a, b) => a + b.chars, 0)}`);
