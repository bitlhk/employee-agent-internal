import { describe, expect, it } from "vitest";
import { principalFingerprint, type RuntimePrincipalV2 } from "./contracts";
import { buildContextReceipt, buildContextReceiptFromEnvelope } from "./context-receipt";
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
  workspaceId: "/workspace/demo",
  permissionProfile: "plus",
  authorizationSnapshotId: "authz_demo",
  authorizationFingerprint: "a".repeat(64),
  sessionId: "session-demo",
  identityVersion: "2",
};

function envelope(taskId: "WM-GT-01" | "WM-GT-02" | "WM-GT-03") {
  const checks = taskId === "WM-GT-01"
    ? ["identity", "knowledge", "customerData", "skill", "evidence"]
    : taskId === "WM-GT-02"
      ? ["identity", "knowledge", "customerData", "productData", "policy", "skill", "evidence"]
      : ["identity", "knowledge", "policy", "evidence"];
  return buildTaskExecutionEnvelope({
    principal,
    context: buildTaskContextPack({
      knowledge: {
        selectedAssets: [{ assetId: "policy-current", version: "V2.2", contentHash: "b".repeat(64) }],
        eligibilityFingerprint: "c".repeat(64),
      },
      businessData: { sources: taskId === "WM-GT-03" ? [] : [{
        sourceSystem: "wealth_customer_mcp",
        entityRef: "customer-fingerprint",
        asOf: "2026-08-13T08:00:00.000Z",
        resultFingerprint: "d".repeat(64),
      }] },
      memory: { memoryRefs: [] },
      principalFingerprint: principalFingerprint(principal),
      assembledAt: "2026-08-13T08:00:00.000Z",
    }),
    readiness: evaluateWealthTaskReadiness({
      taskId,
      checks: Object.fromEntries(checks.map((name) => [name, readinessCheck("READY", `${name}_ready`, `${name} ready`)])),
    }),
    capabilitySnapshot: buildCapabilitySnapshot({
      capabilityIds: ["wealth_context"],
      capabilityVersions: { wealth_context: "1" },
      sideEffectProfiles: { wealth_context: "read" },
      policyBindings: { wealth_context: ["EA_KNOWLEDGE_ELIGIBILITY_V1"] },
      createdAt: "2026-08-13T08:00:00.000Z",
    }),
    releaseEvidence: {
      rolePackReleaseId: "linggan-bank.wealth-manager@1",
      evalSuiteVersion: "v1",
      verificationStatus: "verified",
      assetSetFingerprint: "e".repeat(64),
    },
    now: new Date("2026-08-13T08:00:00.000Z"),
  });
}

describe("Context Receipt V1", () => {
  it.each(["WM-GT-01", "WM-GT-02", "WM-GT-03"] as const)("binds %s to immutable provided and applied evidence", (taskId) => {
    const receipt = buildContextReceiptFromEnvelope({
      envelope: envelope(taskId),
      knowledgeLabels: [{ assetId: "policy-current", label: "现行制度 V2.2" }],
      policyDecisions: [{ policyCode: "EA_KNOWLEDGE_ELIGIBILITY_V1", ruleVersion: "v1", effect: "ALLOW" }],
      capabilityExecutions: [{ capabilityId: "wealth_context", operation: "prepare", status: "completed" }],
    });
    expect(receipt.taskId).toBe(taskId);
    expect(receipt.provided.knowledge[0]).toMatchObject({ label: "现行制度 V2.2", version: "V2.2" });
    expect(receipt.applied.policyDecisions[0].policyCode).toBe("EA_KNOWLEDGE_ELIGIBILITY_V1");
    expect(receipt.receiptFingerprint).toHaveLength(64);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("rejects citations that were not provided to the task", () => {
    expect(() => buildContextReceipt({
      taskId: "WM-GT-03",
      principalFingerprint: "p".repeat(64),
      provided: { knowledge: [], businessData: [], memory: [], capabilities: [] },
      citedKnowledgeAssetIds: ["not-provided"],
      readiness: {
        status: "READY",
        requestedOutcome: "answer",
        allowedOutcomes: ["answer"],
        deniedOutcomes: [],
        reasons: [],
        remediation: [],
        decisionFingerprint: "r".repeat(64),
      },
    })).toThrow(/subset/);
  });

  it("represents WM-GT-05 without retaining raw customer or tool arguments", () => {
    const receipt = buildContextReceipt({
      taskId: "WM-GT-05",
      principalFingerprint: "p".repeat(64),
      provided: {
        knowledge: [], businessData: [], memory: [],
        capabilities: [{ capabilityId: "demo_create_followup_task", label: "创建客户跟进任务（Demo）", version: "1", sideEffect: "write" }],
      },
      policyDecisions: [{ policyCode: "EA_ENTERPRISE_MCP_WRITE", ruleVersion: "v2", effect: "REQUIRE_APPROVAL" }],
      capabilityExecutions: [{
        capabilityId: "demo_create_followup_task",
        operation: "create_followup",
        status: "completed",
        requestId: "emcp_1",
        approvalId: "apr_1",
        externalRequestId: "DEMO-FOLLOWUP-1",
        idempotencyProtected: true,
      }],
      readiness: {
        status: "READY", requestedOutcome: "confirmed_business_followup_write",
        allowedOutcomes: ["confirmed_business_followup_write"], deniedOutcomes: [],
        reasons: [], remediation: [], decisionFingerprint: "r".repeat(64),
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("张先生");
    expect(receipt.applied.capabilityExecutions[0]).toMatchObject({
      approvalId: "apr_1",
      idempotencyProtected: true,
      externalRequestId: "DEMO-FOLLOWUP-1",
    });
  });
});
