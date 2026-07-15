import { describe, expect, it } from "vitest";
import {
  mergeJiuwenModelDrafts,
  resolveAutomaticSelectableJiuwenModel,
  sanitizeModelAdminError,
  toSelectableJiuwenModels,
  toPublicJiuwenModels,
  type JiuwenModelDraft,
  type JiuwenModelSecret,
} from "./jiuwenswarm-model-admin";

const existingModel = (patch: Partial<JiuwenModelSecret> = {}): JiuwenModelSecret => ({
  modelName: "glm-5.2",
  alias: "agent-main",
  apiBase: "https://api.example.com/v1",
  apiKey: "sk-existing-secret",
  provider: "OpenAI",
  reasoningLevel: "",
  temperature: 0.95,
  isDefault: true,
  originIndex: 0,
  timeout: 1800,
  verifySsl: true,
  contextWindowTokens: 128000,
  ...patch,
});

const draft = (patch: Partial<JiuwenModelDraft> = {}): JiuwenModelDraft => ({
  modelName: "glm-5.2",
  alias: "agent-main",
  apiBase: "https://api.example.com/v1",
  provider: "OpenAI",
  reasoningLevel: "",
  temperature: 0.95,
  isDefault: true,
  originIndex: 0,
  ...patch,
});

describe("JiuwenSwarm model admin safety", () => {
  it("never exposes API key material in public model data", () => {
    const publicModels = toPublicJiuwenModels([existingModel()]);
    expect(publicModels[0]).toMatchObject({
      id: "agent-main",
      apiKeyConfigured: true,
      isPrimary: true,
    });
    expect(JSON.stringify(publicModels)).not.toContain("sk-existing-secret");
    expect(publicModels[0]).not.toHaveProperty("apiKey");
  });

  it("builds a safe selectable catalog with one primary model", () => {
    const selectable = toSelectableJiuwenModels([
      existingModel(),
      existingModel({
        modelName: "openpangu-2.0-flash",
        alias: "fast-model",
        apiKey: "sk-second-secret",
        originIndex: 1,
      }),
    ]);

    expect(selectable).toEqual([
      expect.objectContaining({
        id: "agent-main",
        runtimeModelId: "agent-main",
        isDefault: true,
      }),
      expect.objectContaining({
        id: "fast-model",
        name: "fast-model",
        description: "openpangu-2.0-flash",
        runtimeModelId: "fast-model",
        isDefault: false,
      }),
    ]);
    expect(JSON.stringify(selectable)).not.toContain("sk-existing-secret");
    expect(JSON.stringify(selectable)).not.toContain("sk-second-secret");
  });

  it("routes automatic selection to the configured model instead of a hard-coded brand", () => {
    const selectable = toSelectableJiuwenModels([
      existingModel(),
      existingModel({
        modelName: "openpangu-2.0-flash",
        alias: "pangu-flash",
        originIndex: 1,
      }),
    ]);

    expect(resolveAutomaticSelectableJiuwenModel(selectable, "pangu-flash")?.id).toBe("pangu-flash");
    expect(resolveAutomaticSelectableJiuwenModel(selectable, "openpangu-2.0-flash")?.id).toBe("pangu-flash");
    expect(resolveAutomaticSelectableJiuwenModel(selectable, "missing-model")?.id).toBe("agent-main");
  });

  it("preserves the existing key when an admin leaves the key field blank", () => {
    const [merged] = mergeJiuwenModelDrafts([draft()], [existingModel()]);
    expect(merged.apiKey).toBe("sk-existing-secret");
  });

  it("uses a newly supplied key and rejects a new model without one", () => {
    const [merged] = mergeJiuwenModelDrafts([draft({ apiKey: "sk-replacement" })], [existingModel()]);
    expect(merged.apiKey).toBe("sk-replacement");

    expect(() => mergeJiuwenModelDrafts([
      draft({ modelName: "new-model", alias: "new-model", originIndex: undefined }),
    ], [existingModel()])).toThrow(/API key is required/);
  });

  it("rejects duplicate model aliases", () => {
    expect(() => mergeJiuwenModelDrafts([
      draft(),
      draft({ modelName: "other-model", originIndex: undefined }),
    ], [existingModel()])).toThrow(/must be unique/);
  });

  it("redacts model credentials from upstream errors", () => {
    const message = sanitizeModelAdminError(new Error("Authorization: Bearer secret-token api_key=sk-abcdefgh12345678"));
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("sk-abcdefgh12345678");
    expect(message).toContain("[REDACTED]");
  });
});
