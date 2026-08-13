import { describe, expect, it } from "vitest";
import type { ContextReceiptV1 } from "@shared/context-receipt";
import { latestContextReceipt } from "./context-receipt";

const receipt: ContextReceiptV1 = {
  schema: "ea.context-receipt.v1",
  receiptId: "crpt_test",
  taskId: "WM-GT-03",
  principalFingerprint: "p".repeat(64),
  provided: {
    knowledge: [{ assetId: "policy-v22", label: "现行制度 V2.2", version: "V2.2", contentHash: "h".repeat(64) }],
    businessData: [], memory: [], capabilities: [],
  },
  cited: { knowledgeAssetIds: [] },
  applied: { policyDecisions: [], capabilityExecutions: [] },
  excluded: [],
  readiness: {
    status: "READY", requestedOutcome: "answer", allowedOutcomes: ["answer"], deniedOutcomes: [],
    reasons: [], remediation: [], decisionFingerprint: "r".repeat(64),
  },
  createdAt: "2026-08-13T08:00:00.000Z",
  receiptFingerprint: "f".repeat(64),
};

describe("context receipt history parser", () => {
  it("restores a receipt from a prefixed platform tool result", () => {
    const result = `EA_WEALTH_POLICY_BASIS:${JSON.stringify({ status: "ready", contextReceipt: receipt })}`;
    expect(latestContextReceipt([{ name: "get_wealth_policy_basis", result }])).toEqual(receipt);
  });

  it("restores a receipt from enterprise MCP _meta", () => {
    const result = JSON.stringify({ content: [{ type: "text", text: "ok" }], _meta: { eaContextReceipt: receipt } });
    expect(latestContextReceipt([{ name: "enterprise_abcd_demo_create_followup_task_1234", result }])?.receiptId).toBe("crpt_test");
  });

  it("does not trust receipt-shaped metadata from an arbitrary remote tool", () => {
    const result = JSON.stringify({ content: [], _meta: { eaContextReceipt: receipt } });
    expect(latestContextReceipt([{ name: "custom_remote_tool", result }])).toBeNull();
  });
});
