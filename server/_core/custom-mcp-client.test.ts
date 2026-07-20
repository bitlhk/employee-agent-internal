import { describe, expect, it } from "vitest";
import {
  customMcpGatewayToolName,
  parseCustomMcpEndpoint,
  validateCustomMcpAuth,
} from "./custom-mcp-client";

describe("custom MCP client policy", () => {
  it("accepts only credential-free HTTPS endpoints", () => {
    expect(parseCustomMcpEndpoint("https://mcp.example.com/mcp#fragment").toString()).toBe("https://mcp.example.com/mcp");
    expect(() => parseCustomMcpEndpoint("http://mcp.example.com/mcp")).toThrow(/HTTPS/);
    expect(() => parseCustomMcpEndpoint("https://user:pass@mcp.example.com/mcp")).toThrow(/认证配置/);
    expect(() => parseCustomMcpEndpoint("https://mcp.example.com/mcp?api_key=secret")).toThrow(/明文凭据/);
    expect(() => parseCustomMcpEndpoint("file:///etc/passwd")).toThrow(/HTTPS/);
  });

  it("blocks identity and transport headers from API-key authentication", () => {
    expect(() => validateCustomMcpAuth({
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "api_key",
      authHeaderName: "X-Jiuwen-Channel-Id",
      credential: "secret",
    })).toThrow(/不允许/);
    expect(() => validateCustomMcpAuth({
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "bearer",
      credential: "",
    })).toThrow(/凭据/);
    expect(() => validateCustomMcpAuth({
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "api_key",
      authHeaderName: "X-API-Key",
      credential: "secret",
    })).not.toThrow();
  });

  it("builds stable, bounded gateway tool names scoped by connection", () => {
    const first = customMcpGatewayToolName(12, "customer/list all");
    const second = customMcpGatewayToolName(12, "customer/list all");
    expect(first).toBe(second);
    expect(first).toMatch(/^custom_12_customer_list_all_[a-f0-9]{8}$/);
    expect(customMcpGatewayToolName(13, "customer/list all")).not.toBe(first);
    expect(customMcpGatewayToolName(12, "x".repeat(500)).length).toBeLessThanOrEqual(128);
  });
});
