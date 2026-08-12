import { describe, expect, it } from "vitest";
import { presentModel } from "./modelPresentation";

describe("presentModel", () => {
  it("presents GLM with a product name instead of its API id", () => {
    expect(presentModel({ id: "glm-5.2", isDefault: true })).toMatchObject({
      displayName: "GLM-5.2",
      brand: "glm",
      iconSrc: "/images/model-providers/glm.png",
    });
  });

  it("recognizes openPangu flash as a fast model", () => {
    expect(presentModel({ id: "openpangu-2.0-flash" })).toMatchObject({
      displayName: "openPangu-2.0-flash",
      brand: "pangu",
      iconSrc: "/images/model-providers/pangu.png",
    });
  });

  it("presents DeepSeek with its official provider icon", () => {
    expect(presentModel({ id: "deepseek-v4-flash" })).toMatchObject({
      displayName: "DeepSeek-V4-Flash",
      brand: "deepseek",
      iconSrc: "/images/model-providers/deepseek.svg",
    });
  });

  it("presents the additional Volcengine models with distinct provider icons", () => {
    expect(presentModel({ id: "Doubao Seed 2.1 Pro" })).toMatchObject({
      displayName: "Doubao Seed 2.1 Pro",
      brand: "doubao",
      iconSrc: "/images/model-providers/doubao.svg",
    });
    expect(presentModel({ id: "MiniMax M3" })).toMatchObject({
      displayName: "MiniMax M3",
      brand: "minimax",
      iconSrc: "/images/model-providers/minimax.svg",
    });
    expect(presentModel({ id: "HY3" })).toMatchObject({
      displayName: "HY3",
      brand: "hunyuan",
      iconSrc: "/images/model-providers/hunyuan.svg",
    });
  });

  it("presents Nemotron Nano with the NVIDIA provider icon", () => {
    expect(
      presentModel({
        id: "Nemotron Nano",
        name: "Nemotron Nano",
        provider: "OpenRouter",
      })
    ).toMatchObject({
      displayName: "Nemotron Nano",
      brand: "nvidia",
      iconSrc: "/images/model-providers/nvidia.svg",
    });

    expect(
      presentModel({
        id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      }).displayName
    ).toBe("Nemotron 3 Nano");
  });

  it("uses distinct provider icons for OpenRouter models", () => {
    expect(
      presentModel({
        id: "Gemma 4 26B",
        name: "Gemma 4 26B",
        provider: "OpenRouter",
      })
    ).toMatchObject({
      displayName: "Gemma 4 26B",
      brand: "gemma",
      iconSrc: "/images/model-providers/gemma.svg",
    });
    expect(
      presentModel({
        id: "Laguna S 2.1",
        name: "Laguna S 2.1",
        provider: "OpenRouter",
      })
    ).toMatchObject({
      displayName: "Laguna S 2.1",
      brand: "poolside",
      iconSrc: "/images/model-providers/poolside.svg",
    });
    expect(
      presentModel({
        id: "GPT-5.6 Luna",
        name: "GPT-5.6 Luna",
        provider: "OpenRouter",
      })
    ).toMatchObject({
      displayName: "GPT-5.6 Luna",
      brand: "openai",
      iconSrc: "/images/model-providers/openai.svg",
    });
  });

  it("presents automatic selection as a first-class option", () => {
    expect(presentModel({ id: "__auto", name: "自动" })).toMatchObject({
      displayName: "自动",
      brand: "auto",
      available: true,
    });
  });

  it("keeps unknown models usable with neutral presentation", () => {
    expect(
      presentModel({ id: "vendor/custom_model", provider: "Vendor API" })
    ).toMatchObject({
      displayName: "custom_model",
      brand: "generic",
      available: true,
    });
  });

  it("uses a friendly backend name for unknown providers", () => {
    expect(
      presentModel({ id: "vendor/model-v3", name: "Acme Reasoner 3" })
        .displayName
    ).toBe("Acme Reasoner 3");
  });
});
