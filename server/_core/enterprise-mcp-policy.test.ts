import { describe, expect, it } from "vitest";
import {
  enterpriseMcpRoleAllowed,
  inferEnterpriseMcpToolPolicy,
  validateEnterpriseMcpConfig,
  validateEnterpriseMcpToolArguments,
  validateEnterpriseMcpToolPolicy,
} from "./enterprise-mcp-policy";

const validConfig = {
  serverId: "insurance_customer_profile",
  endpointUrl: "https://mcp.demo.linggan.top/insurance/customer-profile/mcp",
  resourceUri: "https://mcp.demo.linggan.top/insurance/customer-profile/mcp",
  healthUrl: null,
  authMode: "none_shadow" as const,
  lifecycleState: "shadow" as const,
  identityMode: "user" as const,
  dataClassification: "sensitive" as const,
  timeoutMs: 30_000,
};

describe("enterprise MCP policy", () => {
  it("accepts a canonical shadow connector", () => {
    expect(() => validateEnterpriseMcpConfig(validConfig)).not.toThrow();
  });

  it("prevents unauthenticated connectors from being enforced", () => {
    expect(() => validateEnterpriseMcpConfig({ ...validConfig, lifecycleState: "enforced" })).toThrow(/未鉴权/);
  });

  it("requires restricted data to use user identity", () => {
    expect(() => validateEnterpriseMcpConfig({
      ...validConfig,
      dataClassification: "restricted",
      identityMode: "tenant",
    })).toThrow(/用户身份/);
  });

  it("infers unknown save tools as disabled writes", () => {
    const policy = inferEnterpriseMcpToolPolicy("save_product");
    expect(policy.sideEffect).toBe("write");
    expect(policy.enabled).toBe(false);
    expect(policy.idempotencyRequired).toBe(true);
  });

  it("rejects non-idempotent write policies", () => {
    const policy = inferEnterpriseMcpToolPolicy("save_product");
    expect(() => validateEnterpriseMcpToolPolicy({ ...policy, idempotencyRequired: false })).toThrow(/幂等/);
  });

  it("enforces role and argument constraints", () => {
    const policy = {
      ...inferEnterpriseMcpToolPolicy("list_customer_profiles"),
      allowedRoles: ["insurance-advisor"],
      argumentPolicyJson: { requiredFields: ["name"], blockedFields: ["password"] },
    };
    expect(enterpriseMcpRoleAllowed(policy, "insurance-advisor")).toBe(true);
    expect(enterpriseMcpRoleAllowed(policy, "general-assistant")).toBe(false);
    expect(() => validateEnterpriseMcpToolArguments(policy, {})).toThrow(/name/);
    expect(() => validateEnterpriseMcpToolArguments(policy, { name: "Alice", password: "secret" })).toThrow(/password/);
    expect(() => validateEnterpriseMcpToolArguments(policy, { name: "Alice" })).not.toThrow();
  });
});
