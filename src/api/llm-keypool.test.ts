import { describe, it, expect } from "vitest";
import { effectiveKeys, type ApiConfig } from "./llm-config";

function cfg(partial: Partial<ApiConfig>): ApiConfig {
  return {
    enabled: true,
    baseUrl: "https://api.example.com/v1",
    apiKey: "",
    model: "test",
    temperature: 0.9,
    deepMode: false,
    judgeModel: "",
    altModel: "",
    style: "casual",
    ...partial,
  };
}

describe("effectiveKeys（Key 池解析）", () => {
  it("apiKey 与 apiKeys 合并去重", () => {
    const keys = effectiveKeys(cfg({ apiKey: "k1", apiKeys: "k1\nk2" }));
    expect(keys).toEqual(["k1", "k2"]);
  });

  it("支持换行/逗号/分号/中文标点混排", () => {
    const keys = effectiveKeys(cfg({ apiKeys: "a, b；c；d，e\nf" }));
    expect(keys).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("忽略空白项", () => {
    const keys = effectiveKeys(cfg({ apiKeys: "\n  \nk1\n\n  k2  \n" }));
    expect(keys).toEqual(["k1", "k2"]);
  });

  it("都为空时返回空数组", () => {
    expect(effectiveKeys(cfg({}))).toEqual([]);
  });
});
