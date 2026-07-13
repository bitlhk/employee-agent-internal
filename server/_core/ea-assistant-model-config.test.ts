import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, isEncryptedSecret } from "./secret-protection";

const dbMocks = vi.hoisted(() => ({
  getSystemConfig: vi.fn(),
  upsertSystemConfig: vi.fn(),
}));

vi.mock("../db", () => dbMocks);

import {
  getEaAssistantModelAdminConfig,
  saveEaAssistantModelConfig,
} from "./ea-assistant-model";

describe("EA assistant model configuration", () => {
  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "ea-model-test-encryption-key-with-sufficient-entropy";
    dbMocks.getSystemConfig.mockReset().mockResolvedValue(null);
    dbMocks.upsertSystemConfig.mockReset().mockResolvedValue(undefined);
  });

  it("encrypts the independently configured EA API key at rest", async () => {
    await saveEaAssistantModelConfig({
      apiBase: "https://api.example.com/v1",
      modelName: "ea-fast",
      apiKey: "sk-ea-private-key",
      provider: "OpenAI",
      timeoutMs: 9000,
      disableThinking: true,
    }, 7);

    const stored = dbMocks.upsertSystemConfig.mock.calls[0][0];
    expect(stored.key).toBe("ea_assistant_model_config_v1");
    expect(isEncryptedSecret(stored.value)).toBe(true);
    expect(stored.value).not.toContain("sk-ea-private-key");
    expect(JSON.parse(decryptSecret(stored.value))).toMatchObject({
      modelName: "ea-fast",
      apiKey: "sk-ea-private-key",
    });
  });

  it("returns only credential state to the Admin UI", async () => {
    const encrypted = dbMocks.upsertSystemConfig.mock.calls[0]?.[0]?.value;
    if (!encrypted) {
      await saveEaAssistantModelConfig({
        apiBase: "https://api.example.com/v1",
        modelName: "ea-fast",
        apiKey: "sk-ea-private-key",
        provider: "OpenAI",
        timeoutMs: 8000,
        disableThinking: true,
      }, 7);
    }
    const value = dbMocks.upsertSystemConfig.mock.calls.at(-1)![0].value;
    dbMocks.getSystemConfig.mockResolvedValue({ value });
    const config = await getEaAssistantModelAdminConfig();
    expect(config).toMatchObject({ modelName: "ea-fast", apiKeyConfigured: true });
    expect(config).not.toHaveProperty("apiKey");
    expect(JSON.stringify(config)).not.toContain("sk-ea-private-key");
  });
});
