import type {
  GovernedWorkItemV1,
  WorkExecutionReceiptV1,
} from "../../shared/work-continuity";

export type ConfirmedCustomerInteractionV1 = {
  interactionKey: string;
  graceCustomerId: string;
  interactionType: "visit" | "call" | "meeting" | "service_note";
  happenedAt: string;
  summary: string;
  purposeId: string;
  organizationId: string;
  confirmedBy: string;
  confirmedAt: string;
  executionReceiptId: string;
  provenance: Record<string, unknown>;
};

export type CustomerFollowupTaskMirrorV1 = {
  taskKey: string;
  graceCustomerId: string;
  workItemId: string;
  subject: string;
  description: string | null;
  taskStatus: GovernedWorkItemV1["status"];
  dueAt: string | null;
  ownerPrincipalId: string | null;
  ownerDisplayName: string | null;
  purposeId: string;
  organizationId: string;
  confirmedBy: string;
  confirmedAt: string;
  executionReceiptId: string;
  lastIdempotencyKey: string;
  workStateUpdatedAt: string;
};

function required(value: unknown, code: string, limit = 512): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(code);
  return text.slice(0, limit);
}

function iso(value: unknown, code: string): string {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) throw new Error(code);
  return new Date(timestamp).toISOString();
}

export function prepareConfirmedCustomerInteractionV1(input: {
  interactionKey: string;
  graceCustomerId: string;
  interactionType: ConfirmedCustomerInteractionV1["interactionType"];
  happenedAt: string;
  summary: string;
  purposeId: string;
  organizationId: string;
  confirmedBy: string;
  confirmedAt: string;
  executionReceiptId: string;
  provenance?: Record<string, unknown>;
}): ConfirmedCustomerInteractionV1 {
  return {
    interactionKey: required(
      input.interactionKey,
      "CUSTOMER_CRM_INTERACTION_IDEMPOTENCY_REQUIRED",
      191
    ),
    graceCustomerId: required(
      input.graceCustomerId,
      "CUSTOMER_CRM_GLOBAL_ID_REQUIRED",
      128
    ),
    interactionType: input.interactionType,
    happenedAt: iso(input.happenedAt, "CUSTOMER_CRM_INTERACTION_TIME_INVALID"),
    summary: required(
      input.summary,
      "CUSTOMER_CRM_INTERACTION_SUMMARY_REQUIRED",
      4_000
    ),
    purposeId: required(
      input.purposeId,
      "CUSTOMER_CRM_INTERACTION_PURPOSE_REQUIRED",
      128
    ),
    organizationId: required(
      input.organizationId,
      "CUSTOMER_CRM_INTERACTION_ORGANIZATION_REQUIRED",
      128
    ),
    confirmedBy: required(
      input.confirmedBy,
      "CUSTOMER_CRM_INTERACTION_CONFIRMATION_REQUIRED",
      191
    ),
    confirmedAt: iso(
      input.confirmedAt,
      "CUSTOMER_CRM_INTERACTION_CONFIRMATION_TIME_INVALID"
    ),
    executionReceiptId: required(
      input.executionReceiptId,
      "CUSTOMER_CRM_INTERACTION_RECEIPT_REQUIRED",
      191
    ),
    provenance: input.provenance || {},
  };
}

export function prepareCustomerFollowupTaskMirrorV1(input: {
  item: GovernedWorkItemV1;
  executionReceipt: WorkExecutionReceiptV1;
}): CustomerFollowupTaskMirrorV1 {
  const { item, executionReceipt } = input;
  if (!item.confirmation)
    throw new Error("CUSTOMER_CRM_WORK_ITEM_CONFIRMATION_REQUIRED");
  if (!item.subjectId)
    throw new Error("CUSTOMER_CRM_WORK_ITEM_CUSTOMER_REQUIRED");
  if (
    executionReceipt.status !== "completed" ||
    executionReceipt.workItemId !== item.workItemId
  )
    throw new Error("CUSTOMER_CRM_WORK_ITEM_RECEIPT_INVALID");
  return {
    taskKey: `governed-work:${item.organizationId}:${item.workItemId}`,
    graceCustomerId: item.subjectId,
    workItemId: item.workItemId,
    subject: required(
      item.subject,
      "CUSTOMER_CRM_WORK_ITEM_SUBJECT_REQUIRED",
      500
    ),
    description: item.description?.slice(0, 4_000) || null,
    taskStatus: item.status,
    dueAt: item.dueAt
      ? iso(item.dueAt, "CUSTOMER_CRM_WORK_ITEM_DUE_INVALID")
      : null,
    ownerPrincipalId: item.ownerPrincipalId?.slice(0, 191) || null,
    ownerDisplayName: item.ownerDisplayName?.slice(0, 255) || null,
    purposeId: required(
      item.purposeIds[0],
      "CUSTOMER_CRM_WORK_ITEM_PURPOSE_REQUIRED",
      128
    ),
    organizationId: item.organizationId,
    confirmedBy: item.confirmation.confirmedBy,
    confirmedAt: iso(
      item.confirmation.confirmedAt,
      "CUSTOMER_CRM_WORK_ITEM_CONFIRMATION_TIME_INVALID"
    ),
    executionReceiptId: executionReceipt.executionReceiptId,
    lastIdempotencyKey: executionReceipt.idempotencyKey,
    workStateUpdatedAt: iso(
      item.updatedAt,
      "CUSTOMER_CRM_WORK_ITEM_UPDATED_TIME_INVALID"
    ),
  };
}
