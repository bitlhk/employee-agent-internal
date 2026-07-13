import { describe, expect, it } from "vitest";
import {
  mergeJiuwenModelDrafts,
  sanitizeModelAdminError,
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
