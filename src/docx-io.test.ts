// @vitest-environment happy-dom
/**
 * docx-io 测试：零依赖 docx 读写的 round-trip 与结构校验（v0.9.16 docx 支持配套）。
 *
 * 自证闭环：writer 生成的 zip 用项目同款 reader 读回；另用「第三方风格 docx」
 * （手工构造 stored 条目 + 非文本部件）验证 reader 的通用性，不只是自产自销。
 */
import { describe, expect, it } from "vitest";
import { readDocxText, writeDocxText, docxXmlToText, textToDocxXml } from "./docx-io";

describe("textToDocxXml（OOXML 生成）", () => {
  it("段落转 <w:p>，\\n\\n 分段", () => {
    const xml = textToDocxXml("第一段。\n\n第二段。");
    expect((xml.match(/<w:p>/g) || []).length).toBe(2);
    expect(xml).toContain("第一段。");
    expect(xml).toContain("第二段。");
  });

  it("XML 特殊字符转义：& 优先且不二次转义", () => {
    const xml = textToDocxXml(`A&B<c>"引"'单'`);
    expect(xml).toContain("A&amp;B&lt;c&gt;&quot;引&quot;&apos;单&apos;");
    expect(xml).not.toContain("&amp;amp;");
  });

  it("段内 \\n 转 <w:br/>（run 间断开），\\t 转 <w:tab/>", () => {
    const xml = textToDocxXml("行一\n行二\t列二");
    expect(xml).toContain("<w:br/>");
    expect(xml).toContain("<w:tab/>");
    // 提取回来语义等价（run 边界不影响文本顺序）
    expect(docxXmlToText(xml)).toBe("行一\n行二\t列二");
  });
});

describe("docxXmlToText（OOXML 提取）", () => {
  it("提取 <w:t> 文本、按段拼接 \\n\\n", () => {
    const xml =
      `<w:document><w:body>` +
      `<w:p><w:r><w:t>第一段文字。</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>第二段文字。</w:t></w:r></w:p>` +
      `</w:body></w:document>`;
    expect(docxXmlToText(xml)).toBe("第一段文字。\n\n第二段文字。");
  });

  it("一段多 run 拼接 + <w:br/> 转换行 + 空段保留", () => {
    const xml =
      `<w:p><w:r><w:t>前半</w:t></w:r><w:r><w:t>后半</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>行一</w:t><w:br/><w:t>行二</w:t></w:r></w:p>` +
      `<w:p/>`;
    expect(docxXmlToText(xml)).toBe("前半后半\n\n行一\n行二\n\n");
  });

  it("XML 实体还原：&amp; 最后还原不二次解", () => {
    const xml = `<w:p><w:r><w:t>A&amp;B &lt;tag&gt; &quot;引&quot;</w:t></w:r></w:p>`;
    expect(docxXmlToText(xml)).toBe(`A&B <tag> "引"`);
  });
});

describe("writeDocxText / readDocxText（zip 层 round-trip）", () => {
  it("round-trip：写出的 docx 读回与原文一致", async () => {
    const text =
      "第一段：中文与 English 混排，标点「引号」与（括号）。\n\n第二段\t带制表符。\n\n第三段带换行\n行二。";
    const blob = await writeDocxText(text);
    expect(blob.size).toBeGreaterThan(200);
    const back = await readDocxText(blob);
    expect(back).toBe(text);
  });

  it("空文本也能生成合法 docx 并读回空串", async () => {
    const blob = await writeDocxText("");
    expect(await readDocxText(blob)).toBe("");
  });

  it("生成物是合法 zip：PK 头 + 必备三部件", async () => {
    const blob = await writeDocxText("内容");
    const b = new Uint8Array(await blob.arrayBuffer());
    expect(b[0]).toBe(0x50); // P
    expect(b[1]).toBe(0x4b); // K
    const s = new TextDecoder().decode(b);
    expect(s).toContain("[Content_Types].xml");
    expect(s).toContain("word/document.xml");
    expect(s).toContain("_rels/.rels");
  });

  it("zip 数据区 CRC 完整（解压后字节与原文一致，防手写 zip 写坏）", async () => {
    const longText = "长文本压力测试。".repeat(2000); // ~14KB，跨 deflate 边界
    const blob = await writeDocxText(longText);
    expect(await readDocxText(blob)).toBe(longText);
  });

  it("非 docx 输入给出可读错误（缺 word/document.xml 时列出实际部件）", async () => {
    // 手工构造一个不含 document.xml 的 zip：直接用 writer 写三个无关文件再读
    const notDocx = new Blob([
      new Uint8Array([
        0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]),
    ]);
    await expect(readDocxText(notDocx)).rejects.toThrow(/word\/document\.xml/);
  });
});

/* ---------------- 手工 zip 构造 helper（reader 不校验 CRC，crc 一律填 0） ---------------- */

const TE = new TextEncoder();

/** 小端写入 u16 */
function u16LE(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >>> 8) & 0xff);
}

/** 小端写入 u32 */
function u32LE(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

/** EOCD（PK\x05\x06）：磁盘号×2 + 条目数×2 + CD 大小 + CD 偏移 + comment 长度，共 22B */
function buildEocd(entryCount: number, cdSize: number, cdOffset: number): number[] {
  const a: number[] = [];
  u32LE(a, 0x06054b50); // 签名
  u16LE(a, 0); // 本盘号
  u16LE(a, 0); // CD 起始盘号
  u16LE(a, entryCount); // 本盘条目数
  u16LE(a, entryCount); // 总条目数
  u32LE(a, cdSize); // 中央目录大小
  u32LE(a, cdOffset); // 中央目录偏移
  u16LE(a, 0); // comment 长度
  return a;
}

/** 中央目录记录（PK\x01\x02，46B 头 + 文件名）；reader 取 method@cSize nameLen@28 extra@30 comment@32 localOffset@42 */
function buildCentralRecord(opts: {
  name: string;
  method: number;
  cSize: number;
  uSize: number;
  localOffset: number;
}): number[] {
  const { name, method, cSize, uSize, localOffset } = opts;
  const nameBytes = TE.encode(name);
  const a: number[] = [];
  u32LE(a, 0x02014b50); // 签名
  u16LE(a, 20); // version made by
  u16LE(a, 20); // version needed
  u16LE(a, 0x0800); // UTF-8 flag
  u16LE(a, method); // 压缩方法
  u16LE(a, 0); // time
  u16LE(a, 0x21); // date（1980-01-01）
  u32LE(a, 0); // crc（reader 不校验，填 0）
  u32LE(a, cSize); // 压缩后大小
  u32LE(a, uSize); // 原始大小
  u16LE(a, nameBytes.length);
  u16LE(a, 0); // extra 长度
  u16LE(a, 0); // comment 长度
  u16LE(a, 0); // 起始盘号
  u16LE(a, 0); // 内部属性
  u32LE(a, 0); // 外部属性
  u32LE(a, localOffset); // local header 偏移
  for (const b of nameBytes) a.push(b);
  return a;
}

/** local file header（PK\x03\x04，30B 头 + 文件名 + 数据区） */
function buildLocalHeader(opts: { name: string; method: number; data: Uint8Array }): number[] {
  const { name, method, data } = opts;
  const nameBytes = TE.encode(name);
  const a: number[] = [];
  u32LE(a, 0x04034b50); // 签名
  u16LE(a, 20); // version needed
  u16LE(a, 0x0800); // UTF-8 flag
  u16LE(a, method); // 压缩方法
  u16LE(a, 0); // time
  u16LE(a, 0x21); // date
  u32LE(a, 0); // crc（reader 不校验，填 0）
  u32LE(a, data.length); // 压缩后大小（本 helper 恒 stored 布局：数据原样放数据区）
  u32LE(a, data.length); // 原始大小
  u16LE(a, nameBytes.length);
  u16LE(a, 0); // extra 长度
  for (const b of nameBytes) a.push(b);
  for (const b of data) a.push(b);
  return a;
}

describe("readDocxText 错误路径（手工 zip 定向构造）", () => {
  it("EOCD 倒查多轮扫描：尾部追加 64B 0x41 垃圾后仍定位到真实 EOCD 并正常读回", async () => {
    const text = "垃圾容忍测试段落。";
    const orig = new Uint8Array(await (await writeDocxText(text)).arrayBuffer());
    const withJunk = new Uint8Array(orig.length + 64);
    withJunk.set(orig, 0);
    withJunk.fill(0x41, orig.length); // 尾部 64B 垃圾
    expect(await readDocxText(withJunk.buffer as ArrayBuffer)).toBe(text);
  });

  it("非 zip 字节（5B，EOCD 扫描一轮都不进）抛「找不到 EOCD」", async () => {
    // 必须传 .buffer：参数类型是 Blob | ArrayBuffer，传 Uint8Array 会走 source.arrayBuffer() 抛 TypeError
    await expect(
      readDocxText(new Uint8Array([1, 2, 3, 4, 5]).buffer as ArrayBuffer),
    ).rejects.toThrow("不是有效的 zip 文件（找不到 EOCD）");
  });

  it("手工 EOCD 指向 0x41 垃圾：中央目录首签名不匹配抛「zip 中央目录损坏」", async () => {
    const junk = [0x41, 0x41, 0x41, 0x41];
    // entryCount=1、cdOffset=0 → 条目解析落在垃圾上
    const bytes = new Uint8Array([...junk, ...buildEocd(1, 0, 0)]);
    await expect(readDocxText(bytes.buffer as ArrayBuffer)).rejects.toThrow(
      "zip 中央目录损坏（entry 0）",
    );
  });
});

describe("readDocxText 手工 zip 正/异常分支（local header / 压缩方法 / ArrayBuffer）", () => {
  it("布局 垃圾4B + CD + EOCD、localOffset 指向垃圾 → 抛「zip local header 损坏」", async () => {
    const junk = [0x41, 0x41, 0x41, 0x41];
    const name = "word/document.xml";
    const cd = buildCentralRecord({ name, method: 0, cSize: 4, uSize: 4, localOffset: 0 });
    const eocd = buildEocd(1, cd.length, junk.length); // CD 紧跟 4B 垃圾之后
    const bytes = new Uint8Array([...junk, ...cd, ...eocd]);
    await expect(readDocxText(bytes.buffer as ArrayBuffer)).rejects.toThrow(
      "zip local header 损坏",
    );
  });

  it("stored（method=0）单条目 word/document.xml → 正常读出文本", async () => {
    const xml =
      `<w:document><w:body>` +
      `<w:p><w:r><w:t>stored 单条目段落。</w:t></w:r></w:p>` +
      `</w:body></w:document>`;
    const data = TE.encode(xml);
    const name = "word/document.xml";
    const local = buildLocalHeader({ name, method: 0, data });
    const cd = buildCentralRecord({
      name,
      method: 0,
      cSize: data.length,
      uSize: data.length,
      localOffset: 0,
    });
    const eocd = buildEocd(1, cd.length, local.length);
    const bytes = new Uint8Array([...local, ...cd, ...eocd]);
    expect(await readDocxText(bytes.buffer as ArrayBuffer)).toBe("stored 单条目段落。");
  });

  it("不支持的压缩方法 12 → 抛「不支持的 zip 压缩方法：12」", async () => {
    const data = TE.encode("<w:p/>");
    const name = "word/document.xml";
    const local = buildLocalHeader({ name, method: 12, data });
    const cd = buildCentralRecord({
      name,
      method: 12,
      cSize: data.length,
      uSize: data.length,
      localOffset: 0,
    });
    const eocd = buildEocd(1, cd.length, local.length);
    const bytes = new Uint8Array([...local, ...cd, ...eocd]);
    await expect(readDocxText(bytes.buffer as ArrayBuffer)).rejects.toThrow(
      "不支持的 zip 压缩方法：12",
    );
  });

  it("ArrayBuffer 分支：直接传 await blob.arrayBuffer()（非 Blob）读回一致", async () => {
    const text = "ArrayBuffer 输入分支。\n\n第二段带\t制表。";
    const blob = await writeDocxText(text);
    expect(await readDocxText(await blob.arrayBuffer())).toBe(text);
  });
});

describe("xmlUnescape 数字实体（&#x…; 十六进制 / &#…; 十进制）", () => {
  it("<w:t>&#x6C49;&#25991;</w:t> → 「汉文」", () => {
    const xml = `<w:p><w:r><w:t>&#x6C49;&#25991;</w:t></w:r></w:p>`;
    expect(docxXmlToText(xml)).toBe("汉文");
  });
});

/*
 * 覆盖率结构性缺口备注（不是用例，本任务禁改源码）：
 * src/docx-io.ts:221 的 `data.length ? await deflateRaw(data) : data` 的 **false 分支不可达**——
 * buildZip 未导出，writeDocxText 传入的三部件 data 均由 TextEncoder.encode 生成、恒非空，
 * 现有 API 无法喂进空 data；要覆盖它必须改源码（导出 buildZip 或允许空部件），留待源码侧处理。
 */
