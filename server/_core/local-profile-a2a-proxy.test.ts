import { describe, expect, it } from "vitest";

import {
  localProfileA2AProxyEnabled,
  resolveLocalProfileA2AProxyPort,
  resolveLocalProfileA2AProxyTimeout,
  resolveTrustedLocalProfileA2ATarget,
} from "./local-profile-a2a-proxy";

describe("local Hermes profile A2A proxy config", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(localProfileA2AProxyEnabled(undefined)).toBe(false);
    expect(localProfileA2AProxyEnabled("false")).toBe(false);
    expect(localProfileA2AProxyEnabled("true")).toBe(true);
    expect(localProfileA2AProxyEnabled(" TRUE ")).toBe(true);
  });

  it("only accepts a valid unprivileged TCP port", () => {
    expect(resolveLocalProfileA2AProxyPort("8898")).toBe(8898);
    expect(resolveLocalProfileA2AProxyPort("80")).toBe(8898);
    expect(resolveLocalProfileA2AProxyPort("not-a-port")).toBe(8898);
    expect(resolveLocalProfileA2AProxyPort("70000")).toBe(8898);
  });

  it("allows long PPT jobs without creating an unbounded proxy timeout", () => {
    expect(resolveLocalProfileA2AProxyTimeout(undefined)).toBe(1_400_000);
    expect(resolveLocalProfileA2AProxyTimeout("1400000")).toBe(1_400_000);
    expect(resolveLocalProfileA2AProxyTimeout("10000")).toBe(1_400_000);
    expect(resolveLocalProfileA2AProxyTimeout("1900000")).toBe(1_400_000);
    expect(resolveLocalProfileA2AProxyTimeout("invalid")).toBe(1_400_000);
  });

  it("routes enabled same-origin profile requests directly to loopback", () => {
    const env = {
      PUBLIC_BASE_URL: "https://work.example.com",
      HERMES_PPT_A2A_PROXY_ENABLED: "true",
      HERMES_PPT_A2A_PORT: "8898",
    };
    expect(resolveTrustedLocalProfileA2ATarget(
      "https://work.example.com/a2a/ppt-expert",
      env,
    )).toEqual({ url: "http://127.0.0.1:8898/", allowPrivate: true });
    expect(resolveTrustedLocalProfileA2ATarget(
      "https://work.example.com/a2a/ppt-expert/files/context/report.pdf?sig=one",
      env,
    )).toEqual({
      url: "http://127.0.0.1:8898/files/context/report.pdf?sig=one",
      allowPrivate: true,
    });
  });

  it("routes the enabled TCM profile to its isolated loopback sidecar", () => {
    const env = {
      PUBLIC_BASE_URL: "https://work.example.com",
      HERMES_TCM_A2A_PROXY_ENABLED: "true",
      HERMES_TCM_A2A_PORT: "8900",
    };
    expect(resolveTrustedLocalProfileA2ATarget(
      "https://work.example.com/a2a/tcm-expert",
      env,
    )).toEqual({ url: "http://127.0.0.1:8900/", allowPrivate: true });
  });

  it("does not rewrite disabled, foreign-origin, or lookalike routes", () => {
    const enabled = {
      PUBLIC_BASE_URL: "https://work.example.com",
      HERMES_PPT_A2A_PROXY_ENABLED: "true",
    };
    const disabled = { ...enabled, HERMES_PPT_A2A_PROXY_ENABLED: "false" };
    for (const [url, env] of [
      ["https://work.example.com/a2a/ppt-expert", disabled],
      ["https://evil.example/a2a/ppt-expert", enabled],
      ["https://work.example.com/a2a/ppt-expert-evil", enabled],
    ] as const) {
      expect(resolveTrustedLocalProfileA2ATarget(url, env)).toEqual({
        url,
        allowPrivate: false,
      });
    }
  });
});
