import { describe, expect, it } from "vitest";
import type {
  GovernedWorkItemV1,
  WorkExecutionReceiptV1,
} from "../../shared/work-continuity";
import {
  prepareConfirmedCustomerInteractionV1,
  prepareCustomerFollowupTaskMirrorV1,
} from "./customer-crm-writeback";

const item: GovernedWorkItemV1 = {
  schema: "ea.governed-work-item.v1",
  workItemId: "wi-1",
  organizationId: "org-1",
  userId: 1,
  adoptionId: "insurance-advisor",
  roleTemplate: "insurance-advisor",
  visibilityClass: "principal_private",
  purposeIds: ["insurance_advisory"],
  purposeScopeVersion: "1",
  subjectId: "DEMO-INS-TN_DEMO-1",
  type: "action_item",
  subject: "准备续保方案",
  description: "核对现有保障并形成续保建议",
  ownerPrincipalId: "user-1",
  ownerDisplayName: "保险顾问",
  dueAt: "2026-09-01T09:00:00.000Z",
  status: "open",
  source: {
    type: "meeting",
    sourceId: "meeting-1",
    sourceFingerprint: "source-fingerprint",
  },
  extraction: {
    extractor: "deterministic",
    extractorVersion: "1",
    sourceExcerpt: "准备续保方案",
    extractedFields: ["type", "subject", "owner", "due_at"],
  },
  confirmation: {
    confirmedBy: "user-1",
    confirmedAt: "2026-08-27T09:00:00.000Z",
  },
  relatedContext: ["customer_profile"],
  version: 2,
  createdAt: "2026-08-27T08:00:00.000Z",
  updatedAt: "2026-08-27T09:00:00.000Z",
};

const receipt: WorkExecutionReceiptV1 = {
  schema: "ea.work-execution-receipt.v1",
  executionReceiptId: "wex-1",
  workItemId: "wi-1",
  capabilityId: "grace.work_item",
  capabilityVersion: "1",
  operation: "confirm",
  fromStatus: "draft",
  toStatus: "open",
  status: "completed",
  requestedBy: "user-1",
  confirmedBy: "user-1",
  confirmedAt: "2026-08-27T09:00:00.000Z",
  idempotencyKey: "confirm-wi-1",
  payloadHash: "payload",
  createdAt: "2026-08-27T09:00:00.000Z",
  completedAt: "2026-08-27T09:00:01.000Z",
};

describe("Customer CRM write-back contract", () => {
  it("maps only confirmed work state with a completed execution receipt", () => {
    expect(
      prepareCustomerFollowupTaskMirrorV1({ item, executionReceipt: receipt })
    ).toMatchObject({
      taskKey: "governed-work:org-1:wi-1",
      globalCustomerId: "DEMO-INS-TN_DEMO-1",
      taskStatus: "open",
      executionReceiptId: "wex-1",
    });
    expect(() =>
      prepareCustomerFollowupTaskMirrorV1({
        item: { ...item, confirmation: null },
        executionReceipt: receipt,
      })
    ).toThrow("CUSTOMER_CRM_WORK_ITEM_CONFIRMATION_REQUIRED");
    expect(() =>
      prepareCustomerFollowupTaskMirrorV1({
        item,
        executionReceipt: { ...receipt, status: "failed" },
      })
    ).toThrow("CUSTOMER_CRM_WORK_ITEM_RECEIPT_INVALID");
  });

  it("requires confirmation and execution evidence for interactions", () => {
    expect(
      prepareConfirmedCustomerInteractionV1({
        interactionKey: "visit-1",
        globalCustomerId: "DEMO-INS-TN_DEMO-1",
        interactionType: "visit",
        happenedAt: "2026-08-27T10:00:00.000Z",
        summary: "客户确认续保需求",
        purposeId: "insurance_advisory",
        organizationId: "org-1",
        confirmedBy: "user-1",
        confirmedAt: "2026-08-27T10:05:00.000Z",
        executionReceiptId: "wex-2",
      })
    ).toMatchObject({
      interactionKey: "visit-1",
      interactionType: "visit",
    });
    expect(() =>
      prepareConfirmedCustomerInteractionV1({
        interactionKey: "visit-2",
        globalCustomerId: "DEMO-INS-TN_DEMO-1",
        interactionType: "visit",
        happenedAt: "2026-08-27T10:00:00.000Z",
        summary: "客户确认续保需求",
        purposeId: "insurance_advisory",
        organizationId: "org-1",
        confirmedBy: "",
        confirmedAt: "2026-08-27T10:05:00.000Z",
        executionReceiptId: "wex-2",
      })
    ).toThrow("CUSTOMER_CRM_INTERACTION_CONFIRMATION_REQUIRED");
  });
});
