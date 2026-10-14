/**
 * human-corpus/rebuild-manifest.ts —— 从磁盘上的 *.txt 重建 manifest.json
 *
 * 用法：npx tsx artifacts/human-corpus/rebuild-manifest.ts
 *
 * ## 为什么需要
 *
 * 2026-10-14 首跑时有两个版本的抓取器并行（一个被 stop 的旧版 + 一个新版），
 * 旧版用 Windows 内置 curl 超时率极高但仍写盘了部分文件，最后**覆盖了 manifest**
 * （20 条 → 18 条，而磁盘上实际有 21 个文件）。
 * ⇒ manifest 是**派生产物**，任何时候都该能从磁盘重建，不能只信它。
 *
 * 正文文件自带来源信息（标题/URL/许可/抓取日期），文件名带体裁，重建不依赖网络。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const DIR = "artifacts/human-corpus";
const files = readdirSync(DIR).filter((f) => f.endsWith(".txt"));

const items = [];
for (const f of files) {
  const raw = readFileSync(`${DIR}/${f}`, "utf8");
  const head = raw.split("\n\n")[0];
  const url = head.match(/【URL】(.*)/)?.[1]?.trim() ?? "";
  const license = head.match(/【许可】(.*)/)?.[1]?.trim() ?? "CC BY-SA 4.0";
  const fetchedAt = head.match(/【抓取】(.*)/)?.[1]?.trim() ?? "";
  const prose = raw.split("\n\n").slice(1).join("\n\n");
  // 文件名格式：<体裁>-<条目>.txt；条目本身可能含连字符，从头部「来源」行取更准
  const title =
    head.match(/「(.+?)」条目/)?.[1] ??
    f
      .replace(/\.txt$/, "")
      .split("-")
      .pop()!;
  const genre =
    f
      .replace(/\.txt$/, "")
      .slice(0, Math.max(0, f.replace(/\.txt$/, "").length - title.length - 1)) || "未分类";
  items.push({ genre, title, url, file: `${DIR}/${f}`, chars: prose.length, license, fetchedAt });
}

items.sort((a, b) => a.genre.localeCompare(b.genre, "zh") || a.title.localeCompare(b.title, "zh"));

writeFileSync(
  `${DIR}/manifest.json`,
  JSON.stringify(
    {
      source: "中文维基百科（MediaWiki REST API via api.wikimedia.org）",
      license: "CC BY-SA 4.0",
      attribution:
        "本目录文本均来自中文维基百科条目，按 CC BY-SA 4.0 要求署名词条标题与 URL（见 manifest）",
      caveat: "百科体为规范化语体，代表「真人撰写的说明文」，不代表日常口语",
      rebuiltAt: new Date().toISOString(),
      items,
    },
    null,
    2,
  ),
);
console.log(`重建 manifest：${items.length} 条（磁盘 ${files.length} 个文件）`);
console.log(`总字数 ${items.reduce((a, b) => a + b.chars, 0)}`);
const short = items.filter((i) => i.chars < 300);
if (short.length)
  console.log(
    `⚠️ 正文过短（<300 字）${short.length} 条：${short.map((s) => `${s.title}(${s.chars})`).join("、")}`,
  );
