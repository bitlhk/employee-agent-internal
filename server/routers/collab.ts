import { assertCoopParticipants } from "../db/coop-identity";
import { projectLegacyCollaborationResult, projectCollaborationConclusion } from "../_core/collaboration/result-projection";
import { collaborationSettingsForTask } from "../../shared/scheduling-collaboration-policy";
import { getCoopRuntimeExecutor } from "../_core/coop-runtime-executor";
import { sendCollaborationRequest } from "../_core/collaboration/request-service";
import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  getCollabSettings,
  upsertCollabSettings,
  listCollabDirectory,
  listCollabDisplayNames,
  getCollabRequest,
  updateCollabRequest,
  listIncomingCollabRequests,
  listOutgoingCollabRequests,
} from "../db";
import { fetchWithTimeout } from "../_core/fetch-timeout";

export const collabRouter = router({
    goalAvailability: protectedProcedure.input(z.object({ adoptId: z.string(), id: z.string().uuid() }).strict()).query(async ({ ctx, input }) => {
      const { goalAvailability } = await import("../_core/collaboration/progress");
      return goalAvailability(ctx.user.id, input.adoptId, input.id);
    }),
    schedulingRequestProgress: protectedProcedure.input(z.object({ adoptId: z.string(), requestId: z.number().int().positive() }).strict()).query(async ({ ctx, input }) => {
      const { incomingSchedulingProgress } = await import("../_core/collaboration/progress");
      return incomingSchedulingProgress(ctx.user.id, input.adoptId, input.requestId);
    }),
    goals: protectedProcedure.input(z.object({ adoptId: z.string(), conversationId: z.string().max(160).optional() }).strict()).query(async ({ ctx, input }) => {
      const { getClawByAdoptId } = await import("../db");
      const claw = await getClawByAdoptId(input.adoptId);
      if (!claw || claw.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN" });
      const { ownCollaborationRuns } = await import("../db/collaboration-runs");
      const { collaborationWaitingResources } = await import("../_core/collaboration/resources");
      // Automatic one-exchange replies use goals internally, but are plain chat replies in the UI.
      return Promise.all((await ownCollaborationRuns(ctx.user.id, input.adoptId, input.conversationId)).filter(run => !run.requestKey?.startsWith("reply:")).map(async run => {
        const calendarResources = (await collaborationWaitingResources(run)).filter(resource => ["draft", "meeting", "reschedule", "cascade"].includes(resource.resourceKind));
        return { id: run.id, objective: run.objective, status: run.status, message: run.publicMessage || "", updatedAt: run.updatedAt,
          // Use owner-bound execution receipts, never the goal status or model prose.
          calendarUpdated: calendarResources.some(resource => resource.completed === true),
          confirmations: calendarResources.filter(resource => resource.state !== "unavailable" && !resource.completed).map(resource => ({ kind: resource.resourceKind as "draft" | "meeting" | "reschedule" | "cascade", id: resource.resourceId })),
        };
      }));
    }),
    cancelGoal: protectedProcedure.input(z.object({ adoptId: z.string(), id: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => {
      const { getClawByAdoptId } = await import("../db"); const claw = await getClawByAdoptId(input.adoptId);
      if (!claw || claw.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN" });
      const { cancelCollaborationRun } = await import("../db/collaboration-runs");
      const { recordAuditRequired } = await import("../_core/audit-events");
      await recordAuditRequired({ action: "collaboration.goal.cancel.requested", actorType: "user", actorUserId: ctx.user.id, targetType: "collaboration_run", targetId: input.id });
      return { cancelled: await cancelCollaborationRun(ctx.user.id, input.id, input.adoptId) };
    }),
    resumeGoal: protectedProcedure.input(z.object({ adoptId: z.string(), id: z.string().uuid(), instruction: z.string().trim().min(1).max(2000) }).strict()).mutation(async ({ ctx, input }) => {
      const { getClawByAdoptId } = await import("../db"); const claw = await getClawByAdoptId(input.adoptId);
      if (!claw || claw.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN" });
      const { resumeCollaborationGoal } = await import("../db/collaboration-runs");
      const { recordAuditRequired } = await import("../_core/audit-events");
      await recordAuditRequired({ action: "collaboration.goal.resume.requested", actorType: "user", actorUserId: ctx.user.id, targetType: "collaboration_run", targetId: input.id });
      await resumeCollaborationGoal(ctx.user.id, input.adoptId, input.id, input.instruction);
      return { resumed: true };
    }),

    // ── 常量：协作执行上下文约束 ─────────────────────────────────────
    // 这些是平台级铁律，任何协作任务执行时必须注入，不可被 prompt 绕过
    // AUTO_ALLOWED_INPUT_FIELDS: auto 模式下发起方只能传这些字段
    // FORBIDDEN_OUTPUT_KEYWORDS: 结果摘要中如出现这些词汇则拒绝提交
    // EXECUTION_CONTEXT_DENY: 目标 agent 执行时被禁止访问的数据源

    // 获取我的协作设置
    getSettings: protectedProcedure
      .input(z.object({ adoptId: z.string() }))
      .query(async ({ input, ctx }) => {
        const { getClawByAdoptId } = await import("../db");
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw || claw.userId !== ctx.user!.id) throw new TRPCError({ code: "FORBIDDEN" });
        if (claw.permissionProfile === "starter") throw new TRPCError({ code: "FORBIDDEN", message: "当前智能体未开通协作权限，请联系管理员处理" });
        const settings = await getCollabSettings(claw.id);
        return settings || { adoptionId: claw.id, visibilityMode: "private", acceptDm: "off", acceptTask: "off", sharingPolicy: "none" };
      }),

    // 更新我的协作设置
    updateSettings: protectedProcedure
      .input(z.object({
        adoptId: z.string(),
        displayName: z.string().max(100).optional(),
        headline: z.string().max(200).optional(),
        visibilityMode: z.enum(["private", "org", "public"]).optional(),
        acceptDm: z.enum(["off", "org", "specified"]).optional(),
        acceptTask: z.enum(["off", "approval", "auto"]).optional(),
        allowedTaskTypes: z.array(z.string()).optional(),
        sharingPolicy: z.enum(["result-only", "none"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getClawByAdoptId } = await import("../db");
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw || claw.userId !== ctx.user!.id) throw new TRPCError({ code: "FORBIDDEN" });
        if (claw.permissionProfile === "starter") throw new TRPCError({ code: "FORBIDDEN", message: "当前智能体未开通协作权限，请联系管理员处理" });
        const patch: any = {};
        if (input.displayName !== undefined) patch.displayName = input.displayName;
        if (input.headline !== undefined) patch.headline = input.headline;
        if (input.visibilityMode !== undefined) patch.visibilityMode = input.visibilityMode;
        if (input.acceptDm !== undefined) patch.acceptDm = input.acceptDm;
        if (input.acceptTask !== undefined) patch.acceptTask = input.acceptTask;
        if (input.allowedTaskTypes !== undefined) patch.allowedTaskTypes = JSON.stringify(input.allowedTaskTypes);
        if (input.sharingPolicy !== undefined) patch.sharingPolicy = input.sharingPolicy;
        return await upsertCollabSettings(claw.id, patch);
      }),

    // 获取组织协作目录（org 及 public 可见的 agent）
    directory: protectedProcedure
      .input(z.object({ adoptId: z.string() }))
      .query(async ({ input, ctx }) => {
        const { getClawByAdoptId } = await import("../db");
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw || claw.userId !== ctx.user!.id) throw new TRPCError({ code: "FORBIDDEN" });
        if (claw.permissionProfile === "starter") return [];
        const rows = await listCollabDirectory(claw.id);
        return rows.map(r => ({
          adoptId: r.adoptId,
          displayName: r.displayName || r.adoptId,
          headline: r.headline || "",
          acceptDm: r.acceptDm,
          acceptTask: r.acceptTask,
          allowedTaskTypes: r.allowedTaskTypes ? JSON.parse(r.allowedTaskTypes) : [],
        }));
      }),

    // 发起协作请求（task delegation）
    // 安全层：三级过滤 + 执行上下文约束注入 + 风险评级
    sendRequest: protectedProcedure
      .input(z.object({
        requesterAdoptId: z.string(),
        targetAdoptId: z.string(),
        taskType: z.string().max(64).default("general"),
        taskSummary: z.string().max(1000),
        inputPayload: z.record(z.string(), z.unknown()).optional(),
        requestKey: z.string().uuid().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        return sendCollaborationRequest(ctx.user!.id, input);
      }),

    // 审批/拒绝协作请求（目标方主人操作）
    reviewRequest: protectedProcedure
      .input(z.object({
        adoptId: z.string(),
        requestId: z.number(),
        action: z.enum(["approve", "reject"]),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getClawByAdoptId } = await import("../db");
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw || claw.userId !== ctx.user!.id) throw new TRPCError({ code: "FORBIDDEN" });
        const req = await getCollabRequest(input.requestId);
        if (!req || req.targetAdoptId !== input.adoptId) throw new TRPCError({ code: "NOT_FOUND" });
        if (input.action === "approve" && req.taskType === "scheduling") await assertCoopParticipants(req.requesterUserId, [req.targetUserId]);
        if (!["pending"].includes(req.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "request already processed" });
        await updateCollabRequest(input.requestId, {
          status: input.action === "approve" ? "approved" : "rejected",
          approvedAt: input.action === "approve" ? new Date() : undefined,
          approvedBy: input.action === "approve" ? claw.userId : undefined,
        } as any);

        // 审批通过后：自动触发 collab-exec，让目标 agent 开始执行任务
        const autoExecutionAvailable = getCoopRuntimeExecutor(claw.runtime, req).protocol !== "runtime-retired";
        if (input.action === "approve" && autoExecutionAvailable && !req.sessionId) {
          const { queueApprovedCollaboration } = await import("../_core/collaboration/queue");
          await queueApprovedCollaboration({ ...req, status: "approved", approvedBy: claw.userId });
        } else if (input.action === "approve" && autoExecutionAvailable) {
          const port = parseInt(process.env.PORT || "5180", 10);
          const baseUrl = "http://127.0.0.1:" + port;
          // 用 fire-and-forget 的方式触发，不阻塞返回
          const internalSecret = process.env.INTERNAL_COLLAB_SECRET || "";
          fetchWithTimeout(baseUrl + "/api/claw/collab-exec", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(internalSecret ? { "x-internal-collab-secret": internalSecret } : {}),
            },
            body: JSON.stringify({
              requestId: input.requestId,
              targetAdoptId: input.adoptId,
            }),
          }).catch((err: any) => {
            console.error("[collab] auto-exec trigger failed:", err.message);
          });
        }

        return { success: true, autoExecutionAvailable };
      }),

    // 提交任务结果（目标方填写摘要，平台强制检查禁止词）
    submitResult: protectedProcedure
      .input(z.object({
        adoptId: z.string(),
        requestId: z.number(),
        // resultEnvelope: 结构化结果对象，向后兼容 resultSummary
        resultEnvelope: z.object({
          status: z.enum(["success", "failed", "partial", "needs_input"]),
          summary: z.string().max(2000),            // 给 Agent1 看的执行摘要
          structured_outputs: z.record(z.string(), z.unknown()).optional(), // 结构化结果字段
          artifacts: z.array(z.object({             // 文件产物引用
            artifact_id: z.string().max(64),
            name: z.string().max(255),
            mime_type: z.string().max(100).optional(),
            storage_uri: z.string().max(2000),
            preview_uri: z.string().max(2000).optional(),
            visibility: z.enum(["requester", "org", "private"]).default("requester"),
            owner_agent_id: z.string().max(64).optional(),
            size: z.number().optional(),
          })).max(20).optional(),
          confidence: z.number().min(0).max(1).optional(),
          limitations: z.string().max(500).optional(),  // 局限说明
          next_actions: z.array(z.string().max(200)).max(5).optional(), // 建议下一步
          error_info: z.string().max(500).optional(),    // 脱敏错误信息
        }).optional(),
        status: z.enum(["completed", "failed", "partial_success", "waiting_input"]),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getClawByAdoptId } = await import("../db");
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw || claw.userId !== ctx.user!.id) throw new TRPCError({ code: "FORBIDDEN" });
        const req = await getCollabRequest(input.requestId);
        if (!req || req.targetAdoptId !== input.adoptId) throw new TRPCError({ code: "NOT_FOUND" });
        if (!["approved", "running"].includes(req.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "request not in approved state" });

        // 安全检查 summary 字段
        const summaryText = input.resultEnvelope?.summary || "";
        const FORBIDDEN_IN_RESULT = ["session_id", "memory_id", "agent_id", "user_id:", "adoptId:", "sessionKey", "token:", "password", "secret"];
        const found2 = FORBIDDEN_IN_RESULT.filter(kw => summaryText.toLowerCase().includes(kw.toLowerCase()));
        if (found2.length > 0) throw new TRPCError({ code: "BAD_REQUEST", message: "结果摘要包含禁止内容，请只填写任务结论。" });
        const dbStatus = input.status === "partial_success" ? "partial_success" : input.status === "waiting_input" ? "waiting_input" : input.status === "failed" ? "failed" : "completed";
        await updateCollabRequest(input.requestId, {
          status: dbStatus,
          resultSummary: summaryText,   // 保持向后兼容
          completedAt: new Date(),
          resultMeta: input.resultEnvelope ? JSON.stringify(input.resultEnvelope) : null,
        } as any);
        return { success: true };
      }),

    // 主人决定给申请方看什么结果（结果控制层）
    deliverResult: protectedProcedure
      .input(z.object({
        adoptId: z.string(),
        requestId: z.number(),
        deliverMode: z.enum(["full", "summary", "none"]),
        customSummary: z.string().max(2000).optional(), // deliverMode=summary 时主人自定义的摘要
      }))
      .mutation(async ({ input, ctx }) => {
        const { getClawByAdoptId } = await import("../db");
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw || claw.userId !== ctx.user!.id) throw new TRPCError({ code: "FORBIDDEN" });
        const req = await getCollabRequest(input.requestId);
        if (!req || req.targetAdoptId !== input.adoptId) throw new TRPCError({ code: "NOT_FOUND" });
        if (!["completed", "partial_success"].includes(req.status)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "任务尚未完成，无法交付结果" });
        }

        // 根据主人选择，决定申请方能看到的内容
        let deliveredContent = "";
        if (input.deliverMode === "full") {
          deliveredContent = req.resultSummary || "";
        } else if (input.deliverMode === "summary") {
          deliveredContent = input.customSummary || req.resultSummary?.slice(0, 200) || "";
        } else {
          deliveredContent = ""; // none: 不发任何内容
        }

        // 把交付决策写入 resultMeta
        let existingMeta: any = {};
        try { existingMeta = JSON.parse((req as any).resultMeta || "{}"); } catch {}
        const updatedMeta = {
          ...existingMeta,
          deliverMode: input.deliverMode,
          deliveredContent,
          deliveredAt: new Date().toISOString(),
        };

        await updateCollabRequest(input.requestId, {
          resultMeta: JSON.stringify(updatedMeta),
          // 把交付结果写入 resultSummary 供申请方查看（if not none）
          resultSummary: deliveredContent,
          status: "completed",
        } as any);

        return { ok: true, deliverMode: input.deliverMode };
      }),

    // 收到的协作请求（含审计信息）
    incoming: protectedProcedure
      .input(z.object({ adoptId: z.string() }))
      .query(async ({ input, ctx }) => {
        const { getClawByAdoptId } = await import("../db");
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw || claw.userId !== ctx.user!.id) throw new TRPCError({ code: "FORBIDDEN" });
        const rows = await listIncomingCollabRequests(input.adoptId, 50);
        return rows.map(r => ({
          id: r.id,
          requesterAdoptId: r.requesterAdoptId,
          taskType: r.taskType,
          taskSummary: r.taskSummary,
          status: r.status,
          resultSummary: r.resultSummary,
          approvalMode: (r as any).approvalMode,
          riskLevel: (r as any).riskLevel,
          createdAt: r.createdAt,
          approvedAt: r.approvedAt,
          completedAt: r.completedAt,
          resultEnvelope: (r as any).resultMeta ? JSON.parse((r as any).resultMeta) : null,
          requesterDisplayName: (r as any).requesterDisplayName || null,
          // 不返回 inputPayload / executionScope 等内部字段
        }));
      }),

    // 发出的协作请求（含状态追踪）
    outgoing: protectedProcedure
      .input(z.object({ adoptId: z.string() }))
      .query(async ({ input, ctx }) => {
        const { getClawByAdoptId } = await import("../db");
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw || claw.userId !== ctx.user!.id) throw new TRPCError({ code: "FORBIDDEN" });
        const rawRows = await listOutgoingCollabRequests(input.adoptId, 50);
        // 批量查 targetDisplayName
        const targetAdoptIds = [...new Set(rawRows.map(r => r.targetAdoptId))];
        const displayMap = await listCollabDisplayNames(targetAdoptIds).catch(() => new Map());
        const rows = rawRows.map(r => ({ ...r, targetDisplayName: displayMap.get(r.targetAdoptId) || null }));
        return Promise.all(rows.map(async r => {
          let projection = projectLegacyCollaborationResult(r);
          if (r.taskType === "scheduling") {
            const target = await getClawByAdoptId(r.targetAdoptId);
            const policy = target?.userId === r.targetUserId ? collaborationSettingsForTask(await getCollabSettings(target.id), "scheduling") : null;
            const result = target?.userId === r.targetUserId ? projectCollaborationConclusion(r, policy?.sharingPolicy === "result-only") : { shared: false, summary: "" };
            projection = { resultSummary: result.summary, resultMeta: result.shared ? { summary: result.summary } : { deliverMode: "none" } };
          }
          return {
          id: r.id,
          targetAdoptId: r.targetAdoptId,
          taskType: r.taskType,
          taskSummary: r.taskSummary,
          status: r.status,
          resultSummary: projection.resultSummary,
          approvalMode: (r as any).approvalMode,
          riskLevel: (r as any).riskLevel,
          resultMeta: projection.resultMeta,
          resultEnvelope: projection.resultMeta,
          createdAt: r.createdAt,
          approvedAt: r.approvedAt,
          completedAt: r.completedAt,
          targetDisplayName: (r as any).targetDisplayName || null,
        }; }));
      }),

});
