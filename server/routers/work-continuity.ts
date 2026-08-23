import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { auditActor, auditRequest, recordAuditRequired } from "../_core/audit-events";
import {
  createMeetingWorkDrafts,
  governedWorkView,
  transitionGovernedWorkItem,
} from "../_core/governed-work-continuity";
import { enforceGovernanceApproval } from "../_core/governance/approval-service";
import { finalizeGovernanceDecision, governanceFingerprint } from "../_core/governance/contracts";
import { resolveRuntimePrincipalV2 } from "../_core/governance/principal";
import { protectedProcedure, router } from "../_core/trpc";
import { getUserById } from "../db";
import { assertClawOwnerOrThrow } from "./helpers";

const workItemIdSchema = z.string().regex(/^gwk_[0-9a-f-]{36}$/i);
const idempotencySchema = z.string().min(8).max(191);

async function runtimeIdentity(ctx: any, adoptId: string) {
  const adoption = await assertClawOwnerOrThrow(ctx, adoptId);
  const user = await getUserById(Number(ctx.user.id));
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
  const resolution = await resolveRuntimePrincipalV2({ adoption, user });
  if (!resolution.complete) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "当前岗位身份无法形成可验证授权快照。" });
  }
  return { adoption, user, principal: resolution.principal };
}

function actorName(user: { id?: number | string | null; name?: string | null; email?: string | null }) {
  return String(user.name || user.email || user.id || "user").slice(0, 128);
}

async function enforceWorkConfirmation(input: {
  principal: Awaited<ReturnType<typeof runtimeIdentity>>["principal"];
  workItemId: string;
  operation: "confirm" | "start" | "complete" | "cancel";
  idempotencyKey: string;
  payload: unknown;
  approvalId?: string;
}) {
  const operation = {
    capabilityId: "grace.work_item",
    operation: input.operation,
    sideEffect: "write" as const,
    resource: `governed-work-item:${input.workItemId}`,
    payloadHash: governanceFingerprint(input.payload),
  };
  const decision = finalizeGovernanceDecision({ principal: input.principal, operation }, {
    effect: "REQUIRE_APPROVAL",
    policyCode: "EA_GOVERNED_WORK_CONFIRMATION_V1",
    ruleVersion: "governed-work-continuity-v1",
    reason: "工作事项写入需要你本人确认，且确认只对本次参数有效。",
    obligations: [
      { type: "APPROVAL", mode: "always" },
      { type: "IDEMPOTENCY_KEY" },
      { type: "AUDIT", level: "strong" },
    ],
  });
  const approval = await enforceGovernanceApproval({
    decision,
    principal: input.principal,
    operation,
    approvalId: input.approvalId,
    idempotencyKey: input.idempotencyKey,
  });
  if (approval.effect === "DENY") throw new TRPCError({ code: "FORBIDDEN", message: approval.reason });
  return approval;
}

function workError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message === "WORK_ITEM_NOT_FOUND") throw new TRPCError({ code: "NOT_FOUND", message: "工作事项不存在或不属于当前岗位范围。" });
  if (message === "INVALID_WORK_ITEM_TRANSITION") throw new TRPCError({ code: "CONFLICT", message: "当前工作事项状态不能执行该操作。" });
  if (message === "IDEMPOTENCY_CONFLICT") throw new TRPCError({ code: "CONFLICT", message: "幂等键已用于不同的工作操作。" });
  if (message === "NO_WORK_ITEMS_EXTRACTED") throw new TRPCError({ code: "BAD_REQUEST", message: "没有识别到决定、带负责人和截止时间的待办，或开放问题。" });
  throw error;
}

const editablePatchSchema = z.object({
  subject: z.string().min(2).max(240).optional(),
  description: z.string().max(2_000).nullable().optional(),
  ownerPrincipalId: z.string().max(128).nullable().optional(),
  ownerDisplayName: z.string().max(160).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  relatedContext: z.array(z.string().min(1).max(128)).max(20).optional(),
});

export const workContinuityRouter = router({
  view: protectedProcedure.input(z.object({
    adoptId: z.string().min(1).max(64),
    includeClosed: z.boolean().default(true),
  })).query(async ({ ctx, input }) => {
    const identity = await runtimeIdentity(ctx, input.adoptId);
    return governedWorkView({ principal: identity.principal, includeClosed: input.includeClosed });
  }),

  draftMeeting: protectedProcedure.input(z.object({
    adoptId: z.string().min(1).max(64),
    meetingText: z.string().min(10).max(30_000),
    meetingAt: z.string().datetime().optional(),
    sourceId: z.string().min(3).max(128).optional(),
  })).mutation(async ({ ctx, input }) => {
    const identity = await runtimeIdentity(ctx, input.adoptId);
    try {
      const result = await createMeetingWorkDrafts({
        principal: identity.principal,
        meetingText: input.meetingText,
        meetingAt: input.meetingAt ? new Date(input.meetingAt) : undefined,
        sourceId: input.sourceId,
      });
      await recordAuditRequired({
        action: "work_continuity.meeting_draft.extracted",
        result: "success",
        severity: "info",
        ...auditActor(ctx.user),
        ...auditRequest(ctx.req),
        targetType: "meeting_work_draft",
        targetId: result.sourceId,
        agentInstanceId: input.adoptId,
        runtimeAgentId: identity.principal.agentId,
        source: "work_continuity_router",
        metadata: { itemCount: result.items.length, sourceFingerprint: result.sourceFingerprint },
      });
      return result;
    } catch (error) {
      workError(error);
    }
  }),

  confirm: protectedProcedure.input(z.object({
    adoptId: z.string().min(1).max(64),
    workItemId: workItemIdSchema,
    idempotencyKey: idempotencySchema.default(() => `confirm-${nanoid(24)}`),
    approvalId: z.string().max(64).optional(),
    patch: editablePatchSchema.optional(),
  })).mutation(async ({ ctx, input }) => {
    const identity = await runtimeIdentity(ctx, input.adoptId);
    try {
      const approval = await enforceWorkConfirmation({
        principal: identity.principal,
        workItemId: input.workItemId,
        operation: "confirm",
        idempotencyKey: input.idempotencyKey,
        payload: { workItemId: input.workItemId, operation: "confirm", patch: input.patch || null },
        approvalId: input.approvalId,
      });
      if (approval.effect === "REQUIRE_APPROVAL") return {
        approvalRequired: true as const,
        approvalId: approval.requirement.approvalId,
        expiresAt: approval.requirement.expiresAt.toISOString(),
      };
      const result = await transitionGovernedWorkItem({
        principal: identity.principal,
        workItemId: input.workItemId,
        operation: "confirm",
        idempotencyKey: input.idempotencyKey,
        actor: actorName(identity.user),
        approvalId: approval.approval?.approvalId || input.approvalId,
        patch: input.patch ? {
          ...input.patch,
          dueAt: input.patch.dueAt === undefined ? undefined : input.patch.dueAt ? new Date(input.patch.dueAt) : null,
        } : undefined,
      });
      await recordAuditRequired({
        action: "work_continuity.item.confirmed",
        result: "success",
        severity: "high",
        ...auditActor(ctx.user),
        ...auditRequest(ctx.req),
        targetType: "governed_work_item",
        targetId: input.workItemId,
        agentInstanceId: input.adoptId,
        runtimeAgentId: identity.principal.agentId,
        source: "work_continuity_router",
        metadata: { executionReceiptId: result.executionReceipt.executionReceiptId, toStatus: result.item.status, reused: result.reused },
      });
      return result;
    } catch (error) {
      workError(error);
    }
  }),

  updateStatus: protectedProcedure.input(z.object({
    adoptId: z.string().min(1).max(64),
    workItemId: workItemIdSchema,
    operation: z.enum(["start", "complete", "cancel"]),
    idempotencyKey: idempotencySchema.default(() => `work-${nanoid(24)}`),
    approvalId: z.string().max(64).optional(),
  })).mutation(async ({ ctx, input }) => {
    const identity = await runtimeIdentity(ctx, input.adoptId);
    try {
      const approval = await enforceWorkConfirmation({
        principal: identity.principal,
        workItemId: input.workItemId,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        payload: { workItemId: input.workItemId, operation: input.operation },
        approvalId: input.approvalId,
      });
      if (approval.effect === "REQUIRE_APPROVAL") return {
        approvalRequired: true as const,
        approvalId: approval.requirement.approvalId,
        expiresAt: approval.requirement.expiresAt.toISOString(),
      };
      const result = await transitionGovernedWorkItem({
        principal: identity.principal,
        workItemId: input.workItemId,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        actor: actorName(identity.user),
        approvalId: approval.approval?.approvalId || input.approvalId,
      });
      await recordAuditRequired({
        action: `work_continuity.item.${input.operation}`,
        result: "success",
        severity: "high",
        ...auditActor(ctx.user),
        ...auditRequest(ctx.req),
        targetType: "governed_work_item",
        targetId: input.workItemId,
        agentInstanceId: input.adoptId,
        runtimeAgentId: identity.principal.agentId,
        source: "work_continuity_router",
        metadata: { executionReceiptId: result.executionReceipt.executionReceiptId, toStatus: result.item.status, reused: result.reused },
      });
      return result;
    } catch (error) {
      workError(error);
    }
  }),
});
