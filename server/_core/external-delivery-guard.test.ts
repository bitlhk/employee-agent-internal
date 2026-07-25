import { afterEach, describe, expect, it, vi } from "vitest";

const auditMocks = vi.hoisted(() => ({
  recordAuditBestEffort: vi.fn().mockResolvedValue(null),
}));

vi.mock("./audit-events", () => auditMocks);

import { guardExternalDelivery } from "./external-delivery-guard";

afterEach(() => {
  delete process.env.EA_DATA_GUARDRAIL_MODE;
  auditMocks.recordAuditBestEffort.mockClear();
});

describe("external delivery guard", () => {
  it("blocks secrets and records metadata without plaintext", async () => {
    const result = await guardExternalDelivery({
      adoptId: "lgj-test",
      channel: "feishu",
      text: "api_key=secret-value-123456",
    });
    expect(result.ok).toBe(false);
    expect(auditMocks.recordAuditBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "data_guard.external_delivery.blocked",
        result: "denied",
        agentInstanceId: "lgj-test",
      })
    );
    expect(
      JSON.stringify(auditMocks.recordAuditBestEffort.mock.calls)
    ).not.toContain("secret-value-123456");
  });

  it("redacts personal information before delivery", async () => {
    const result = await guardExternalDelivery({
      adoptId: "lgj-test",
      channel: "weixin",
      text: "联系 13800138000",
    });
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: "redact",
        text: "联系 [REDACTED_PHONE]",
      })
    );
  });

  it("keeps monitor mode non-blocking while recording a detection", async () => {
    process.env.EA_DATA_GUARDRAIL_MODE = "monitor";
    const text = "Bearer abcdefghijklmnop";
    const result = await guardExternalDelivery({ channel: "webhook", text });
    expect(result).toEqual(
      expect.objectContaining({ ok: true, action: "allow", text })
    );
    expect(auditMocks.recordAuditBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "data_guard.external_delivery.detected",
      })
    );
  });
});
