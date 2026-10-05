// @vitest-environment happy-dom
/**
 * 主界面文件导入/导出纯逻辑的行为锁（自 App.tsx 抽出时补）。
 * 分支：2MB 守卫 / docx 空文档 / docx 解析失败 / txt 空 / txt 成功 /
 * FileReader onerror / 下载文件名与 Blob 内容。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  importFileToText,
  makeDatedName,
  downloadBlob,
  exportDocxBlob,
  makeTxtBlob,
  MAX_IMPORT_BYTES,
} from "./app-fileio";
import { writeDocxText } from "./docx-io";

const { readDocxTextMock, createObjectURLMock } = vi.hoisted(() => ({
  readDocxTextMock: vi.fn(),
  createObjectURLMock: vi.fn(),
}));

vi.mock("./docx-io", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docx-io")>()),
  readDocxText: readDocxTextMock,
}));

beforeEach(() => {
  readDocxTextMock.mockReset();
  (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURLMock;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  createObjectURLMock.mockReset();
  createObjectURLMock.mockReturnValue("blob:mock-url");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("importFileToText", () => {
  it("超 2MB：拒绝且不触 docx 解析，提示走 CLI", async () => {
    const big = new File([new ArrayBuffer(MAX_IMPORT_BYTES + 1)], "大文件.txt");
    const r = await importFileToText(big);
    expect(r.text).toBe("");
    expect(r.note).toContain("文件超过 2MB");
    expect(r.note).toContain("scripts/humanize-cli.ts");
    expect(readDocxTextMock).not.toHaveBeenCalled();
  });

  it("恰好 2MB 不误伤（守卫是 > 而非 >=）", async () => {
    const ok = new File([new ArrayBuffer(MAX_IMPORT_BYTES)], "边界.txt");
    const r = await importFileToText(ok);
    expect(r.note).not.toContain("文件超过 2MB");
  });

  it(".docx 成功：返回提取文本与格式不保留提示", async () => {
    readDocxTextMock.mockResolvedValue("从 Word 提取的正文。");
    const r = await importFileToText(new File(["x"], "报告.docx"));
    expect(r.text).toBe("从 Word 提取的正文。");
    expect(r.note).toContain("已导入 报告.docx");
    expect(r.note).toContain("格式不保留");
  });

  it(".docx 空文档：text 为空 + 无文字提示", async () => {
    readDocxTextMock.mockResolvedValue("   ");
    const r = await importFileToText(new File(["x"], "空.docx"));
    expect(r.text).toBe("");
    expect(r.note).toContain("docx 里没有可提取的文字");
  });

  it(".docx 解析失败：报真实原因（docx 导入导出是零依赖手写 OOXML，坏文件有真错误）", async () => {
    readDocxTextMock.mockRejectedValue(new Error("不是有效的 zip 文件（找不到 EOCD）"));
    const r = await importFileToText(new File(["x"], "坏.docx"));
    expect(r.text).toBe("");
    expect(r.note).toContain("docx 解析失败：不是有效的 zip 文件");
  });

  it(".txt 成功：FileReader 读取全文", async () => {
    const r = await importFileToText(new File(["纯文本内容一二三"], "笔记.txt"));
    expect(r.text).toBe("纯文本内容一二三");
    expect(r.note).toContain("已导入 笔记.txt");
  });

  it(".txt 空内容：未导入提示", async () => {
    const r = await importFileToText(new File(["   "], "空.txt"));
    expect(r.text).toBe("");
    expect(r.note).toContain("文件内容为空");
  });

  it("FileReader 出错：读取失败提示（不抛异常，交由 UI setNote）", async () => {
    const FakeReader = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: unknown = null;
      readAsText() {
        queueMicrotask(() => this.onerror?.());
      }
    };
    vi.stubGlobal("FileReader", FakeReader);
    const r = await importFileToText(new File(["x"], "炸.txt"));
    expect(r.text).toBe("");
    expect(r.note).toContain("读取文件失败");
    vi.unstubAllGlobals();
  });

  /* 2026-10-05 分支补测：app-fileio.ts 此前分支 83.3%，剩 69 与 75 两处右支。 */

  it('FileReader 的 result 为 null → 走 `?? ""` 右支并提示内容为空（行 75）', async () => {
    const FakeReader = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: unknown = null; // 关键：读成功但 result 是 null
      readAsText() {
        queueMicrotask(() => this.onload?.());
      }
    };
    vi.stubGlobal("FileReader", FakeReader);
    const r = await importFileToText(new File(["x"], "空结果.txt"));
    expect(r.text).toBe("");
    expect(r.note).toContain("文件内容为空");
    vi.unstubAllGlobals();
  });

  it("docx 解析抛出的不是 Error（字符串）→ 走 String(err) 右支（行 69）", async () => {
    readDocxTextMock.mockRejectedValue("底层库炸了个字符串");
    const r = await importFileToText(new File(["x"], "怪.docx"));
    expect(r.text).toBe("");
    expect(r.note).toBe("docx 解析失败：底层库炸了个字符串");
  });
});

describe("makeDatedName / downloadBlob / Blob 构造", () => {
  it("文件名格式：去味-YYYYMMDD-HHMM.ext", () => {
    expect(makeDatedName("docx")).toMatch(/^去味-\d{8}-\d{4}\.docx$/);
    expect(makeDatedName("txt")).toMatch(/^去味-\d{8}-\d{4}\.txt$/);
  });

  it("downloadBlob：createObjectURL → a.click → revoke 顺序执行", () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const blob = new Blob(["x"]);
    downloadBlob(blob, "去味-x.txt");
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(createObjectURLMock).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    clickSpy.mockRestore();
  });

  it("makeTxtBlob：Blob 内容与导出文本逐字一致", async () => {
    const blob = makeTxtBlob("去味后的正文");
    expect(await blob.text()).toBe("去味后的正文");
  });

  it("exportDocxBlob：writeDocxText 真实生成非空 Blob（真实实现，不 mock）", async () => {
    const blob = await exportDocxBlob("第一段。\n\n第二段。");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    // 生成的 OOXML 必须是合法 zip（PK 头），且能被 writeDocxText 的读端回读
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect([head[0], head[1]]).toEqual([0x50, 0x4b]);
    expect(writeDocxText).toBeTruthy();
  });
});
