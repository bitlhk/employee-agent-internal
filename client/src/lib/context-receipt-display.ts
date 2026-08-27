import type { ContextReceiptV1 } from "@shared/context-receipt";

export type ContextReceiptDisplayEntry = {
  key: string;
  receipt: ContextReceiptV1;
  sourceReceipts: ContextReceiptV1[];
};

const CUSTOMER_TASK_PREFIXES = ["CUSTOMER-CONTEXT-", "CUSTOMER-PROFILE-"];

function isCustomerVerificationReceipt(receipt: ContextReceiptV1): boolean {
  return CUSTOMER_TASK_PREFIXES.some((prefix) => receipt.taskId.startsWith(prefix));
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function latestBusinessData(receipts: ContextReceiptV1[]): ContextReceiptV1["provided"]["businessData"] {
  const byLogicalAsset = new Map<string, ContextReceiptV1["provided"]["businessData"][number]>();
  for (const item of receipts.flatMap((receipt) => receipt.provided.businessData)) {
    const key = item.logicalAssetId || `${item.sourceSystem}:${item.entityRef}`;
    const current = byLogicalAsset.get(key);
    if (!current || String(item.asOf || "") >= String(current.asOf || "")) byLogicalAsset.set(key, item);
  }
  return Array.from(byLogicalAsset.values()).map((item) => ({
    ...item,
    label: item.logicalAssetId === "customer_directory"
      ? "授权客户范围"
      : item.logicalAssetId === "customer_profile"
        ? "客户画像"
        : item.logicalAssetId === "customer_portfolio"
          ? "客户持仓"
          : item.label,
  }));
}

function mergeCustomerReceipts(receipts: ContextReceiptV1[]): ContextReceiptV1 {
  const first = receipts[0];
  const statusRank = { READY: 0, DEGRADED: 1, BLOCKED: 2 } as const;
  const status = receipts.reduce<ContextReceiptV1["readiness"]["status"]>(
    (current, receipt) => statusRank[receipt.readiness.status] > statusRank[current] ? receipt.readiness.status : current,
    "READY",
  );
  const sourceIds = receipts.map((receipt) => receipt.receiptId);
  return {
    ...first,
    receiptId: `display_customer_${sourceIds.join("_")}`,
    taskId: "DISPLAY-CUSTOMER-CONTEXT",
    taskLabel: "客户信息核验",
    effectiveContextSnapshot: {
      capturedAt: receipts.map((receipt) => receipt.effectiveContextSnapshot.capturedAt).sort().at(-1) || first.createdAt,
      items: uniqueBy(
        receipts.flatMap((receipt) => receipt.effectiveContextSnapshot.items),
        (item) => [item.contextType, item.logicalAssetId, item.assetId, item.version, item.asOf].join(":"),
      ),
      snapshotFingerprint: first.effectiveContextSnapshot.snapshotFingerprint,
    },
    provided: {
      knowledge: uniqueBy(receipts.flatMap((receipt) => receipt.provided.knowledge), (item) => item.assetId),
      businessData: latestBusinessData(receipts),
      memory: uniqueBy(receipts.flatMap((receipt) => receipt.provided.memory), (item) => `${item.memoryId}:${item.version}`),
      capabilities: uniqueBy(receipts.flatMap((receipt) => receipt.provided.capabilities), (item) => `${item.capabilityId}:${item.version}`),
    },
    cited: {
      knowledgeAssetIds: uniqueBy(receipts.flatMap((receipt) => receipt.cited.knowledgeAssetIds), (item) => item),
    },
    applied: {
      policyDecisions: uniqueBy(
        receipts.flatMap((receipt) => receipt.applied.policyDecisions),
        (item) => `${item.decisionId || ""}:${item.policyCode}:${item.ruleVersion}:${item.effect}`,
      ),
      capabilityExecutions: uniqueBy(
        receipts.flatMap((receipt) => receipt.applied.capabilityExecutions),
        (item) => `${item.capabilityId}:${item.operation}:${item.requestId || ""}:${item.status}`,
      ),
    },
    excluded: uniqueBy(
      receipts.flatMap((receipt) => receipt.excluded),
      (item) => `${item.category}:${item.reasonCode}:${item.message}`,
    ),
    readiness: {
      ...first.readiness,
      status,
      allowedOutcomes: uniqueBy(receipts.flatMap((receipt) => receipt.readiness.allowedOutcomes), (item) => item),
      deniedOutcomes: uniqueBy(receipts.flatMap((receipt) => receipt.readiness.deniedOutcomes), (item) => item),
      reasons: uniqueBy(receipts.flatMap((receipt) => receipt.readiness.reasons), (item) => item),
      remediation: uniqueBy(receipts.flatMap((receipt) => receipt.readiness.remediation), (item) => item),
      presentation: {
        completed: uniqueBy(receipts.flatMap((receipt) => receipt.readiness.presentation.completed), (item) => item),
        unavailable: uniqueBy(receipts.flatMap((receipt) => receipt.readiness.presentation.unavailable), (item) => item),
        nextSteps: uniqueBy(receipts.flatMap((receipt) => receipt.readiness.presentation.nextSteps), (item) => item),
      },
    },
    receiptFingerprint: first.receiptFingerprint,
  };
}

export function contextReceiptDisplayEntries(receipts: ContextReceiptV1[]): ContextReceiptDisplayEntry[] {
  const customerReceipts = receipts.filter(isCustomerVerificationReceipt);
  if (customerReceipts.length < 2) {
    return receipts.map((receipt) => ({ key: receipt.receiptId, receipt, sourceReceipts: [receipt] }));
  }

  const entries: ContextReceiptDisplayEntry[] = [];
  let customerInserted = false;
  for (const receipt of receipts) {
    if (isCustomerVerificationReceipt(receipt)) {
      if (!customerInserted) {
        entries.push({
          key: `customer:${customerReceipts.map((item) => item.receiptId).join(":")}`,
          receipt: mergeCustomerReceipts(customerReceipts),
          sourceReceipts: customerReceipts,
        });
        customerInserted = true;
      }
      continue;
    }
    entries.push({ key: receipt.receiptId, receipt, sourceReceipts: [receipt] });
  }
  return entries;
}
