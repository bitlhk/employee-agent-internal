import { randomUUID } from "node:crypto";
import { isContextReceiptV1, type ContextReceiptV1 } from "../../../shared/context-receipt";
import {
  RESPONSE_EVIDENCE_SCHEMA,
  TASK_RECEIPT_BUNDLE_SCHEMA,
  type ResponseEvidenceV1,
  type TaskReceiptBundleV1,
} from "../../../shared/context-evidence";
import { recordAuditRequired } from "../audit-events";
import { governanceFingerprint } from "./contracts";

function contextReceiptMetadata(value: unknown, depth = 0): { receipt: ContextReceiptV1; issuedByEa: boolean } | null {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = contextReceiptMetadata(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const source = value as Record<string, unknown>;
  const meta = source._meta && typeof source._meta === "object" && !Array.isArray(source._meta)
    ? source._meta as Record<string, unknown>
    : null;
  if (isContextReceiptV1(meta?.eaContextReceipt)) {
    return { receipt: meta.eaContextReceipt, issuedByEa: meta?.eaMetadataIssuer === "employee-agent" };
  }
  for (const key of ["tool_result", "result", "output", "content", "data", "delta"]) {
    const found = contextReceiptMetadata(source[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function extractTrustedContextReceipt(toolName: string, resultPayload: unknown): ContextReceiptV1 | null {
  const metadata = contextReceiptMetadata(resultPayload);
  if (!metadata) return null;
  void toolName;
  return metadata.issuedByEa ? metadata.receipt : null;
}

function buildTaskReceiptBundle(input: {
  receipts: ContextReceiptV1[];
  correlationId: string;
  assistantMessageId: string;
}): TaskReceiptBundleV1 {
  const stages = input.receipts.map((receipt, index) => ({
    sequence: index + 1,
    taskId: receipt.taskId,
    taskLabel: receipt.taskLabel || receipt.taskId,
    receiptId: receipt.receiptId,
    ...(receipt.envelopeId ? { envelopeId: receipt.envelopeId } : {}),
    receiptFingerprint: receipt.receiptFingerprint,
  }));
  const body = {
    schema: TASK_RECEIPT_BUNDLE_SCHEMA,
    bundleId: `trb_${randomUUID()}`,
    correlationId: input.correlationId,
    assistantMessageId: input.assistantMessageId,
    stages,
  };
  return { ...body, bundleFingerprint: governanceFingerprint(body) };
}

export function buildResponseEvidence(input: {
  receipts: ContextReceiptV1[];
  correlationId: string;
  assistantMessageId: string;
  responseText: string;
  citedKnowledgeSources: Array<Record<string, unknown>>;
  now?: Date;
}): ResponseEvidenceV1 | null {
  const receipts = Array.from(new Map(input.receipts.map((receipt) => [receipt.receiptId, receipt])).values())
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (!receipts.length) return null;
  const citedKnowledge = input.citedKnowledgeSources.slice(0, 20).map((source) => ({
    documentId: String(source.documentId || source.sourceAssetId || "").slice(0, 160),
    documentName: String(source.documentName || "企业知识").slice(0, 240),
    ...(source.documentVersion ? { documentVersion: String(source.documentVersion).slice(0, 80) } : {}),
  })).filter((source) => source.documentId);
  const receiptBundle = buildTaskReceiptBundle({
    receipts,
    correlationId: input.correlationId,
    assistantMessageId: input.assistantMessageId,
  });
  const body = {
    schema: RESPONSE_EVIDENCE_SCHEMA,
    evidenceId: `reve_${randomUUID()}`,
    assistantMessageId: input.assistantMessageId,
    responseHash: governanceFingerprint({ text: input.responseText }),
    citedKnowledge,
    receiptBundle,
    finalizedAt: (input.now || new Date()).toISOString(),
  };
  return { ...body, evidenceFingerprint: governanceFingerprint(body) };
}

export async function persistResponseEvidence(input: {
  evidence: ResponseEvidenceV1;
  userId: number;
  adoptId: string;
  roleTemplate: string;
  agentId: string;
  sessionId: string;
}): Promise<void> {
  await recordAuditRequired({
    action: "context.response_evidence.finalized",
    result: "success",
    severity: "info",
    actorType: "agent",
    actorUserId: input.userId,
    actorRole: input.roleTemplate,
    targetType: "assistant_message",
    targetId: input.evidence.assistantMessageId,
    agentInstanceId: input.adoptId,
    runtimeAgentId: input.agentId,
    sessionId: input.sessionId,
    requestId: input.evidence.receiptBundle.correlationId,
    source: "jiuwenclaw_bridge",
    metadata: { responseEvidence: input.evidence },
  });
}

export function createResponseEvidenceCollector(principal: {
  userId: number;
  adoptId: string;
  roleTemplate?: string;
}, agentId: string, sessionId: string, requestId: string) {
  const receipts = new Map<string, ContextReceiptV1>();
  return {
    capture(toolName: string, resultPayload: unknown) {
      const receipt = extractTrustedContextReceipt(toolName, resultPayload);
      if (receipt) receipts.set(receipt.receiptId, receipt);
    },
    finalize(
      responseText: string,
      knowledgeSources: Array<Record<string, unknown>>,
      citedIndexes?: Iterable<number>,
    ) {
      const cited = citedIndexes
        ? new Set(Array.from(citedIndexes).map(Number))
        : null;
      const citedKnowledgeSources = cited
        ? knowledgeSources.filter((source) => cited.has(Number(source.index)))
        : knowledgeSources;
      const evidence = buildResponseEvidence({
        receipts: Array.from(receipts.values()),
        correlationId: requestId,
        assistantMessageId: requestId,
        responseText,
        citedKnowledgeSources,
      });
      if (!evidence) return null;
      void persistResponseEvidence({
        evidence,
        userId: principal.userId,
        adoptId: principal.adoptId,
        roleTemplate: principal.roleTemplate || "general-assistant",
        agentId,
        sessionId,
      }).catch(() => undefined);
      return {
        evidenceId: evidence.evidenceId,
        evidenceFingerprint: evidence.evidenceFingerprint,
        receiptBundle: evidence.receiptBundle,
      };
    },
  };
}
