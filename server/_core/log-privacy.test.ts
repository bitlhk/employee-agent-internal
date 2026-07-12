import { afterEach, describe, expect, it } from "vitest";
import { privateMessageLogFields } from "./log-privacy";

afterEach(() => {
  delete process.env.LOG_MESSAGE_PREVIEW_ENABLED;
  delete process.env.LOG_MESSAGE_HMAC_KEY;
});

describe("private chat log fields", () => {
  it("records length and a stable keyed digest without plaintext", () => {
    process.env.LOG_MESSAGE_HMAC_KEY = "test-only-key";
    const first = privateMessageLogFields("客户身份证号 123456");
    const second = privateMessageLogFields("客户身份证号 123456");
    expect(first).toEqual(second);
    expect(first.messageLength).toBe(13);
    expect(first.messageHmac).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toHaveProperty("message");
    expect(first).not.toHaveProperty("messagePreview");
  });

  it("only emits a redacted preview in explicit diagnostic mode", () => {
    process.env.LOG_MESSAGE_PREVIEW_ENABLED = "true";
    const fields = privateMessageLogFields("联系 test@example.com，Bearer abc.def，并查看 https://example.com?a=secret");
    expect(fields.messagePreview).toContain("[EMAIL]");
    expect(fields.messagePreview).toContain("Bearer [REDACTED]");
    expect(fields.messagePreview).toContain("[URL]");
    expect(fields.messagePreview).not.toContain("test@example.com");
  });
});
