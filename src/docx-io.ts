/**
 * 趣AI味 · docx 导入导出（零依赖实现）
 *
 * 为什么不引 mammoth/jszip：只做「docx ↔ 纯文本」一件事，而现代运行时
 * （浏览器 Chrome 80+ / Node 18+）已内置 CompressionStream / DecompressionStream，
 * 配上 ~120 行手写 zip 读写器就够用——不为一个功能把 3MB 解析库拖进打包产物。
 *
 * 范围（诚实边界）：
 *  - 导入：提取 word/document.xml 的段落文本（<w:p>/<w:t>，<w:br/>→换行，表格单元格按段处理），
 *    不保留加粗/字号/图片等富文本格式——去味引擎只吃纯文本，格式本来就会丢。
 *  - 导出：生成最小合法 OOXML 文档（[Content_Types].xml + _rels/.rels + word/document.xml），
 *    Word / WPS / Google Docs 可打开；同样只有段落文本。
 */

/* ----------------------------- CRC32（zip 必需） ----------------------------- */

const CRC_TABLE = /* 预计算 0xEDB88320 查表 */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ----------------------------- 字节工具 ----------------------------- */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** 小端写入（Uint8Array 视图上的精确字节控制） */
function u16(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >>> 8) & 0xff);
}
function u32(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function u16At(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32At(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** deflate-raw 压缩（跳过 zlib/gzip 头尾，zip 直接吃裸 deflate 流） */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const blob = new Blob([data as BlobPart]);
  const buf = await new Response(blob.stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(buf);
}

/** deflate-raw 解压 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const blob = new Blob([data as BlobPart]);
  const buf = await new Response(blob.stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

/* ----------------------------- zip 读 ----------------------------- */

interface ZipEntry {
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** 解析 zip 中央目录：返回 文件名 → 条目信息 */
function readZipDirectory(b: Uint8Array): Map<string, ZipEntry> {
  // EOCD 签名 PK\x05\x06 在文件尾部（含 comment，最多 64KB）倒查
  const eocdScanStart = Math.max(0, b.length - 65557);
  let eocd = -1;
  for (let i = b.length - 22; i >= eocdScanStart; i--) {
    if (u32At(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 文件（找不到 EOCD）");
  // EOCD 布局：签名(4) 本盘号(2) CD起始盘号(2) 本盘条目数(2)@8 总条目数(2)@10 CD大小(4)@12 CD偏移(4)@16
  const entryCount = u16At(b, eocd + 8);
  const cdOffset = u32At(b, eocd + 16);

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (u32At(b, p) !== 0x02014b50) throw new Error(`zip 中央目录损坏（entry ${i}）`);
    const method = u16At(b, p + 10);
    const compressedSize = u32At(b, p + 20);
    const nameLen = u16At(b, p + 28);
    const extraLen = u16At(b, p + 30);
    const commentLen = u16At(b, p + 32);
    const localOffset = u32At(b, p + 42);
    const name = DEC.decode(b.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compressedSize, localHeaderOffset: localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 读取 zip 内某条目的原始字节（按 local file header 定位数据区） */
async function readZipEntry(b: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const off = entry.localHeaderOffset;
  if (u32At(b, off) !== 0x04034b50) throw new Error("zip local header 损坏");
  const nameLen = u16At(b, off + 26);
  const extraLen = u16At(b, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const raw = b.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return raw; // stored
  if (entry.method === 8) return inflateRaw(raw); // deflate
  throw new Error(`不支持的 zip 压缩方法：${entry.method}`);
}

/* ----------------------------- docx 读 ----------------------------- */

/** XML 文本节点转义还原（&lt; 等实体 → 原字符） */
function xmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // &amp; 必须最后还原
}

/** OOXML document.xml → 纯文本（段落 → \n\n；<w:br/>/<w:tab/> 处理） */
export function docxXmlToText(xml: string): string {
  const out: string[] = [];
  // 段落：普通 <w:p ...>...</w:p> 与自闭合空段 <w:p/> 都算一段
  const paraRe = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(xml)) !== null) {
    const body = m[1] ?? "";
    let text = "";
    // 逐 token：文本 run / 换行 / 制表（顺序敏感，用统一扫描而非先拆后拼）
    const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>/g;
    let t: RegExpExecArray | null;
    while ((t = tokenRe.exec(body)) !== null) {
      if (t[1] !== undefined) text += xmlUnescape(t[1]);
      else text += t[0].startsWith("<w:br") ? "\n" : "\t";
    }
    out.push(text);
  }
  return out.join("\n\n");
}

/** 解析 .docx（Blob/File/ArrayBuffer）为纯文本；不是 docx 或缺 document.xml 时抛错 */
export async function readDocxText(source: Blob | ArrayBuffer): Promise<string> {
  const buf = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(await source.arrayBuffer());
  const entries = readZipDirectory(buf);
  const entry = entries.get("word/document.xml");
  if (!entry) {
    const names = [...entries.keys()].slice(0, 5).join(", ");
    throw new Error(`不是有效的 .docx（找不到 word/document.xml；包含：${names}）`);
  }
  const raw = await readZipEntry(buf, entry);
  return docxXmlToText(DEC.decode(raw));
}

/* ----------------------------- docx 写 ----------------------------- */

/** 文本 → OOXML 转义（顺序：& 最先，否则二次转义） */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 纯文本 → document.xml（\n\n 段落分隔，段内 \n → <w:br/>，\t → <w:tab/>） */
export function textToDocxXml(text: string): string {
  const paras = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const body = paras
    .map((p) => {
      const runs = p
        .split("\n")
        .map((line) => {
          const segs = line.split("\t");
          return segs
            .map((s, i) => {
              const t = s ? `<w:t xml:space="preserve">${xmlEscape(s)}</w:t>` : "";
              return i < segs.length - 1 ? t + "<w:tab/>" : t;
            })
            .join("");
        })
        .join("<w:br/>");
      return `<w:p><w:r>${runs}</w:r></w:p>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}<w:sectPr/></w:body></w:document>`
  );
}

/** zip 写入（全部 deflate + UTF-8 文件名 flag） */
async function buildZip(files: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const local: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];

  for (const { name, data } of files) {
    const nameBytes = ENC.encode(name);
    const method = 8;
    const payload = data.length ? await deflateRaw(data) : data;
    const crc = crc32(data);
    offsets.push(local.length + 0); // local 偏移基于当前 local 流长度

    u32(local, 0x04034b50);
    u16(local, 20); // version needed
    u16(local, 0x0800); // UTF-8 flag
    u16(local, method);
    u16(local, 0); // time
    u16(local, 0x21); // date (1980-01-01 合法最小值)
    u32(local, crc);
    u32(local, payload.length); // compressed
    u32(local, data.length); // uncompressed
    u16(local, nameBytes.length);
    u16(local, 0); // extra len
    for (const byte of nameBytes) local.push(byte);
    for (const byte of payload) local.push(byte);

    u32(central, 0x02014b50);
    u16(central, 20); // version made by
    u16(central, 20); // version needed
    u16(central, 0x0800); // UTF-8 flag
    u16(central, method);
    u16(central, 0); // time
    u16(central, 0x21); // date
    u32(central, crc);
    u32(central, payload.length);
    u32(central, data.length);
    u16(central, nameBytes.length);
    u16(central, 0); // extra
    u16(central, 0); // comment
    u16(central, 0); // disk start
    u16(central, 0); // internal attrs
    u32(central, 0); // external attrs
    u32(central, offsets[offsets.length - 1]); // local header offset
    for (const byte of nameBytes) central.push(byte);
  }

  const cdOffset = local.length;
  const out: number[] = [...local, ...central];
  u32(out, 0x06054b50); // EOCD
  u16(out, 0); // disk
  u16(out, 0); // cd disk
  u16(out, files.length);
  u16(out, files.length);
  u32(out, central.length);
  u32(out, cdOffset);
  u16(out, 0); // comment
  return new Uint8Array(out);
}

/** 纯文本 → 最小合法 .docx（Blob；Web 直接 a.download，CLI 侧 fs.writeFile(buffer)） */
export async function writeDocxText(text: string): Promise<Blob> {
  const documentXml = textToDocxXml(text);
  const files = [
    {
      name: "[Content_Types].xml",
      data: ENC.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: ENC.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
      ),
    },
    { name: "word/document.xml", data: ENC.encode(documentXml) },
  ];
  const zip = await buildZip(files);
  return new Blob([zip as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}
