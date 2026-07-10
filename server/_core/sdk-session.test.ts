import { describe, expect, it } from "vitest";
import { sdk, sessionAuthVersion } from "./sdk";

describe("session hardening", () => {
  it("changes the auth version when a password hash changes", () => {
    const before = sessionAuthVersion({ id: 7, password: "hash-one" });
    const after = sessionAuthVersion({ id: 7, password: "hash-two" });
    expect(before).not.toBe(after);
  });

  it("includes a required auth version in newly signed sessions", async () => {
    const authVersion = sessionAuthVersion({ id: 7, password: "hash-one" });
    const token = await sdk.signSession({ userId: 7, name: "test", authVersion });
    await expect(sdk.verifySession(token)).resolves.toEqual({
      userId: 7,
      name: "test",
      authVersion,
    });
  });
});
