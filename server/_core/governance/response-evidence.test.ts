import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextReceiptV1 } from "../../../shared/context-receipt";

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("../audit-events", () => ({ recordAuditRequired: mocks.audit }));

import { buildResponseEvidence, extractTrustedContextReceipt, persistResponseEvidence } from "./response-evidence";

function receipt(id: string, taskId: string, createdAt: string): ContextReceiptV1 {
  return {
    schema: "ea.context-receipt.v1",
    receiptId: id,
    taskId,
    taskLabel: taskId === "WM-GT-01" ? "客户访前准备" : "客户跟进创建",
    envelopeId: `env_${id}`,
    correlationId: "corr_task",
    principalFingerprint: "p".repeat(64),
    provided: { knowledge: [], businessData: [], memory: [], capabilities: [] },
    cited: { knowledgeAssetIds: [] },
    applied: { policyDecisions: [], capabilityExecutions: [] },
    excluded: [],
    readiness: {
      status: "READY",
      requestedOutcome: "answer",
      allowedOutcomes: ["answer"],
      deniedOutcomes: [],
      reasons: [],
      remediation: [],
      presentation: { completed: ["完成"], unavailable: [], nextSteps: [] },
      decisionFingerprint: "d".repeat(64),
    },
    createdAt,
    receiptFingerprint: "f".repeat(64),
  };
}

describe("response evidence", () => {
  beforeEach(() => mocks.audit.mockReset().mockResolvedValue({ id: 1 }));

  it("accepts receipt metadata only from controlled platform and enterprise tools", () => {
    const value = { _meta: { eaContextReceipt: receipt("r1", "WM-GT-01", "2026-08-13T08:00:00.000Z") } };
    expect(extractTrustedContextReceipt("prepare_wealth_previsit_context", value)?.receiptId).toBe("r1");
    expect(extractTrustedContextReceipt("enterprise_abcd_tool_1234", value)?.receiptId).toBe("r1");
    expect(extractTrustedContextReceipt("custom_remote_tool", value)).toBeNull();
  });

  it("links stage receipts without copying their bodies and binds final citations", async () => {
    const evidence = buildResponseEvidence({
      receipts: [
        receipt("r2", "WM-GT-05", "2026-08-13T08:02:00.000Z"),
        receipt("r1", "WM-GT-01", "2026-08-13T08:01:00.000Z"),
      ],
      correlationId: "corr_task",
      assistantMessageId: "msg_1",
      responseText: "已完成访前简报。[知识1]",
      citedKnowledgeSources: [{ index: 1, documentId: "doc_v22", documentName: "现行制度", documentVersion: "V2.2" }],
      now: new Date("2026-08-13T08:03:00.000Z"),
    });
    expect(evidence?.receiptBundle.stages.map((stage) => stage.receiptId)).toEqual(["r1", "r2"]);
    expect(JSON.stringify(evidence?.receiptBundle)).not.toContain("principalFingerprint");
    expect(evidence?.citedKnowledge).toEqual([{ documentId: "doc_v22", documentName: "现行制度", documentVersion: "V2.2" }]);
    await persistResponseEvidence({
      evidence: evidence!, userId: 7, adoptId: "lgj-test", roleTemplate: "wealth-manager",
      agentId: "agent-test", sessionId: "session-test",
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "context.response_evidence.finalized",
      targetId: "msg_1",
      metadata: { responseEvidence: evidence },
    }));
  });
});
