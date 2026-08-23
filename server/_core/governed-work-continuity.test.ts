import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as any[],
  executions: [] as any[],
  createDrafts: vi.fn(),
  executeTransition: vi.fn(),
  getItem: vi.fn(),
  listExecutions: vi.fn(),
  listItems: vi.fn(),
}));

vi.mock("../db", () => ({
  createGovernedWorkItemDrafts: mocks.createDrafts,
  executeGovernedWorkItemTransition: mocks.executeTransition,
  getGovernedWorkItem: mocks.getItem,
  listGovernedWorkItemExecutions: mocks.listExecutions,
  listGovernedWorkItems: mocks.listItems,
}));

import {
  createMeetingWorkDrafts,
  extractMeetingWorkDrafts,
  governedWorkContext,
  governedWorkView,
  transitionGovernedWorkItem,
} from "./governed-work-continuity";
import type { RuntimePrincipalV2 } from "./governance/contracts";

const principal: RuntimePrincipalV2 = {
  tenantId: "tn_demo",
  organizationId: "org_demo",
  userId: 7,
  adoptionId: "lgj-wealth",
  agentId: "wealth-agent",
  roleTemplate: "wealth-manager",
  workspaceId: "/workspace/lgj-wealth",
  permissionProfile: "plus",
  sessionId: "session-1",
  authorizationSnapshotId: "authz-1",
  authorizationFingerprint: "a".repeat(64),
  identityVersion: "2",
};

function row(input: Partial<any> = {}) {
  const now = new Date("2026-08-23T10:00:00.000Z");
  return {
    id: 1,
    workItemId: "gwk_00000000-0000-4000-8000-000000000001",
    organizationId: principal.organizationId,
    userId: principal.userId,
    adoptId: principal.adoptionId,
    roleTemplate: principal.roleTemplate,
    type: "action_item",
    subject: "准备王总资产配置方案",
    description: "小李下周三前准备王总资产配置方案",
    ownerPrincipalId: null,
    ownerDisplayName: "小李",
    dueAt: new Date("2026-08-26T10:00:00.000Z"),
    status: "draft",
    sourceType: "meeting",
    sourceId: "meeting-demo",
    sourceFingerprint: "b".repeat(64),
    sourceExcerpt: "小李下周三前准备王总资产配置方案",
    extractionJson: {
      extractor: "deterministic",
      extractorVersion: "meeting-work-extractor-v1",
      sourceExcerpt: "小李下周三前准备王总资产配置方案",
      extractedFields: ["type", "subject", "description", "owner", "due_at"],
    },
    confirmedBy: null,
    confirmedAt: null,
    relatedContextJson: ["customer_profile", "customer_portfolio"],
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.executions = [];
  mocks.createDrafts.mockImplementation(async (inputs: any[]) => inputs.map((input, index) => row({ id: index + 1, ...input })));
  mocks.listItems.mockImplementation(async (input: { statuses?: string[] }) => mocks.rows.filter(item => !input.statuses || input.statuses.includes(item.status)));
  mocks.listExecutions.mockImplementation(async () => mocks.executions);
  mocks.getItem.mockImplementation(async (_scope: unknown, workItemId: string) => mocks.rows.find(item => item.workItemId === workItemId) || null);
  mocks.executeTransition.mockImplementation(async (input: any) => {
    const current = mocks.rows.find(item => item.workItemId === input.workItemId);
    const next = { ...current, status: input.toStatus, version: current.version + 1, confirmedBy: input.confirmedBy, confirmedAt: input.confirmedAt, updatedAt: new Date() };
    mocks.rows = mocks.rows.map(item => item.workItemId === input.workItemId ? next : item);
    const execution = {
      id: mocks.executions.length + 1,
      executionReceiptId: input.executionReceiptId,
      workItemId: input.workItemId,
      organizationId: input.organizationId,
      userId: input.userId,
      adoptId: input.adoptId,
      capabilityId: "grace.work_item",
      capabilityVersion: "1",
      operation: input.operation,
      fromStatus: current.status,
      toStatus: input.toStatus,
      status: "completed",
      requestedBy: input.requestedBy,
      confirmedBy: input.confirmedBy,
      confirmedAt: input.confirmedAt,
      approvalId: input.approvalId || null,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      contextReceiptFingerprint: input.contextReceiptFingerprint,
      resultFingerprint: input.resultFingerprint,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
      completedAt: new Date(),
    };
    mocks.executions.push(execution);
    return { item: next, execution, reused: false };
  });
});

describe("GRACE governed work continuity", () => {
  it("extracts decisions, two owned and dated actions, and an open question", () => {
    const drafts = extractMeetingWorkDrafts({
      meetingAt: new Date("2026-08-23T09:00:00+08:00"),
      meetingText: "会议决定启动王总资产配置复盘。小李下周三前准备配置方案，周四和客户沟通。市场观点还需要投研确认。",
    });
    expect(drafts.map(item => item.type)).toEqual(["decision", "action_item", "action_item", "open_question"]);
    expect(drafts.filter(item => item.type === "action_item")).toEqual([
      expect.objectContaining({ ownerDisplayName: "小李", dueAt: expect.any(Date) }),
      expect.objectContaining({ ownerDisplayName: "小李", dueAt: expect.any(Date) }),
    ]);
    expect(drafts[1].dueAt?.getDate()).toBe(26);
    expect(drafts[2].dueAt?.getDate()).toBe(27);
  });

  it("keeps extracted meeting items as drafts and out of formal work Context", async () => {
    const result = await createMeetingWorkDrafts({
      principal,
      meetingAt: new Date("2026-08-23T09:00:00+08:00"),
      meetingText: "会议决定启动王总资产配置复盘。小李下周三前准备配置方案。",
      sourceId: "meeting-demo",
    });
    expect(result.items.every(item => item.status === "draft" && !item.confirmation)).toBe(true);
    mocks.rows = result.items.map(item => row({
      workItemId: item.workItemId,
      type: item.type,
      subject: item.subject,
      status: item.status,
    }));
    const formal = await governedWorkContext({ principal });
    expect(formal.items).toHaveLength(0);
    expect(formal.receipt.provided.memory).toHaveLength(0);
    expect(formal.receipt.readiness.status).toBe("DEGRADED");
  });

  it("continues a confirmed task from Work Context and removes it after a confirmed close", async () => {
    const open = row({ status: "open", version: 2, confirmedBy: "财富专家", confirmedAt: new Date("2026-08-23T02:00:00.000Z") });
    mocks.rows = [open];
    const nextDay = await governedWorkView({ principal });
    expect(nextDay.items).toHaveLength(1);
    expect(nextDay.receipt.provided.memory[0]).toMatchObject({
      memoryId: open.workItemId,
      usageType: "work_state",
      assurance: "REFERENCE_ONLY",
    });
    expect(nextDay.receipt.resolution?.needs[0]).toMatchObject({
      logicalAssetId: "governed_work_state",
      resolutionStatus: "resolved",
      providerType: "api",
    });

    const closed = await transitionGovernedWorkItem({
      principal,
      workItemId: open.workItemId,
      operation: "complete",
      idempotencyKey: "close-work-001",
      actor: "财富专家",
      approvalId: "apr_00000000-0000-4000-8000-000000000001",
    });
    expect(closed.item.status).toBe("done");
    expect(closed.executionReceipt).toMatchObject({
      operation: "complete",
      status: "completed",
      approvalId: "apr_00000000-0000-4000-8000-000000000001",
      contextReceiptFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const remaining = await governedWorkContext({ principal });
    expect(remaining.items).toHaveLength(0);
    expect(remaining.receipt.provided.memory).toHaveLength(0);
  });

  it("binds every read and write to organization, user, and adoption scope", async () => {
    mocks.rows = [row({ status: "open" })];
    await governedWorkContext({ principal });
    expect(mocks.listItems).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: principal.organizationId,
      userId: principal.userId,
      adoptId: principal.adoptionId,
    }));
    await transitionGovernedWorkItem({
      principal,
      workItemId: mocks.rows[0].workItemId,
      operation: "start",
      idempotencyKey: "start-work-001",
      actor: "财富专家",
    });
    expect(mocks.getItem).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: principal.organizationId,
      userId: principal.userId,
      adoptId: principal.adoptionId,
    }), mocks.rows[0].workItemId);
  });
});
