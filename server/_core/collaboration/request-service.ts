import { assertCoopParticipants } from "../../db/coop-identity";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createCollabRequest,
  getCollabSettings,
  getClawByAdoptId,
} from "../../db";
import { getCollabRequestByKey } from "../../db/collab";
import { getCalendarBinding } from "../../db/scheduling";
import { stableToolInputHash } from "../tool-governance";
import {
  createRunCollaborationRequest,
  createConversationCollaborationRequest,
  requestConversationContinuation,
  type ConversationContinuation,
} from "../../db/collaboration-runs";
import { collaborationSettingsForTask } from "../../../shared/scheduling-collaboration-policy";
import { candidateSlotsSchema } from "../../../shared/scheduling-progress";

export const collaborationRequestInput = z.object({
  requesterAdoptId: z.string(),
  targetAdoptId: z.string(),
  taskType: z.string().min(1).max(64).default("general"),
  taskSummary: z.string().min(1).max(1000),
  inputPayload: z.record(z.string(), z.unknown()).optional(),
  requestKey: z.string().uuid().optional(),
});

// Shared by the authenticated UI and trusted platform tools. Caller identity is
// supplied by the transport, never by a model argument.
export async function sendCollaborationRequest(
  userId: number,
  input: z.infer<typeof collaborationRequestInput>,
  runId?: string,
  continuation?: ConversationContinuation
) {
  const fingerprint = stableToolInputHash({
    target: input.targetAdoptId,
    type: input.taskType,
    summary: input.taskSummary,
    payload: input.inputPayload || {},
  });
  const requester = await getClawByAdoptId(input.requesterAdoptId);
  if (!requester || requester.userId !== userId)
    throw new TRPCError({ code: "FORBIDDEN" });
  if (requester.permissionProfile === "starter")
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "当前智能体未开通协作权限，请联系管理员处理",
    });
  const target = await getClawByAdoptId(input.targetAdoptId);
  if (!target || target.permissionProfile === "starter")
    throw new TRPCError({ code: "NOT_FOUND" });
  if (input.taskType === "scheduling")
    await assertCoopParticipants(userId, [target.userId]);
  const targetSettings = collaborationSettingsForTask(
    await getCollabSettings(target.id),
    input.taskType
  );
  if (!targetSettings || targetSettings.acceptTask === "off") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "target agent does not accept collaboration tasks",
    });
  }

  // ── 第1层：字段白名单过滤（auto 模式更严格）──────────────────────
  // 无论什么模式，以下敏感字段一律剔除
  const ALWAYS_BLOCKED = [
    "chat_history",
    "memory",
    "session",
    "sessionKey",
    "messages",
    "history",
    "context",
    "user_data",
    "personal_data",
    "private",
  ];
  // auto 模式只允许这些字段通过（防止 prompt 注入绕过类型检查）
  const AUTO_ALLOWED = [
    "input",
    "query",
    "file",
    "url",
    "keyword",
    "date_range",
    "filters",
    "target",
  ];

  let safeInput: Record<string, unknown> = {};
  if (input.inputPayload) {
    if (targetSettings.acceptTask === "auto") {
      // auto 模式：严格白名单，只允许 AUTO_ALLOWED 字段
      safeInput = Object.fromEntries(
        Object.entries(input.inputPayload).filter(([k]) =>
          AUTO_ALLOWED.includes(k)
        )
      );
    } else {
      // manual 模式：黑名单过滤
      safeInput = Object.fromEntries(
        Object.entries(input.inputPayload).filter(
          ([k]) => !ALWAYS_BLOCKED.some(b => k.toLowerCase().includes(b))
        )
      );
    }
  }

  if (input.taskType === "scheduling" && input.inputPayload?.slots !== undefined) {
    safeInput.slots = candidateSlotsSchema.parse(input.inputPayload.slots);
  }

  // ── 第2层：执行上下文约束（注入到请求记录，未来 agent 执行时读取）──
  const EXECUTION_CONTEXT_DENY = [
    "chat_history",
    "memory_files",
    "session_context",
    "usage_logs",
    "private_notes",
  ];
  const executionScope = JSON.stringify({
    mode: "collaboration",
    forbidAccess: EXECUTION_CONTEXT_DENY,
    allowedOutputTypes: ["result_summary", "data", "analysis"],
    forbidOutput: ["session_ids", "memory_ids", "internal_refs", "user_pii"],
    maxOutputLength: 2000,
  });

  // ── 第3层：风险评级 ────────────────────────────────────────────────
  // high risk: 跨 owner + 文本长、medium: 跨 owner、low: 同 owner
  const isCrossOwner = requester.userId !== target.userId;
  const taskLen = (input.taskSummary || "").length;
  const riskLevel = isCrossOwner ? (taskLen > 500 ? "high" : "medium") : "low";

  const isAutoMode = targetSettings.acceptTask === "auto";
  // auto 模式且 high risk 时自动降级为 pending（需人工审批）
  let effectiveStatus: "approved" | "pending" =
    isAutoMode && riskLevel !== "high" ? "approved" : "pending";

  // A legacy empty task list continues to allow historical task types.
  // Scheduling auto replies additionally require explicit calendar consent.
  if (input.taskType === "scheduling" && isAutoMode) {
    const allowed: string[] = targetSettings.allowedTaskTypes
      ? JSON.parse(targetSettings.allowedTaskTypes)
      : [];
    const binding = await getCalendarBinding(target.userId);
    if (
      !allowed.includes("scheduling") ||
      !binding?.enabled ||
      !binding.autoAvailability
    )
      effectiveStatus = "pending";
  }

  // 检查 auto 模式下 taskType 是否在目标 allowedTaskTypes 里
  if (isAutoMode) {
    const allowed: string[] = targetSettings.allowedTaskTypes
      ? JSON.parse(targetSettings.allowedTaskTypes)
      : [];
    if (allowed.length > 0 && !allowed.includes(input.taskType)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "auto mode: taskType not in allowed list",
      });
    }
  }

  const replay = async () => {
    if (!input.requestKey) return null;
    const existing = await getCollabRequestByKey(
      input.requesterAdoptId,
      input.requestKey
    );
    if (!existing) return null;
    if (existing.requestFingerprint !== fingerprint)
      throw new TRPCError({
        code: "CONFLICT",
        message: "同一请求编号不能用于不同提议，请为新的沟通生成新的编号",
      });
    if (continuation) {
      const run = await requestConversationContinuation(existing.id);
      if (!run || run.sourceSessionId !== continuation.sourceSessionId)
        throw new TRPCError({
          code: "CONFLICT",
          message: "该请求编号已用于其他会话，请使用新的请求编号",
        });
    }
    return {
      id: existing.id,
      status: existing.status,
      riskLevel: existing.riskLevel,
      approvalMode: existing.approvalMode,
    };
  };
  const previous = await replay();
  if (previous) return previous;

  let id: number;
  try {
    const payload = {
      requesterAdoptId: input.requesterAdoptId,
      targetAdoptId: input.targetAdoptId,
      requesterUserId: requester.userId,
      targetUserId: target.userId,
      taskType: input.taskType,
      taskSummary: input.taskSummary,
      inputPayload: JSON.stringify(safeInput),
      status: effectiveStatus,
      approvalMode: isAutoMode ? "auto" : "manual",
      approvedBy:
        isAutoMode && effectiveStatus === "approved" ? null : undefined,
      executionScope,
      riskLevel,
      constraintsApplied: JSON.stringify({
        autoAllowedFields: isAutoMode ? AUTO_ALLOWED : null,
        alwaysBlocked: ALWAYS_BLOCKED,
      }),
      ...(input.requestKey
        ? { requestKey: input.requestKey, requestFingerprint: fingerprint }
        : {}),
    } as Parameters<typeof createCollabRequest>[0];
    id = runId
      ? await createRunCollaborationRequest(runId, payload)
      : continuation
        ? await createConversationCollaborationRequest(payload, continuation, targetSettings.displayName || "对方")
        : await createCollabRequest(payload);
  } catch (error) {
    // The unique index also protects simultaneous retries in other workers.
    const concurrent = await replay();
    if (concurrent) return concurrent;
    throw error;
  }

  return {
    id,
    status: effectiveStatus,
    riskLevel,
    approvalMode: isAutoMode ? "auto" : "manual",
    note:
      effectiveStatus === "pending" && isAutoMode
        ? "auto模式但风险等级high，已降级为需人工审批"
        : undefined,
  };
}
