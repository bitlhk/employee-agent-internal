import { describe, expect, it } from "vitest";
import {
  evaluateGovernance,
  governanceFingerprint,
  principalFingerprint,
  type GovernanceRequest,
  type RuntimePrincipal,
} from "./contracts";
import { resolveCustomMcpToolGovernance, customMcpPolicyAdapter } from "./custom-mcp-policy";
import { resolveRuntimePrincipal } from "./principal";

const principal: RuntimePrincipal = {
  userId: 7,
  adoptionId: "lgj-test",
  agentId: "jiuwen_lgj-test",
  roleTemplate: "wealth-manager",
  workspaceId: "/tmp/workspace",
  permissionProfile: "plus",
  sessionId: "session-1",
};

describe("governance core", () => {
  it("creates stable fingerprints independent of object key order", () => {
    expect(governanceFingerprint({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(governanceFingerprint({ a: { c: 3, d: 4 }, b: 2 }));
    expect(principalFingerprint(principal)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses the first policy adapter decision and emits evidence identifiers", async () => {
    const request: GovernanceRequest = {
      principal,
      operation: { capabilityId: "test", operation: "read", sideEffect: "read" },
    };
    const decision = await evaluateGovernance(request, [{
      id: "test-policy",
      evaluate: () => ({
        effect: "ALLOW",
        policyCode: "TEST_ALLOW",
        ruleVersion: "test-v1",
        reason: "allowed",
        obligations: [],
      }),
    }], {
      effect: "DENY",
      policyCode: "TEST_DENY",
      ruleVersion: "test-v1",
      reason: "denied",
      obligations: [],
    });
    expect(decision).toMatchObject({ effect: "ALLOW", policyCode: "TEST_ALLOW" });
    expect(decision.decisionId).toMatch(/^pdec_/);
    expect(decision.principalFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.operationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not silently replace a missing role with general-assistant", () => {
    const resolution = resolveRuntimePrincipal({
      adoption: {
        userId: 7,
        adoptId: "lgj-test",
        agentId: "jiuwen_lgj-test",
        roleTemplate: "",
        permissionProfile: "plus",
      },
    });
    expect(resolution.complete).toBe(false);
    expect(resolution.issues).toContain("roleTemplate");
    expect(resolution.principal.roleTemplate).toBe("");
  });

  it("allows annotated read-only Custom MCP tools and requires approval for ambiguous writes", async () => {
    const resolution = resolveRuntimePrincipal({
      adoption: {
        userId: 7,
        adoptId: "lgj-test",
        agentId: "jiuwen_lgj-test",
        roleTemplate: "wealth-manager",
        permissionProfile: "plus",
      },
    });
    const readProfile = resolveCustomMcpToolGovernance({
      name: "opaque_lookup",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
    const writeProfile = resolveCustomMcpToolGovernance({
      name: "opaque_action",
      inputSchema: { type: "object" },
    });
    expect(readProfile.sideEffect).toBe("read");
    expect(writeProfile.sideEffect).toBe("write");

    const readDecision = await evaluateGovernance({
      principal: resolution.principal,
      operation: { capabilityId: "custom.mcp", operation: "opaque_lookup", sideEffect: readProfile.sideEffect },
    }, [customMcpPolicyAdapter({ profile: readProfile, principal: resolution })], {
      effect: "DENY", policyCode: "FALLBACK", ruleVersion: "v1", reason: "fallback", obligations: [],
    });
    const writeDecision = await evaluateGovernance({
      principal: resolution.principal,
      operation: { capabilityId: "custom.mcp", operation: "opaque_action", sideEffect: writeProfile.sideEffect },
    }, [customMcpPolicyAdapter({ profile: writeProfile, principal: resolution })], {
      effect: "DENY", policyCode: "FALLBACK", ruleVersion: "v1", reason: "fallback", obligations: [],
    });
    expect(readDecision.effect).toBe("ALLOW");
    expect(writeDecision).toMatchObject({
      effect: "REQUIRE_APPROVAL",
      policyCode: "EA_CUSTOM_MCP_SIDE_EFFECT_APPROVAL_REQUIRED",
    });
  });
});
