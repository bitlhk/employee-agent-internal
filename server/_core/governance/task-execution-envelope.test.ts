import { describe, expect, it } from "vitest";
import { principalFingerprint, type RuntimePrincipalV2 } from "./contracts";
import {
  buildCapabilitySnapshot,
  buildTaskContextPack,
  buildTaskExecutionEnvelope,
} from "./task-execution-envelope";
import { evaluateWealthTaskReadiness, readinessCheck, wealthPolicyKnowledgeReadiness } from "./wealth-task-readiness";

const principal: RuntimePrincipalV2 = {
  tenantId: "tn_demo",
  organizationId: "org_demo",
  userId: 7,
  adoptionId: "lgj-demo",
  agentId: "agent-demo",
  roleTemplate: "wealth-manager",
  workspaceId: "/tmp/workspace",
  permissionProfile: "plus",
  authorizationSnapshotId: "authz_demo",
  authorizationFingerprint: "a".repeat(64),
  sessionId: "session-demo",
  identityVersion: "2",
};

function readyChecks(names: string[]) {
  return Object.fromEntries(names.map((name) => [name, readinessCheck("READY", `${name.toUpperCase()}_READY`, `${name} 已就绪。`)]));
}

describe("task execution envelope", () => {
  it("binds an immutable context and capability snapshot to Principal V2", () => {
    const readiness = evaluateWealthTaskReadiness({
      taskId: "WM-GT-03",
      checks: readyChecks(["identity", "knowledge", "policy", "evidence"]),
    });
    const context = buildTaskContextPack({
      knowledge: { selectedAssets: [{
        assetId: "wealth-policy",
        version: "V3.2",
        contentHash: "k".repeat(64),
        logicalAssetId: "current_wealth_policy",
        effectiveAt: "2026-07-01T00:00:00.000Z",
      }], eligibilityFingerprint: "k".repeat(64) },
      businessData: { sources: [{
        sourceSystem: "crm",
        entityRef: "customer-7",
        asOf: "2026-08-13T00:00:00.000Z",
        resultFingerprint: "d".repeat(64),
        logicalAssetId: "customer_profile",
      }] },
      memory: { memoryRefs: [] },
      principalFingerprint: principalFingerprint(principal),
      assembledAt: "2026-08-13T00:00:00.000Z",
    });
    const envelope = buildTaskExecutionEnvelope({
      principal,
      context,
      readiness,
      capabilitySnapshot: buildCapabilitySnapshot({
        capabilityIds: ["get_wealth_policy_basis"],
        capabilityVersions: { get_wealth_policy_basis: "1" },
        sideEffectProfiles: { get_wealth_policy_basis: "read" },
        policyBindings: { get_wealth_policy_basis: ["EA_KNOWLEDGE_ELIGIBILITY_V1"] },
        createdAt: "2026-08-13T00:00:00.000Z",
      }),
      releaseEvidence: {
        rolePackReleaseId: "linggan-bank.wealth-manager@1",
        evalSuiteVersion: "v1",
        verificationStatus: "unverified",
        assetSetFingerprint: "r".repeat(64),
      },
      correlationId: "corr-demo",
      now: new Date("2026-08-13T00:00:00.000Z"),
    });

    expect(envelope.readiness.status).toBe("READY");
    expect(envelope.context).not.toHaveProperty("principal");
    expect(envelope.context.effectiveContextSnapshot.items).toEqual([
      expect.objectContaining({ contextType: "business_data", logicalAssetId: "customer_profile" }),
      expect.objectContaining({ contextType: "knowledge", logicalAssetId: "current_wealth_policy", version: "V3.2", effectiveAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(envelope.context.effectiveContextSnapshot.snapshotFingerprint).toHaveLength(64);
    expect(envelope.envelopeFingerprint).toHaveLength(64);
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it("rejects a context assembled for a different principal", () => {
    const context = buildTaskContextPack({
      knowledge: { selectedAssets: [], eligibilityFingerprint: "" },
      businessData: { sources: [] },
      memory: { memoryRefs: [] },
      principalFingerprint: "wrong",
      assembledAt: "2026-08-13T00:00:00.000Z",
    });
    expect(() => buildTaskExecutionEnvelope({
      principal,
      context,
      readiness: evaluateWealthTaskReadiness({ taskId: "WM-GT-03", checks: {} }),
      capabilitySnapshot: buildCapabilitySnapshot({ capabilityIds: [], capabilityVersions: {}, sideEffectProfiles: {}, policyBindings: {} }),
      releaseEvidence: { rolePackReleaseId: "test", evalSuiteVersion: "v1", verificationStatus: "unverified", assetSetFingerprint: "" },
    })).toThrow(/principal binding/);
  });

  it("returns allowed fallbacks instead of treating degraded work as a generic error", () => {
    const decision = evaluateWealthTaskReadiness({
      taskId: "WM-GT-01",
      checks: {
        ...readyChecks(["identity", "knowledge", "skill", "evidence"]),
        customerData: readinessCheck("DEGRADED", "CUSTOMER_DATA_UNAVAILABLE", "客户数据暂时不可用。", { retryable: true }),
      },
    });
    expect(decision.status).toBe("DEGRADED");
    expect(decision.deniedOutcomes).toContain("customer_specific_previsit_brief");
    expect(decision.allowedOutcomes).toContain("generic_previsit_checklist");
  });

  it("does not deny wealth candidates when only optional knowledge context is missing", () => {
    const decision = evaluateWealthTaskReadiness({
      taskId: "WM-GT-02",
      checks: {
        ...readyChecks(["identity", "customerData", "productData", "policy", "skill", "evidence"]),
        knowledge: wealthPolicyKnowledgeReadiness({ policyReady: true, resolutionStatus: "DEGRADED" }),
      },
    });
    expect(decision.status).toBe("READY");
    expect(decision.allowedOutcomes).toContain("governed_asset_allocation_candidates");
    expect(decision.deniedOutcomes).toEqual([]);
    expect(decision.checks.knowledge.code).toBe("CURRENT_POLICY_READY_OPTIONAL_CONTEXT_MISSING");
  });

  it("still blocks wealth candidates when a required knowledge binding is missing", () => {
    expect(wealthPolicyKnowledgeReadiness({ policyReady: true, resolutionStatus: "BLOCKED" })).toMatchObject({
      status: "BLOCKED",
      code: "REQUIRED_CONTEXT_BINDING_MISSING",
    });
  });

  it("defines fail-closed readiness contracts for all six wealth benchmark tasks", () => {
    const taskIds = ["WM-GT-01", "WM-GT-02", "WM-GT-03", "WM-GT-04", "WM-GT-05", "WM-GT-06"] as const;
    for (const taskId of taskIds) {
      const decision = evaluateWealthTaskReadiness({ taskId, checks: {} });
      expect(decision.status).toBe("BLOCKED");
      expect(decision.deniedOutcomes).toHaveLength(1);
      expect(decision.fallbackOutcomes.length).toBeGreaterThan(0);
    }
  });
});
