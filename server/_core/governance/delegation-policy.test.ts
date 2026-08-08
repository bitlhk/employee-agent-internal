import { describe, expect, it } from "vitest";
import { evaluateDelegationPolicy } from "./delegation-policy";
import type { RuntimePrincipal } from "./contracts";

const plusPrincipal: RuntimePrincipal = {
  userId: 1,
  adoptionId: "lgj-owner",
  agentId: "runtime-1",
  roleTemplate: "wealth-manager",
  workspaceId: "/tmp/workspace",
  permissionProfile: "plus",
  sessionId: "session-1",
};

describe("delegation policy", () => {
  it("allows analysis delegation without expanding child authority", async () => {
    const result = await evaluateDelegationPolicy({
      principal: plusPrincipal,
      childCapabilityIds: ["research", "report"],
      endpointConfig: {
        governanceAttested: true,
        delegationScope: { sideEffects: ["read", "compute", "write"] },
      },
      requestedScope: { capabilityIds: ["research"], sideEffects: ["read", "write"] },
    });
    expect(result.allowed).toBe(true);
    expect(result.effectiveScope).toEqual({ capabilityIds: ["research"], sideEffects: ["read"] });
  });

  it("denies delegation from a starter principal", async () => {
    const result = await evaluateDelegationPolicy({
      principal: { ...plusPrincipal, permissionProfile: "starter" },
      childCapabilityIds: ["research"],
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.policyCode).toBe("EA_DELEGATION_SCOPE_DENIED");
  });

  it("strips elevated child effects without child governance attestation", async () => {
    const result = await evaluateDelegationPolicy({
      principal: plusPrincipal,
      childCapabilityIds: ["research"],
      endpointConfig: { delegationScope: { sideEffects: ["read", "write"] } },
    });
    expect(result.allowed).toBe(true);
    expect(result.effectiveScope.sideEffects).toEqual(["read"]);
  });

  it("intersects parent, child and task resource scopes", async () => {
    const result = await evaluateDelegationPolicy({
      principal: {
        ...plusPrincipal,
        delegationScope: {
          capabilityIds: ["research"],
          sideEffects: ["read", "external_send"],
          resourcePatterns: ["customer:shanghai:*"],
        },
      },
      childCapabilityIds: ["research", "report"],
      endpointConfig: {
        governanceAttested: true,
        delegationScope: {
          capabilityIds: ["research"],
          sideEffects: ["read", "external_send"],
          resourcePatterns: ["customer:shanghai:vip:*"],
        },
      },
      requestedScope: {
        capabilityIds: ["research"],
        sideEffects: ["read"],
        resourcePatterns: ["customer:shanghai:vip:1001"],
      },
    });
    expect(result.allowed).toBe(true);
    expect(result.effectiveScope.resourcePatterns).toEqual(["customer:shanghai:vip:1001"]);
  });

  it("denies delegation when requested resources exceed the available intersection", async () => {
    const result = await evaluateDelegationPolicy({
      principal: {
        ...plusPrincipal,
        delegationScope: {
          capabilityIds: ["research"],
          sideEffects: ["read", "external_send"],
          resourcePatterns: ["customer:shanghai:*"],
        },
      },
      childCapabilityIds: ["research"],
      endpointConfig: {
        governanceAttested: true,
        delegationScope: {
          sideEffects: ["read", "external_send"],
          resourcePatterns: ["customer:shanghai:*"],
        },
      },
      requestedScope: {
        capabilityIds: ["research"],
        sideEffects: ["read"],
        resourcePatterns: ["customer:beijing:1001"],
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.reason).toContain("No resource remains");
  });

  it("denies delegation when configured and advertised child capabilities do not overlap", async () => {
    const result = await evaluateDelegationPolicy({
      principal: plusPrincipal,
      childCapabilityIds: ["research"],
      endpointConfig: {
        governanceAttested: true,
        delegationScope: {
          capabilityIds: ["customer-write"],
          sideEffects: ["read", "external_send"],
        },
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.effectiveScope.capabilityIds).toEqual([]);
  });
});
