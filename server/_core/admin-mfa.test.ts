import { beforeEach, describe, expect, it } from "vitest";
import { generateTotp } from "./admin-mfa";

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "test-credential-key-with-sufficient-entropy";
});

describe("admin MFA TOTP", () => {
  it("generates stable six-digit codes for a timestamp", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    expect(generateTotp(secret, 1_720_000_000_000)).toMatch(/^\d{6}$/);
    expect(generateTotp(secret, 1_720_000_000_000)).toBe(generateTotp(secret, 1_720_000_000_000));
    expect(generateTotp(secret, 1_720_000_030_000)).not.toBe(generateTotp(secret, 1_720_000_000_000));
  });
});
