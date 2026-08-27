import { describe, expect, it } from "vitest";
import type { ContextReceiptV1 } from "@shared/context-receipt";
import { contextReceiptDisplayEntries } from "./context-receipt-display";

function receipt(taskId: string, taskLabel: string, logicalAssetId?: string, asOf = "2026-08-27T02:00:00.000Z"): ContextReceiptV1 {
  const businessData = logicalAssetId ? [{
    sourceSystem: "customer_context",
    label: "统一客户数据服务",
    entityRef: logicalAssetId,
    asOf,
    resultFingerprint: `${taskId}:result`,
    logicalAssetId,
    providerType: "mcp" as const,
  }] : [];
  return {
    schema: "ea.context-receipt.v1",
    receiptId: `receipt:${taskId}:${asOf}`,
    taskId,
    taskLabel,
    principalFingerprint: "principal",
    effectiveContextSnapshot: {
      capturedAt: asOf,
      items: businessData.map((item) => ({
        contextType: "business_data" as const,
        logicalAssetId: item.logicalAssetId,
        assetId: item.entityRef,
        version: "current",
        asOf: item.asOf,
      })),
      snapshotFingerprint: `snapshot:${taskId}`,
    },
    provided: { knowledge: [], businessData, memory: [], capabilities: [] },
    cited: { knowledgeAssetIds: [] },
    applied: { policyDecisions: [], capabilityExecutions: [] },
    excluded: [],
    readiness: {
      status: "READY",
      requestedOutcome: taskId,
      allowedOutcomes: [taskId],
      deniedOutcomes: [],
      reasons: [],
      remediation: [],
      presentation: { completed: [], unavailable: [], nextSteps: [] },
      decisionFingerprint: `decision:${taskId}`,
    },
    createdAt: asOf,
    receiptFingerprint: `fingerprint:${taskId}`,
  };
}

describe("context receipt business display", () => {
  it("compacts invocation-level customer receipts into one business stage", () => {
    const entries = contextReceiptDisplayEntries([
      receipt("CUSTOMER-CONTEXT-customer_directory", "统一客户数据服务", "customer_directory"),
      receipt("WM-GT-03", "现行政策判断"),
      receipt("CUSTOMER-PROFILE-SHADOW", "Governed Customer Profile Projection", "customer_profile"),
      receipt("CUSTOMER-CONTEXT-customer_portfolio", "统一客户数据服务", "customer_portfolio", "2026-08-27T02:01:00.000Z"),
      receipt("CUSTOMER-CONTEXT-customer_portfolio", "统一客户数据服务", "customer_portfolio", "2026-08-27T02:02:00.000Z"),
      receipt("WM-GT-02", "资产配置建议"),
    ]);

    expect(entries.map((entry) => entry.receipt.taskLabel)).toEqual([
      "客户信息核验",
      "现行政策判断",
      "资产配置建议",
    ]);
    expect(entries[0].sourceReceipts).toHaveLength(4);
    expect(entries[0].receipt.provided.businessData.map((item) => item.label)).toEqual([
      "授权客户范围",
      "客户画像",
      "客户持仓",
    ]);
    expect(entries[0].receipt.provided.businessData.at(-1)?.asOf).toBe("2026-08-27T02:02:00.000Z");
  });

  it("does not alter a single receipt", () => {
    const source = receipt("WM-GT-03", "现行政策判断");
    expect(contextReceiptDisplayEntries([source])).toEqual([{ key: source.receiptId, receipt: source, sourceReceipts: [source] }]);
  });
});
