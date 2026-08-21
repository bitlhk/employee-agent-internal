import { afterEach, describe, expect, it, vi } from "vitest";
import { scanMcpSourceSecurity } from "./mcp-security-scanner";

const fingerprint = "c".repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EA_MCP_SECURITY_SCANNER_TOKEN;
});

describe("MCP security scanner adapter", () => {
  it("normalizes SARIF and blocks on high severity findings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
      subjectFingerprint: fingerprint,
      scanner: { version: "0.2.0" },
      sarif: { runs: [{ results: [{
        ruleId: "MCP05",
        level: "error",
        message: { text: "命令注入" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "server.ts" }, region: { startLine: 20 } } }],
      }] }] },
    }), { status: 200 })));
    const result = await scanMcpSourceSecurity({ serverId: "mcp-test", file: Buffer.from("source"), fingerprint });
    expect(result).toMatchObject({ status: "completed", verdict: "block", scannerVersion: "0.2.0", summary: { high: 1 }, findings: [{ ruleId: "MCP05", severity: "high", file: "server.ts", startLine: 20 }] });
  });

  it("passes a scan with no findings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "completed", subjectFingerprint: fingerprint, sarif: { runs: [{ results: [] }] } }), { status: 200 })));
    const result = await scanMcpSourceSecurity({ serverId: "mcp-test", file: Buffer.from("source"), fingerprint });
    expect(result).toMatchObject({ status: "completed", verdict: "pass", summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } });
  });

  it("records service failures without throwing into the admin request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));
    const result = await scanMcpSourceSecurity({ serverId: "mcp-test", file: Buffer.from("source"), fingerprint });
    expect(result).toMatchObject({ status: "failed", verdict: "error", errorCode: "SCANNER_UNAVAILABLE" });
  });
});
