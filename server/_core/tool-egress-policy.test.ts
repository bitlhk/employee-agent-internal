import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auditMocks = vi.hoisted(() => ({
  recordAuditBestEffort: vi.fn().mockResolvedValue(null),
}));

vi.mock("./audit-events", () => auditMocks);

import {
  evaluateToolEgress,
  guardToolEgress,
} from "./tool-egress-policy";

describe("tool egress policy", () => {
  beforeEach(() => {
    vi.stubEnv("EA_DATA_GUARDRAIL_MODE", "enforce");
    auditMocks.recordAuditBestEffort.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows ordinary financial tool arguments", () => {
    const decision = evaluateToolEgress({
      channel: "custom_mcp",
      payload: {
        symbol: "600036.SH",
        question: "比较最近三年的净息差与不良贷款率",
      },
      toolName: "stock_fundamentals",
      destinationUrl: "https://mcp.example.com/v1",
    });

    expect(decision).toMatchObject({ ok: true, action: "allow", types: [] });
  });

  it("monitors PII without blocking or mutating structured arguments", () => {
    const payload = {
      customerName: "张三",
      phone: "13800138000",
      task: "查询客户已授权的产品适配结果",
    };
    const decision = evaluateToolEgress({
      channel: "custom_mcp",
      payload,
      toolName: "customer_profile",
    });

    expect(decision.ok).toBe(true);
    expect(decision.action).toBe("monitor");
    expect(decision.types).toContain("cn_phone");
    expect(payload.phone).toBe("13800138000");
  });

  it.each([
    { api_key: "sk-abcdefghijklmnopqrstuvwxyz" },
    { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
    {
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXktZm9yLXRlc3Rpbmc=\n-----END PRIVATE KEY-----",
    },
  ])("blocks explicit credentials before tool egress", payload => {
    const decision = evaluateToolEgress({
      channel: "mcp_adapter",
      payload,
      toolName: "external_tool",
    });

    expect(decision.ok).toBe(false);
    expect(decision.action).toBe("block");
    expect(decision.reasonCodes).toContain("credential_or_private_key");
  });

  it("blocks credentials and oversized payloads embedded in browser URLs", () => {
    const credential = evaluateToolEgress({
      channel: "managed_browser",
      payload: {},
      destinationUrl:
        "https://example.com/search?token=abcdefghijklmnopqrstuv",
    });
    const oversized = evaluateToolEgress({
      channel: "managed_browser",
      payload: {},
      destinationUrl: `https://example.com/search?q=${"a".repeat(2_100)}`,
    });

    expect(credential).toMatchObject({
      ok: false,
      reasonCodes: ["credential_or_private_key"],
    });
    expect(oversized.ok).toBe(false);
    expect(oversized.reasonCodes).toContain("oversized_url_query");
  });

  it("allows credential placeholders in documentation URLs", () => {
    const decision = evaluateToolEgress({
      channel: "managed_browser",
      payload: {},
      destinationUrl: "https://example.com/docs?token=YOUR_API_KEY",
    });

    expect(decision).toMatchObject({ ok: true, action: "allow" });
  });

  it("honors monitor mode without blocking", () => {
    vi.stubEnv("EA_DATA_GUARDRAIL_MODE", "monitor");
    const decision = evaluateToolEgress({
      channel: "a2a",
      payload: { api_key: "sk-abcdefghijklmnopqrstuvwxyz" },
    });

    expect(decision).toMatchObject({ ok: true, action: "monitor" });
  });

  it.each([
    { api_key: "YOUR_API_KEY" },
    { access_token: "${ACCESS_TOKEN}" },
    { password: "change_me" },
  ])("does not block credential placeholders in documentation", payload => {
    const decision = evaluateToolEgress({
      channel: "a2a",
      payload,
    });

    expect(decision).toMatchObject({ ok: true, action: "monitor" });
  });

  it("audits metadata without recording plaintext secrets", async () => {
    const secret = "sk-super-secret-value-1234567890";
    await guardToolEgress({
      channel: "custom_mcp",
      payload: { api_key: secret },
      adoptId: "lgj-test",
      toolName: "external_tool",
      destinationUrl: "https://mcp.example.com/v1",
    });

    expect(auditMocks.recordAuditBestEffort).toHaveBeenCalledOnce();
    const auditJson = JSON.stringify(
      auditMocks.recordAuditBestEffort.mock.calls
    );
    expect(auditJson).not.toContain(secret);
    expect(auditJson).toContain("security.tool_egress.blocked");
    expect(auditJson).toContain("mcp.example.com");
  });
});
