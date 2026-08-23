export const GOVERNED_WORK_ITEM_SCHEMA = "ea.governed-work-item.v1" as const;
export const WORK_EXECUTION_RECEIPT_SCHEMA = "ea.work-execution-receipt.v1" as const;

export type GovernedWorkItemTypeV1 = "decision" | "action_item" | "open_question";
export type GovernedWorkItemStatusV1 =
  | "draft"
  | "confirmed"
  | "open"
  | "in_progress"
  | "done"
  | "cancelled";

export type WorkItemExtractionProvenanceV1 = {
  extractor: "deterministic" | "model_assisted";
  extractorVersion: string;
  sourceExcerpt: string;
  extractedFields: Array<"type" | "subject" | "description" | "owner" | "due_at">;
};
export type GovernedWorkItemV1 = {
  schema: typeof GOVERNED_WORK_ITEM_SCHEMA;
  workItemId: string;
  organizationId: string;
  userId: number;
  adoptionId: string;
  roleTemplate: string;
  type: GovernedWorkItemTypeV1;
  subject: string;
  description?: string | null;
  ownerPrincipalId?: string | null;
  ownerDisplayName?: string | null;
  dueAt?: string | null;
  status: GovernedWorkItemStatusV1;
  source: {
    type: "meeting";
    sourceId: string;
    sourceFingerprint: string;
  };
  extraction: WorkItemExtractionProvenanceV1;
  confirmation?: {
    confirmedBy: string;
    confirmedAt: string;
  } | null;
  relatedContext: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkExecutionOperationV1 = "confirm" | "start" | "complete" | "cancel";

export type WorkExecutionReceiptV1 = {
  schema: typeof WORK_EXECUTION_RECEIPT_SCHEMA;
  executionReceiptId: string;
  workItemId: string;
  capabilityId: "grace.work_item";
  capabilityVersion: "1";
  operation: WorkExecutionOperationV1;
  fromStatus: GovernedWorkItemStatusV1;
  toStatus: GovernedWorkItemStatusV1;
  status: "completed" | "failed" | "blocked";
  requestedBy: string;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  approvalId?: string | null;
  idempotencyKey: string;
  payloadHash: string;
  contextReceiptFingerprint?: string | null;
  resultFingerprint?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  completedAt?: string | null;
};
