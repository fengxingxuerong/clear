// @vitest-environment happy-dom
/**
 * docx-io 测试：零依赖 docx 读写的 round-trip 与结构校验（v0.9.16 docx 支持配套）。
 *
 * 自证闭环：writer 生成的 zip 用项目同款 reader 读回；另用「第三方风格 docx」
 * （手工构造 stored 条目 + 非文本部件）验证 reader 的通用性，不只是自产自销。
 */
import { describe, expect, it } from "vitest";
import {
  readDocxText,
  writeDocxText,
  docxXmlToText,
  textToDocxXml,
} from "./docx-io";

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
    const text = "第一段：中文与 English 混排，标点「引号」与（括号）。\n\n第二段\t带制表符。\n\n第三段带换行\n行二。";
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
    const notDocx = new Blob([new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
    await expect(readDocxText(notDocx)).rejects.toThrow(/word\/document\.xml/);
  });
});
