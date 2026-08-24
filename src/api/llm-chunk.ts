/**
 * 趣AI味 · 长文分块：超过阈值直送 LLM 会质量衰减（中段注意力稀释）
 */

/* ----------------------------- 长文分块（v0.5.0） ----------------------------- */

/** 超过阈值的整篇直送 LLM 会质量衰减（长上下文中段注意力稀释），
 *  按段落边界切成 ~1000 字的块逐块处理再拼接。纯确定性切分，可独立测试。 */
export const CHUNK_THRESHOLD = 1200;
/** 单块目标字数（splitIntoChunks 的分块粒度） */
export const CHUNK_SIZE = 1000;

export function splitIntoChunks(text: string, size = CHUNK_SIZE): string[] {
  const paras = text.split(/\n{2,}/).filter((p) => p.trim());
  const units: string[] = [];
  for (const para of paras) {
    if (para.length <= size) {
      units.push(para);
      continue;
    }
    // 超长段落再按句边界切
    const sentences = para.split(/(?<=[。！？!?])/);
    let cur = "";
    for (const sent of sentences) {
      if ((cur + sent).length > size && cur) {
        units.push(cur);
        cur = sent;
      } else {
        cur += sent;
      }
    }
    if (cur.trim()) units.push(cur);
  }
  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    if ((cur + "\n\n" + u).length > size && cur) {
      chunks.push(cur);
      cur = u;
    } else {
      cur = cur ? cur + "\n\n" + u : u;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}
