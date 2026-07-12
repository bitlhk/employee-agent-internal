import { beforeEach, describe, expect, it } from "vitest";
import { isEncryptedSecret } from "./secret-protection";
import { protectNotifyConfigs, revealNotifyConfigs } from "./claw-notify";

describe("notification credential storage", () => {
  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "test-credential-key-with-sufficient-entropy";
  });

  it("encrypts secrets and webhook credentials without changing runtime values", () => {
    const configs = {
      "lgj-test": {
        type: "wechat_work",
        corpId: "corp-id",
        secret: "wechat-secret",
        webhook: `https://hooks.example.com/${"x".repeat(300)}`,
      },
    };

    const protectedConfigs = protectNotifyConfigs(configs);
    expect(isEncryptedSecret(protectedConfigs["lgj-test"].secret)).toBe(true);
    expect(isEncryptedSecret(protectedConfigs["lgj-test"].webhook)).toBe(true);
    expect(JSON.stringify(protectedConfigs)).not.toContain("wechat-secret");
    expect(revealNotifyConfigs(protectedConfigs)).toEqual(configs);
  });
});
