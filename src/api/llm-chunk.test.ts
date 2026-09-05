import { describe, it, expect } from "vitest";
import { splitIntoChunks, CHUNK_SIZE } from "./llm-chunk";
import { crossChunkCleanup } from "../engine/humanize";
import { PAD_WORDS } from "../engine/humanize-text";

describe("splitIntoChunks（长文分块 · 段落/句子边界）", () => {
  it("空文本返回空数组", () => {
    expect(splitIntoChunks("")).toEqual([]);
    expect(splitIntoChunks("   \n\n  ")).toEqual([]);
  });

  it("短文本单块原样返回", () => {
    const t = "第一段。\n\n第二段。";
    expect(splitIntoChunks(t)).toEqual([t]);
  });

  it("超长文本切多块且内容零丢失（顺序保持）", () => {
    const para = "这是测试句子，用来堆长度。".repeat(20);
    const text = Array(8).fill(para).join("\n\n");
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    // 内容守恒：拼接后去掉空白与原文一致
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    // 除「单句超长」的兜底外，每块不超过目标粒度太多
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_SIZE * 1.5);
    }
  });

  it("超长段落按句边界再切，不切碎句子", () => {
    const text = "第一句话内容。".repeat(200); // 单段 1200 字
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.endsWith("。")).toBe(true);
    }
  });

  it("无法切分的超长单句整句成块（兜底不丢内容）", () => {
    const text = "没有任何句号的超长文本".repeat(100);
    const chunks = splitIntoChunks(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });
});

describe("crossChunkCleanup（跨块反指纹清理）", () => {
  const pad = PAD_WORDS[0];

  it("垫词全篇只保留第一次出现（块边界累积指纹的核心场景）", () => {
    const text = `块一内容。${pad}，块二开头。${pad}，块三开头。${pad}，块四开头。`;
    const out = crossChunkCleanup(text);
    const count = out.split(pad + "，").length - 1;
    expect(count).toBe(1);
  });

  it("破折号与省略号各限一次，多余的降级替换", () => {
    const text = "甲——乙。丙——丁。戊——己。子……丑。寅……卯。";
    const out = crossChunkCleanup(text);
    expect(out.split("——").length - 1).toBe(1);
    expect(out.split("……").length - 1).toBe(1);
  });

  it("中英数字间空格指纹被清理", () => {
    const text = "共 100 次调用，AI 模型很重要。";
    const out = crossChunkCleanup(text);
    expect(/[\u4e00-\u9fa5][ \t]+[A-Za-z0-9]/.test(out)).toBe(false);
  });

  it("幂等：清理两遍与一遍结果一致", () => {
    const text = `块一。${pad}，块二。${pad}，块三。甲——乙——丙。中文 English 空格。`;
    const once = crossChunkCleanup(text);
    expect(crossChunkCleanup(once)).toBe(once);
  });
});
