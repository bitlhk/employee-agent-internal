import { describe, expect, it } from "vitest";
import type { ContextReceiptV1 } from "@shared/context-receipt";
import { extractContextInteractionGrants, latestContextReceipt } from "./context-receipt";

const receipt: ContextReceiptV1 = {
  schema: "ea.context-receipt.v1",
  receiptId: "crpt_test",
  taskId: "WM-GT-03",
  taskLabel: "现行政策判断",
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
    reasons: [], remediation: [], presentation: { completed: ["回答"], unavailable: [], nextSteps: [] }, decisionFingerprint: "r".repeat(64),
  },
  createdAt: "2026-08-13T08:00:00.000Z",
  receiptFingerprint: "f".repeat(64),
};

describe("context receipt history parser", () => {
  it("restores a receipt from trusted platform metadata", () => {
    const result = JSON.stringify({ content: [{ type: "text", text: "ready" }], _meta: { eaContextReceipt: receipt } });
    expect(latestContextReceipt([{ name: "get_wealth_policy_basis", result }])).toEqual(receipt);
  });

  it("keeps interaction grants separate from the immutable receipt", () => {
    const grant = { schema: "ea.context-interaction-grant.v1", receiptId: "crpt_test", token: "signed-token", expiresAt: "2026-09-13T08:00:00.000Z" };
    const result = JSON.stringify({ content: [], _meta: { eaContextReceipt: receipt, eaInteractionGrant: grant } });
    expect(extractContextInteractionGrants([{ name: "get_wealth_policy_basis", result }]).get("crpt_test")).toEqual(grant);
    expect(JSON.stringify(receipt)).not.toContain("signed-token");
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
