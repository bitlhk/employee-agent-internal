import { describe, expect, it } from "vitest";
import {
  buildExternalAuthorizationUrl,
  buildExternalOAuthCallbackUrl,
  readExternalOAuthConfiguration,
} from "./external-oauth-routes";

describe("external OAuth route helpers", () => {
  it("fails closed when any required endpoint is absent", () => {
    expect(readExternalOAuthConfiguration({
      VITE_APP_ID: "app-1",
      OAUTH_PORTAL_URL: "https://portal.example.com",
    })).toBeNull();
  });

  it("builds a callback from the configured public base", () => {
    expect(buildExternalOAuthCallbackUrl({
      configuredBase: "https://agent.example.com/base",
      requestOrigin: "http://127.0.0.1:5180",
    })).toBe("https://agent.example.com/api/oauth/callback");
  });

  it("constructs the portal authorization request with encoded parameters", () => {
    const result = new URL(buildExternalAuthorizationUrl({
      portalUrl: "https://portal.example.com/root",
      applicationId: "employee agent",
      callbackUrl: "https://agent.example.com/api/oauth/callback",
      state: "state/value",
    }));
    expect(result.pathname).toBe("/app-auth");
    expect(result.searchParams.get("appId")).toBe("employee agent");
    expect(result.searchParams.get("redirectUri")).toBe("https://agent.example.com/api/oauth/callback");
    expect(result.searchParams.get("state")).toBe("state/value");
    expect(result.searchParams.get("type")).toBe("signIn");
  });
});
