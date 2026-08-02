import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  getCollabSettings,
  upsertCollabSettings,
  listCollabDirectory,
  listCollabDisplayNames,
  createCollabRequest,
  getCollabRequest,
  updateCollabRequest,
  listIncomingCollabRequests,
  listOutgoingCollabRequests,
} from "../db";
import { fetchWithTimeout } from "../_core/fetch-timeout";

export const collabRouter = router({

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
      }))
      .mutation(async ({ input, ctx }) => {
        const { getClawByAdoptId } = await import("../db");
        const requester = await getClawByAdoptId(input.requesterAdoptId);
        if (!requester || requester.userId !== ctx.user!.id) throw new TRPCError({ code: "FORBIDDEN" });
        if (requester.permissionProfile === "starter") throw new TRPCError({ code: "FORBIDDEN", message: "当前智能体未开通协作权限，请联系管理员处理" });
        const target = await getClawByAdoptId(input.targetAdoptId);
        if (!target || target.permissionProfile === "starter") throw new TRPCError({ code: "NOT_FOUND" });
        const targetSettings = await getCollabSettings(target.id);
        if (!targetSettings || targetSettings.acceptTask === "off") {
          throw new TRPCError({ code: "FORBIDDEN", message: "target agent does not accept collaboration tasks" });
        }

        // ── 第1层：字段白名单过滤（auto 模式更严格）──────────────────────
        // 无论什么模式，以下敏感字段一律剔除
        const ALWAYS_BLOCKED = ["chat_history","memory","session","sessionKey","messages","history","context","user_data","personal_data","private"];
        // auto 模式只允许这些字段通过（防止 prompt 注入绕过类型检查）
        const AUTO_ALLOWED = ["input", "query", "file", "url", "keyword", "date_range", "filters", "target"];

        let safeInput: Record<string, unknown> = {};
        if (input.inputPayload) {
          if (targetSettings.acceptTask === "auto") {
            // auto 模式：严格白名单，只允许 AUTO_ALLOWED 字段
            safeInput = Object.fromEntries(
              Object.entries(input.inputPayload).filter(([k]) => AUTO_ALLOWED.includes(k))
            );
          } else {
            // manual 模式：黑名单过滤
            safeInput = Object.fromEntries(
              Object.entries(input.inputPayload).filter(([k]) => !ALWAYS_BLOCKED.some(b => k.toLowerCase().includes(b)))
            );
          }
        }

        // ── 第2层：执行上下文约束（注入到请求记录，未来 agent 执行时读取）──
        const EXECUTION_CONTEXT_DENY = ["chat_history", "memory_files", "session_context", "usage_logs", "private_notes"];
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
        const effectiveStatus = (isAutoMode && riskLevel !== "high") ? "approved" : "pending";

        // 检查 auto 模式下 taskType 是否在目标 allowedTaskTypes 里
        if (isAutoMode) {
          const allowed: string[] = targetSettings.allowedTaskTypes ? JSON.parse(targetSettings.allowedTaskTypes) : [];
          if (allowed.length > 0 && !allowed.includes(input.taskType)) {
            throw new TRPCError({ code: "FORBIDDEN", message: "auto mode: taskType not in allowed list" });
          }
        }

        const id = await createCollabRequest({
          requesterAdoptId: input.requesterAdoptId,
          targetAdoptId: input.targetAdoptId,
          requesterUserId: requester.userId,
          targetUserId: target.userId,
          taskType: input.taskType,
          taskSummary: input.taskSummary,
          inputPayload: JSON.stringify(safeInput),
          status: effectiveStatus,
          approvalMode: isAutoMode ? "auto" : "manual",
          approvedBy: (isAutoMode && effectiveStatus === "approved") ? null : undefined,
          executionScope,
          riskLevel,
          constraintsApplied: JSON.stringify({ autoAllowedFields: isAutoMode ? AUTO_ALLOWED : null, alwaysBlocked: ALWAYS_BLOCKED }),
        } as any);

        return {
          id,
          status: effectiveStatus,
          riskLevel,
          approvalMode: isAutoMode ? "auto" : "manual",
          note: effectiveStatus === "pending" && isAutoMode ? "auto模式但风险等级high，已降级为需人工审批" : undefined,
        };
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
        if (!["pending"].includes(req.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "request already processed" });
        await updateCollabRequest(input.requestId, {
          status: input.action === "approve" ? "approved" : "rejected",
          approvedAt: input.action === "approve" ? new Date() : undefined,
          approvedBy: input.action === "approve" ? claw.userId : undefined,
        } as any);

        // 审批通过后：自动触发 collab-exec，让目标 agent 开始执行任务
        if (input.action === "approve") {
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

        return { success: true };
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
        if (!["approved"].includes(req.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "request not in approved state" });

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
          ...(input.deliverMode !== "none" ? { resultSummary: deliveredContent } : {}),
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
        return rows.map(r => ({
          id: r.id,
          targetAdoptId: r.targetAdoptId,
          taskType: r.taskType,
          taskSummary: r.taskSummary,
          status: r.status,
          resultSummary: r.resultSummary,
          approvalMode: (r as any).approvalMode,
          riskLevel: (r as any).riskLevel,
          resultMeta: (r as any).resultMeta ? JSON.parse((r as any).resultMeta) : null,
          resultEnvelope: (r as any).resultMeta ? JSON.parse((r as any).resultMeta) : null,
          createdAt: r.createdAt,
          approvedAt: r.approvedAt,
          completedAt: r.completedAt,
          targetDisplayName: (r as any).targetDisplayName || null,
        }));
      }),

});
