/**
 * 主界面文件导入/导出的纯逻辑层（自 App.tsx 抽出，行为逐字保留）。
 *
 * 背景（v0.9.15/16/17 UI 能力）：此前 UI 只有「粘贴进 → 复制出」，改一篇
 * 3000 字论文要先从编辑器复制、改完再粘回去。.txt/.md 零依赖直接读；
 * .docx 走零依赖 OOXML 提取（src/docx-io.ts）。
 */
import { readDocxText, writeDocxText } from "./docx-io";

/** 2MB 上限：引擎是纯字符串操作，超大文本会卡住 UI（长文本应走 CLI 批量） */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export interface ImportOutcome {
  /** 提取出的正文；空串表示未导入（输入面板保持原样） */
  text: string;
  name: string;
  note: string;
}

/** 导出文件名：去味-YYYYMMDD-HHMM.ext（分钟粒度，与原实现逐字一致） */
export function makeDatedName(ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `去味-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

/** 浏览器下载：createObjectURL → 隐形 <a> 点击 → 立即 revoke（原实现顺序） */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 导入 .txt/.md/.docx 并归一化为「文本 + 提示」结果。
 * 分支：超 2MB 拒绝（提示走 CLI）/ docx 空文档 / docx 解析失败（报真实原因）/
 * txt FileReader 空 / 成功 / 读取失败。不碰 React 状态，App 只负责接线。
 */
export function importFileToText(f: File): Promise<ImportOutcome> {
  if (f.size > MAX_IMPORT_BYTES) {
    return Promise.resolve({
      text: "",
      name: f.name,
      note: "文件超过 2MB，请拆分后再导入（更大批量请用 CLI：scripts/humanize-cli.ts）。",
    });
  }
  if (/\.docx$/i.test(f.name)) {
    return readDocxText(f)
      .then((t) => {
        if (!t.trim()) {
          return {
            text: "",
            name: f.name,
            note: "docx 里没有可提取的文字（可能是纯图片/空文档），未导入。",
          };
        }
        return {
          text: t,
          name: f.name,
          note: `已导入 ${f.name}（${t.length} 字，格式不保留），点「去味」开始。`,
        };
      })
      .catch((err: unknown) => ({
        text: "",
        name: f.name,
        note: `docx 解析失败：${err instanceof Error ? err.message : String(err)}`,
      }));
  }
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      const t = String(r.result ?? "");
      if (!t.trim()) {
        resolve({ text: "", name: f.name, note: "文件内容为空，未导入。" });
        return;
      }
      resolve({
        text: t,
        name: f.name,
        note: `已导入 ${f.name}（${t.length} 字），点「去味」开始。`,
      });
    };
    r.onerror = () => resolve({ text: "", name: f.name, note: "读取文件失败，请重试或改用粘贴。" });
    r.readAsText(f, "utf-8");
  });
}

/** 导出 .docx：纯文本按段落生成最小合法 OOXML（富文本格式不保留——引擎输出本就是纯文本） */
export async function exportDocxBlob(output: string): Promise<Blob> {
  return writeDocxText(output);
}

/** 导出 .txt：Blob 内容与去味输出逐字一致 */
export function makeTxtBlob(output: string): Blob {
  return new Blob([output], { type: "text/plain;charset=utf-8" });
}
