import { describe, expect, it, vi } from "vitest";
import { CustomMcpOAuthProvider } from "./custom-mcp-oauth-provider";

describe("CustomMcpOAuthProvider", () => {
  it("keeps OAuth state isolated and persists token changes", async () => {
    const changed = vi.fn();
    const data = { redirectUrl: "https://agent.example.com/api/claw/custom-mcp/oauth/callback" };
    const provider = new CustomMcpOAuthProvider({ data, state: "state-1", onDataChanged: changed });

    expect(provider.state()).toBe("state-1");
    expect(provider.clientMetadata.redirect_uris).toEqual([data.redirectUrl]);
    await provider.saveClientInformation({ client_id: "client-1" });
    await provider.saveTokens({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer" });

    expect(provider.clientInformation()).toMatchObject({ client_id: "client-1" });
    expect(provider.tokens()).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a runtime provider needs interactive authorization", () => {
    const provider = new CustomMcpOAuthProvider({
      data: { redirectUrl: "https://agent.example.com/api/claw/custom-mcp/oauth/callback" },
    });
    expect(() => provider.redirectToAuthorization(new URL("https://accounts.example.com/authorize"))).toThrow(/重新授权/);
  });

  it("clears only the requested credential scope", async () => {
    const data = {
      redirectUrl: "https://agent.example.com/api/claw/custom-mcp/oauth/callback",
      clientInformation: { client_id: "client-1" },
      tokens: { access_token: "access-1", token_type: "Bearer" },
      discoveryState: { authorizationServerUrl: "https://accounts.example.com" },
    };
    const provider = new CustomMcpOAuthProvider({ data });
    await provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toMatchObject({ client_id: "client-1" });
    expect(provider.discoveryState()).toMatchObject({ authorizationServerUrl: "https://accounts.example.com" });
  });
});
