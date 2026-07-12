import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "http";
import { readSafeAgentResponseText, safeAgentRequest, parseAgentEndpointUrl, selectAgentEndpointAddress } from "./safe-agent-http";

afterEach(() => {
  delete process.env.EA_AGENT_ENDPOINT_ALLOWLIST;
  delete process.env.EA_ALLOW_PRIVATE_AGENT_ENDPOINTS;
});

describe("safe Agent endpoint policy", () => {
  it("accepts HTTP(S) without embedded credentials", () => {
    expect(parseAgentEndpointUrl("https://agent.example.com/mcp").hostname).toBe("agent.example.com");
    expect(() => parseAgentEndpointUrl("file:///etc/passwd")).toThrow(/http or https/);
    expect(() => parseAgentEndpointUrl("https://user:pass@agent.example.com/mcp")).toThrow(/credentials/);
  });

  it("blocks private IPv4, IPv6, and mixed DNS answers", () => {
    const url = new URL("https://agent.example.com/mcp");
    for (const address of ["127.0.0.1", "10.0.0.1", "::1", "fc00::1", "::ffff:7f00:1"]) {
      expect(() => selectAgentEndpointAddress(url, [{ address, family: address.includes(":") ? 6 : 4 } as any], { allowlist: new Set() }))
        .toThrow(/private or local/);
    }
    expect(() => selectAgentEndpointAddress(url, [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ], { allowlist: new Set() })).toThrow(/private or local/);
  });

  it("allows an explicitly configured private endpoint only for that host", () => {
    const url = new URL("http://agent.internal.example/mcp");
    expect(selectAgentEndpointAddress(url, [{ address: "10.0.0.8", family: 4 }], {
      allowlist: new Set(["agent.internal.example"]),
    })).toEqual({ address: "10.0.0.8", family: 4 });
  });

  it("pins an allowlisted endpoint and rejects redirects", async () => {
    process.env.EA_AGENT_ENDPOINT_ALLOWLIST = "127.0.0.1";
    const server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    try {
      const response = await safeAgentRequest(`http://127.0.0.1:${address.port}/ok`);
      expect(await readSafeAgentResponseText(response)).toBe('{"ok":true}');
      await expect(safeAgentRequest(`http://127.0.0.1:${address.port}/redirect`)).rejects.toThrow(/redirects/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
