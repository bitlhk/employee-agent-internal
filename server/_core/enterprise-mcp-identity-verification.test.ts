import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  issue: vi.fn(),
  identityStatus: vi.fn(),
}));

vi.mock("./custom-mcp-client", () => ({
  discoverCustomMcpTools: mocks.discover,
}));

vi.mock("./enterprise-mcp-identity", () => ({
  enterpriseMcpIdentityStatus: mocks.identityStatus,
  issueEnterpriseMcpAccessToken: mocks.issue,
}));

import { verifyEnterpriseMcpIdentityEnforcement } from "./enterprise-mcp-identity-verification";

const connection = {
  serverId: "insurance_customer_profile",
  endpointUrl: "https://mcp.example.com/insurance/customer-profile/mcp",
  resourceUri: "https://mcp.example.com/insurance/customer-profile/mcp",
  authMode: "oauth2_access_token" as const,
  timeoutMs: 30_000,
};

const caller = {
  userId: 7,
  organization: "Example Bank",
  adoptId: "lgj-admin-probe",
  agentId: "employee-agent-admin",
  roleKey: "platform-admin",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.identityStatus.mockResolvedValue({ configured: true });
  mocks.issue.mockImplementation(async (input: { resourceUri: string; toolName: string; scopes: string[] }) => ({
    token: input.resourceUri.includes("invalid_audience")
      ? "wrong-audience"
      : input.toolName !== "tools/list"
        ? "wrong-tool"
        : input.scopes.length === 0
          ? "missing-scope"
          : "valid",
  }));
  mocks.discover.mockImplementation(async (config: { credential?: string }) => {
    if (config.credential !== "valid") throw new Error("401 unauthorized");
    return [{ name: "list_customer_profiles", description: "read", inputSchema: { type: "object" } }];
  });
});

describe("enterprise MCP identity enforcement verification", () => {
  it("passes only when valid identity works and all negative probes are rejected", async () => {
    const result = await verifyEnterpriseMcpIdentityEnforcement({ connection, caller });
    expect(result.passed).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.checks.map(check => [check.code, check.passed])).toEqual([
      ["valid_token", true],
      ["missing_token", true],
      ["wrong_audience", true],
      ["missing_scope", true],
      ["wrong_tool", true],
    ]);
  });

  it("fails when the service accepts a request without a token", async () => {
    mocks.discover.mockImplementation(async (config: { credential?: string }) => {
      if (["valid", undefined].includes(config.credential)) {
        return [{ name: "list_customer_profiles", description: "read", inputSchema: { type: "object" } }];
      }
      throw new Error("401 unauthorized");
    });
    const result = await verifyEnterpriseMcpIdentityEnforcement({ connection, caller });
    expect(result.passed).toBe(false);
    expect(result.checks.find(check => check.code === "missing_token")).toMatchObject({ passed: false });
  });

  it("fails closed when the platform signer is unavailable", async () => {
    mocks.identityStatus.mockResolvedValue({ configured: false });
    await expect(verifyEnterpriseMcpIdentityEnforcement({ connection, caller })).rejects.toThrow(/短期令牌签发尚未启用/);
    expect(mocks.discover).not.toHaveBeenCalled();
  });
});
