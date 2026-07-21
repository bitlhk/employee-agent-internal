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
