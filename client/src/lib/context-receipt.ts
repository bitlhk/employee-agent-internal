import {
  isContextReceiptV1,
  type ContextReceiptV1,
} from "@shared/context-receipt";
import {
  isContextInteractionGrantV1,
  type ContextInteractionGrantV1,
} from "@shared/context-evidence";

type ContextReceiptToolResult = { name: string; result?: string };

function parseJsonCandidate(value: string): unknown {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeReceipt(receipt: ContextReceiptV1): ContextReceiptV1 {
  const readiness = receipt.readiness as ContextReceiptV1["readiness"] & { presentation?: ContextReceiptV1["readiness"]["presentation"] };
  return {
    ...receipt,
    taskLabel: receipt.taskLabel || receipt.taskId,
    provided: {
      ...receipt.provided,
      memory: receipt.provided.memory.map((item) => ({
        ...item,
        version: Number(item.version || 1),
        contentHash: item.contentHash || "",
        usageType: item.usageType || "relationship_observation",
        assurance: "REFERENCE_ONLY",
      })),
    },
    applied: {
      ...receipt.applied,
      capabilityExecutions: receipt.applied.capabilityExecutions.map((item) => ({
        ...item,
        label: item.label || item.operation,
      })),
    },
    excluded: receipt.excluded.map((item) => ({
      ...item,
      disclosure: item.disclosure || "aggregate_only",
    })),
    readiness: {
      ...readiness,
      presentation: readiness.presentation || {
        completed: readiness.allowedOutcomes,
        unavailable: readiness.deniedOutcomes,
        nextSteps: readiness.remediation,
      },
    },
  };
}

function trustedMetadata(tool: ContextReceiptToolResult): Record<string, unknown> {
  void tool.name;
  const result = String(tool.result || "").trim();
  const payload = object(parseJsonCandidate(result));
  const metadata = object(payload._meta);
  if (metadata.eaMetadataIssuer === "employee-agent") return metadata;
  return {};
}

function receiptFromTrustedTool(tool: ContextReceiptToolResult): ContextReceiptV1 | null {
  const metadata = trustedMetadata(tool);
  if (isContextReceiptV1(metadata.eaContextReceipt)) return normalizeReceipt(metadata.eaContextReceipt);
  return null;
}

export function extractContextReceipts(tools: ContextReceiptToolResult[]): ContextReceiptV1[] {
  const receipts = new Map<string, ContextReceiptV1>();
  for (const tool of tools) {
    const receipt = receiptFromTrustedTool(tool);
    if (receipt) receipts.set(receipt.receiptId, receipt);
  }
  return Array.from(receipts.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function latestContextReceipt(tools: ContextReceiptToolResult[]): ContextReceiptV1 | null {
  return extractContextReceipts(tools).at(-1) || null;
}

export function extractContextInteractionGrants(
  tools: ContextReceiptToolResult[],
): Map<string, ContextInteractionGrantV1> {
  const grants = new Map<string, ContextInteractionGrantV1>();
  for (const tool of tools) {
    const candidate = trustedMetadata(tool).eaInteractionGrant;
    if (isContextInteractionGrantV1(candidate)) grants.set(candidate.receiptId, candidate);
  }
  return grants;
}
