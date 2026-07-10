import { afterEach, describe, expect, it } from "vitest";
import { clearOAuthStatesForTest, consumeOAuthState, createOAuthState } from "./oauth-state";

afterEach(clearOAuthStatesForTest);

describe("OAuth state", () => {
  it("is bound to the browser cookie and can only be consumed once", () => {
    const created = createOAuthState("https://app.example.com/api/oauth/callback", 1000);
    expect(consumeOAuthState(created.state, "wrong", 1001)).toBeNull();
    expect(consumeOAuthState(created.state, created.state, 1001)).toBe("https://app.example.com/api/oauth/callback");
    expect(consumeOAuthState(created.state, created.state, 1002)).toBeNull();
  });

  it("rejects expired state", () => {
    const created = createOAuthState("https://app.example.com/api/oauth/callback", 1000);
    expect(consumeOAuthState(created.state, created.state, 1000 + created.maxAgeMs + 1)).toBeNull();
  });
});
