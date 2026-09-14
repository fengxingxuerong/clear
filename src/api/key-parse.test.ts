/** Key 列表解析测试：换行/逗号/分号（含全角）分隔、去空去重 */
import { describe, it, expect } from "vitest";
import { parseKeyList } from "./key-parse";

describe("parseKeyList", () => {
  it("undefined / 空串 → 空数组", () => {
    expect(parseKeyList(undefined)).toEqual([]);
    expect(parseKeyList("")).toEqual([]);
  });

  it("换行分隔", () => {
    expect(parseKeyList("aaa\nbbb\nccc")).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("半角/全角逗号与分号混排", () => {
    expect(parseKeyList("aaa,bbb；ccc，ddd;eee")).toEqual(["aaa", "bbb", "ccc", "ddd", "eee"]);
  });

  it("去空项与首尾空白", () => {
    expect(parseKeyList("  aaa \n\n , bbb ,\n;")).toEqual(["aaa", "bbb"]);
  });

  it("去重（重复 Key 只保留一个）", () => {
    expect(parseKeyList("aaa\nbbb,aaa； bbb ;aaa")).toEqual(["aaa", "bbb"]);
  });

  it("纯分隔符 → 空数组（不产生空串 Key）", () => {
    expect(parseKeyList(",,;;\n，，")).toEqual([]);
  });

  it("单个 Key 原样返回", () => {
    expect(parseKeyList("sk-only-one-key")).toEqual(["sk-only-one-key"]);
  });
});
