import { describe, expect, it } from "vitest";
import {
  inferModelCapabilities,
  isImageAttachmentName,
  modelMeetsCapabilities,
} from "../../shared/model-capabilities";

describe("model capabilities", () => {
  it("keeps text models conservative while recognizing vision models", () => {
    expect(inferModelCapabilities({ modelName: "glm-5.2" })).toMatchObject({
      tools: true,
      vision: false,
    });
    expect(
      inferModelCapabilities({ modelName: "qwen2.5-vl-72b" })
    ).toMatchObject({ tools: true, vision: true });
  });

  it("prefers the runtime context window over inferred defaults", () => {
    expect(
      inferModelCapabilities({
        modelName: "deepseek-v4-flash",
        contextWindowTokens: 64_000,
      })
    ).toMatchObject({ contextWindowTokens: 64_000, source: "runtime" });
  });

  it("recognizes the MiniMax M3 long-context model", () => {
    expect(inferModelCapabilities({ modelName: "MiniMax-M3" })).toMatchObject({
      tools: true,
      vision: false,
      contextWindowTokens: 1_000_000,
    });
  });

  it("checks explicit requirements and image suffixes", () => {
    const textOnly = inferModelCapabilities({
      modelName: "openpangu-2.0-flash",
    });
    expect(modelMeetsCapabilities(textOnly, { tools: true })).toBe(true);
    expect(modelMeetsCapabilities(textOnly, { vision: true })).toBe(false);
    expect(isImageAttachmentName("客户资料.PNG")).toBe(true);
    expect(isImageAttachmentName("客户资料.pdf")).toBe(false);
  });
});
