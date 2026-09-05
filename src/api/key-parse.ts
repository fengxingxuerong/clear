/** Key 列表解析：换行/逗号/分号分隔，去空去重（与 effectiveKeys 同一套规则） */
export function parseKeyList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const k of raw.split(/[\n,;，；]+/)) {
    const t = k.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}
