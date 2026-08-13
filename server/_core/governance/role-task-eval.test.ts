import { describe, expect, it } from "vitest";
import type { EnterpriseMcpToolPolicyDraft } from "../enterprise-mcp-policy";
import { resolveToolGovernance } from "../tool-governance";
import { customMcpPolicyAdapter, resolveCustomMcpToolGovernance } from "./custom-mcp-policy";
import { evaluateDelegationPolicy } from "./delegation-policy";
import { enterpriseMcpPolicyAdapter } from "./enterprise-mcp-policy-adapter";
import { evaluateGovernance } from "./contracts";
import { platformMcpPolicyAdapter } from "./platform-mcp-policy";
import { resolveRuntimePrincipal } from "./principal";

function principal(permissionProfile = "plus") {
  return resolveRuntimePrincipal({
    adoption: {
      userId: 7,
      adoptId: "lgj-governance-eval",
      agentId: "jiuwen_lgj-governance-eval",
      roleTemplate: "wealth-manager",
      permissionProfile,
    },
    sessionId: "eval-session",
  });
}

const enterpriseWritePolicy: EnterpriseMcpToolPolicyDraft = {
  toolName: "update_customer",
  enabled: true,
  sideEffect: "write",
  requiredScopes: ["customer.write"],
  allowedRoles: ["wealth-manager"],
  identityModeOverride: "user",
  approvalMode: "always",
  auditLevel: "strong",
  idempotencyRequired: true,
  argumentPolicyJson: null,
};

describe("role task governance eval", () => {
  it("keeps normal read work available without approval", async () => {
    const resolved = principal();
    const profile = resolveCustomMcpToolGovernance({
      name: "query_customer",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
    const result = await evaluateGovernance({
      principal: resolved.principal,
      operation: { capabilityId: "custom.mcp", operation: "query_customer", sideEffect: "read" },
    }, [customMcpPolicyAdapter({ profile, principal: resolved, runtimeAttested: false })], {
      effect: "DENY", policyCode: "FALLBACK", ruleVersion: "eval", reason: "fallback", obligations: [],
    });
    expect(result.effect).toBe("ALLOW");
  });

  it("denies business writes from an unattested runtime", async () => {
    const resolved = principal();
    const profile = resolveToolGovernance("create_scheduled_task");
    const result = await evaluateGovernance({
      principal: resolved.principal,
      operation: { capabilityId: "platform.mcp", operation: profile.tool, sideEffect: profile.sideEffect },
    }, [platformMcpPolicyAdapter({ knownTool: true, profile, principal: resolved, runtimeAttested: false })], {
      effect: "DENY", policyCode: "FALLBACK", ruleVersion: "eval", reason: "fallback", obligations: [],
    });
    expect(result).toMatchObject({
      effect: "DENY",
      policyCode: "EA_RUNTIME_GOVERNANCE_ATTESTATION_REQUIRED",
    });
  });

  it("requires approval and idempotency for an attested enterprise write", async () => {
    const resolved = principal();
    const result = await evaluateGovernance({
      principal: resolved.principal,
      operation: { capabilityId: "enterprise.mcp", operation: "update_customer", sideEffect: "write" },
    }, [enterpriseMcpPolicyAdapter({
      policy: enterpriseWritePolicy,
      principal: resolved,
      runtimeAttested: true,
    })], {
      effect: "DENY", policyCode: "FALLBACK", ruleVersion: "eval", reason: "fallback", obligations: [],
    });
    expect(result.effect).toBe("REQUIRE_APPROVAL");
    expect(result.obligations).toEqual(expect.arrayContaining([
      { type: "APPROVAL", mode: "always" },
      { type: "IDEMPOTENCY_KEY" },
    ]));
  });

  it("never lets delegation expand a starter parent into external-send authority", async () => {
    const result = await evaluateDelegationPolicy({
      principal: principal("starter").principal,
      childCapabilityIds: ["stock-analysis"],
      endpointConfig: {
        governanceAttested: true,
        delegationScope: { sideEffects: ["read", "compute", "external_send"] },
      },
      requestedScope: {
        capabilityIds: ["stock-analysis"],
        sideEffects: ["external_send"],
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.effectiveScope.sideEffects).not.toContain("external_send");
  });

  it("allows a plus parent to delegate analysis while retaining side effects locally", async () => {
    const result = await evaluateDelegationPolicy({
      principal: principal("plus").principal,
      childCapabilityIds: ["stock-analysis", "web-research"],
      endpointConfig: {
        governanceAttested: true,
        delegationScope: { sideEffects: ["read", "compute", "external_send", "admin_action"] },
      },
      requestedScope: {
        capabilityIds: ["stock-analysis"],
        sideEffects: ["read", "external_send", "admin_action"],
      },
    });
    expect(result.allowed).toBe(true);
    expect(result.effectiveScope).toEqual({
      capabilityIds: ["stock-analysis"],
      sideEffects: ["read"],
    });
  });

  it("fails closed for an unknown platform capability", async () => {
    const resolved = principal();
    const profile = resolveToolGovernance("unknown_mutation");
    const result = await evaluateGovernance({
      principal: resolved.principal,
      operation: { capabilityId: "platform.mcp", operation: profile.tool, sideEffect: profile.sideEffect },
    }, [platformMcpPolicyAdapter({ knownTool: false, profile, principal: resolved, runtimeAttested: true })], {
      effect: "DENY", policyCode: "FALLBACK", ruleVersion: "eval", reason: "fallback", obligations: [],
    });
    expect(result).toMatchObject({ effect: "DENY", policyCode: "EA_PLATFORM_MCP_TOOL_UNKNOWN" });
  });
});
