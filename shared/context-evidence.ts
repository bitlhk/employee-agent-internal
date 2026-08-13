import type { ContextReceiptV1 } from "./context-receipt";

export const CONTEXT_INTERACTION_GRANT_SCHEMA = "ea.context-interaction-grant.v1" as const;
export const TASK_RECEIPT_BUNDLE_SCHEMA = "ea.task-receipt-bundle.v1" as const;
export const RESPONSE_EVIDENCE_SCHEMA = "ea.response-evidence.v1" as const;

export type ContextInteractionGrantV1 = {
  schema: typeof CONTEXT_INTERACTION_GRANT_SCHEMA;
  receiptId: string;
  token: string;
  expiresAt: string;
};

export type TaskReceiptBundleV1 = {
  schema: typeof TASK_RECEIPT_BUNDLE_SCHEMA;
  bundleId: string;
  correlationId: string;
  assistantMessageId: string;
  stages: Array<{
    sequence: number;
    taskId: string;
    taskLabel: string;
    receiptId: string;
    envelopeId?: string;
    receiptFingerprint: string;
  }>;
  bundleFingerprint: string;
};

export type ResponseEvidenceV1 = {
  schema: typeof RESPONSE_EVIDENCE_SCHEMA;
  evidenceId: string;
  assistantMessageId: string;
  responseHash: string;
  citedKnowledge: Array<{
    documentId: string;
    documentName: string;
    documentVersion?: string;
  }>;
  receiptBundle: TaskReceiptBundleV1;
  finalizedAt: string;
  evidenceFingerprint: string;
};

export function isContextInteractionGrantV1(value: unknown): value is ContextInteractionGrantV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Partial<ContextInteractionGrantV1>;
  return grant.schema === CONTEXT_INTERACTION_GRANT_SCHEMA
    && typeof grant.receiptId === "string"
    && typeof grant.token === "string"
    && typeof grant.expiresAt === "string";
}

export type ContextReceiptStage = Pick<
  ContextReceiptV1,
  "taskId" | "taskLabel" | "receiptId" | "envelopeId" | "correlationId" | "receiptFingerprint"
>;
