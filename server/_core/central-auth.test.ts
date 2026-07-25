import { describe, expect, it } from "vitest";
import { centralAuthConfigFromEnv, centralAuthRedirectUrl } from "./central-auth";

const centralConfig = {
  mode: "central" as const,
  bridgeUrl: "https://www.linggan.top/api/embed/sso-bridge",
  publicBaseUrl: "https://ling-claw.demo.linggan.top",
};

describe("central auth redirect", () => {
  it("keeps local deployments on the built-in login page", () => {
    expect(centralAuthConfigFromEnv({ AUTH_MODE: "local" })).toEqual({ mode: "local" });
    expect(centralAuthRedirectUrl({ config: { mode: "local" }, pathname: "/login" })).toBeNull();
  });

  it("redirects central login routes through the configured SSO bridge", () => {
    const redirect = centralAuthRedirectUrl({
      config: centralConfig,
      pathname: "/login/",
      redirect: "/claw/lgj-example?tab=chat",
    });
    const parsed = new URL(String(redirect));
    expect(parsed.origin + parsed.pathname).toBe("https://www.linggan.top/api/embed/sso-bridge");
    expect(parsed.searchParams.get("next")).toBe("https://ling-claw.demo.linggan.top/claw/lgj-example?tab=chat");
  });

  it("rejects external and recursive return targets", () => {
    for (const target of ["https://evil.example/login", "//evil.example/login", "/login?again=1", "/reset-password"]) {
      const redirect = new URL(String(centralAuthRedirectUrl({
        config: centralConfig,
        pathname: "/login",
        redirect: target,
      })));
      expect(redirect.searchParams.get("next")).toBe("https://ling-claw.demo.linggan.top/");
    }
  });

  it("does not intercept normal application routes", () => {
    expect(centralAuthRedirectUrl({ config: centralConfig, pathname: "/claw/lgj-example" })).toBeNull();
  });

  it("fails closed when central mode is missing HTTPS configuration", () => {
    expect(() => centralAuthConfigFromEnv({ AUTH_MODE: "central", CENTRAL_AUTH_BRIDGE_URL: "http://example.com" }))
      .toThrow("CENTRAL_AUTH_BRIDGE_URL must use HTTPS");
  });
});
