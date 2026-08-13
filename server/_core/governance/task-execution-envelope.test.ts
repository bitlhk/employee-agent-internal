import { describe, expect, it } from "vitest";
import { principalFingerprint, type RuntimePrincipalV2 } from "./contracts";
import {
  buildCapabilitySnapshot,
  buildTaskContextPack,
  buildTaskExecutionEnvelope,
} from "./task-execution-envelope";
import { evaluateWealthTaskReadiness, readinessCheck } from "./wealth-task-readiness";

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
      knowledge: { selectedAssets: [], eligibilityFingerprint: "k".repeat(64) },
      businessData: { sources: [] },
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
