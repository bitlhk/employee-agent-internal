import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, isEncryptedSecret, keyedDigest } from "./secret-protection";

const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
beforeEach(() => { process.env.CREDENTIAL_ENCRYPTION_KEY = "test-credential-key-with-sufficient-entropy"; });
afterEach(() => { process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey; });

describe("secret protection", () => {
  it("encrypts credentials with authenticated encryption", () => {
    const encrypted = encryptSecret("smtp-password");
    expect(isEncryptedSecret(encrypted)).toBe(true);
    expect(encrypted).not.toContain("smtp-password");
    expect(decryptSecret(encrypted)).toBe("smtp-password");
  });

  it("creates deterministic non-plaintext digests within legacy column sizes", () => {
    expect(keyedDigest("email-code", "123456")).toHaveLength(10);
    expect(keyedDigest("email-code", "123456")).not.toBe("123456");
    expect(keyedDigest("password-reset", "token").length).toBeLessThanOrEqual(64);
  });
});
