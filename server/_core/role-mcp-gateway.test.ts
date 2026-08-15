import { describe, expect, it } from "vitest";
import {
  normalizeTrustedRuntimeMcpConfig,
  roleMcpGatewayToolName,
  roleMcpToolIsSafe,
} from "./role-mcp-gateway";

describe("role MCP gateway", () => {
  it("keeps exposed tool names deterministic without revealing server ids", () => {
    const first = roleMcpGatewayToolName("bond_quote_parse", "bond_parse_schema");
    const second = roleMcpGatewayToolName("bond_quote_parse", "bond_parse_schema");
    expect(first).toBe(second);
    expect(first).toMatch(/^role_[a-f0-9]{8}_bond_parse_schema_[a-f0-9]{8}$/);
    expect(first).not.toContain("bond_quote_parse");
  });

  it("allows reads and unambiguous compute tools but rejects business writes", () => {
    expect(roleMcpToolIsSafe({
      name: "list_bonds",
      description: "",
      inputSchema: { type: "object" },
    })).toBe(true);
    expect(roleMcpToolIsSafe({
      name: "bond_parse_validate",
      description: "",
      inputSchema: { type: "object" },
    })).toBe(true);
    for (const name of [
      "credential-prompt-generator",
      "image-classification",
      "credential-extractor",
      "locate-field",
      "credential_image_extract_from_workspace",
    ]) {
      expect(roleMcpToolIsSafe({
        name,
        description: "",
        inputSchema: { type: "object" },
      })).toBe(true);
    }
    expect(roleMcpToolIsSafe({
      name: "update_customer",
      description: "",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    })).toBe(false);
    expect(roleMcpToolIsSafe({
      name: "sync-prompt",
      description: "",
      inputSchema: { type: "object" },
    })).toBe(false);
  });

  it("accepts only configured URL transports and expands server-owned headers", () => {
    process.env.TEST_ROLE_MCP_TOKEN = "token-value";
    expect(normalizeTrustedRuntimeMcpConfig({
      type: "streamableHttp",
      url: "http://127.0.0.1:17892/mcp",
      headers: { Authorization: "Bearer ${TEST_ROLE_MCP_TOKEN}" },
    })).toEqual({
      endpointUrl: "http://127.0.0.1:17892/mcp",
      headers: { Authorization: "Bearer token-value" },
      timeoutMs: 60_000,
    });
    expect(normalizeTrustedRuntimeMcpConfig({ command: "python", args: ["server.py"] })).toBeNull();
  });
});
