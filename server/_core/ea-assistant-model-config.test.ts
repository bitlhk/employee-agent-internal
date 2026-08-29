import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, isEncryptedSecret } from "./secret-protection";

const dbMocks = vi.hoisted(() => ({
  getSystemConfig: vi.fn(),
  upsertSystemConfig: vi.fn(),
}));

vi.mock("../db", () => dbMocks);

import {
  callEaAssistantModelWithConfig,
  getEaAssistantModelAdminConfig,
  saveEaAssistantModelConfig,
} from "./ea-assistant-model";

describe("EA assistant model configuration", () => {
  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "ea-model-test-encryption-key-with-sufficient-entropy";
    dbMocks.getSystemConfig.mockReset().mockResolvedValue(null);
    dbMocks.upsertSystemConfig.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("uses Volcengine thinking control and structured output when requested", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"status":"READY"}' } }],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await callEaAssistantModelWithConfig(
      {
        baseUrl: "https://example.apigateway-cn-beijing.volceapi.com/v1/chat/completions",
        model: "glm-5.2",
        apiKey: "test-key",
        provider: "Volcengine/OpenAI-compatible",
        timeoutMs: 1_000,
        disableThinking: true,
        tokenParam: "max_tokens",
        thinkingControl: "thinking",
        structuredOutputMode: "json_schema",
      },
      {
        messages: [{ role: "user", content: "返回 JSON" }],
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "probe",
            strict: true,
            schema: {
              type: "object",
              properties: { status: { type: "string" } },
              required: ["status"],
              additionalProperties: false,
            },
          },
        },
      }
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("chat_template_kwargs");
    expect(body.response_format).toMatchObject({ type: "json_schema" });
  });
});
