import { afterEach, describe, expect, it } from "vitest";
import {
  injectInstallerTelemetry,
  publicInstallEventSchema,
  resolveInstallTelemetryEndpoint,
} from "./install-telemetry";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("installer telemetry", () => {
  it("accepts the anonymous lifecycle event envelope", () => {
    const result = publicInstallEventSchema.safeParse({
      installId: "47d81d65-f81a-4b36-b595-2ce0b25b41ea",
      eventType: "succeeded",
      stage: "complete",
      source: "official",
      installerVersion: "2026.07.14.1",
      osType: "ubuntu",
      arch: "x86_64",
      mirror: "cn",
      durationMs: 120_000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects server-owned download events and unknown fields", () => {
    expect(publicInstallEventSchema.safeParse({
      installId: "47d81d65-f81a-4b36-b595-2ce0b25b41ea",
      eventType: "downloaded",
    }).success).toBe(false);
    expect(publicInstallEventSchema.safeParse({
      installId: "47d81d65-f81a-4b36-b595-2ce0b25b41ea",
      eventType: "started",
      hostname: "private-host",
    }).success).toBe(false);
  });

  it("injects tracking values immediately after the shebang", () => {
    const result = injectInstallerTelemetry("#!/usr/bin/env bash\nset -euo pipefail\n", {
      installId: "47d81d65-f81a-4b36-b595-2ce0b25b41ea",
      endpoint: "https://example.com/api/public/install-events",
      source: "official",
    });
    expect(result).toMatch(/^#!\/usr\/bin\/env bash\nEMPLOYEE_AGENT_INSTALL_ID=/);
    expect(result).toContain("EMPLOYEE_AGENT_INSTALL_TELEMETRY_ENDPOINT='https://example.com/api/public/install-events'");
    expect(result).toContain("\nset -euo pipefail\n");
  });

  it("requires HTTPS telemetry outside development loopback", () => {
    process.env.NODE_ENV = "production";
    process.env.EMPLOYEE_AGENT_INSTALL_TELEMETRY_ENDPOINT = "http://example.com/events";
    expect(resolveInstallTelemetryEndpoint()).toBeNull();

    process.env.EMPLOYEE_AGENT_INSTALL_TELEMETRY_ENDPOINT = "https://example.com/events";
    expect(resolveInstallTelemetryEndpoint()).toBe("https://example.com/events");
  });
});
