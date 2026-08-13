import {
  isContextReceiptV1,
  type ContextReceiptV1,
} from "@shared/context-receipt";

type ContextReceiptToolResult = { name: string; result?: string };

const PLATFORM_RECEIPT_PREFIXES = [
  "EA_WEALTH_PREVISIT_CONTEXT:",
  "EA_WEALTH_ALLOCATION_CONTEXT:",
  "EA_WEALTH_POLICY_BASIS:",
] as const;

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

function receiptFromTrustedTool(tool: ContextReceiptToolResult): ContextReceiptV1 | null {
  const result = String(tool.result || "").trim();
  const platformPrefix = PLATFORM_RECEIPT_PREFIXES.find((prefix) => result.startsWith(prefix));
  if (platformPrefix) {
    const payload = object(parseJsonCandidate(result.slice(platformPrefix.length)));
    return isContextReceiptV1(payload.contextReceipt) ? payload.contextReceipt : null;
  }
  if (!tool.name.startsWith("enterprise_")) return null;
  const payload = object(parseJsonCandidate(result));
  const meta = object(payload._meta);
  return isContextReceiptV1(meta.eaContextReceipt) ? meta.eaContextReceipt : null;
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
