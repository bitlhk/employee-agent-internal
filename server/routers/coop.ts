/**
 * 岗位智能体组织协作 V2 - tRPC 路由
 *
 * 灰度策略：发起相关操作（create / mentionCandidates）限制白名单
 * 查询类（getSession / pendingCount）只需登录（被邀请者需要看）
 */
import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createCoopSession,
  getCoopSession,
  countPendingCoop,
  listMentionCandidates,
  agreeCoopRequest,
  rejectCoopRequest,
  listCoopEventsSince,
  publishCoopSession,
  closeCoopSession,
  buildOrchestratorInput,
  isSessionReadyToConsolidate,
  listMyCoopSessions,
} from "../db/coop";
import { requireActiveCoopProfile } from "../db/coop-identity";
import { consolidateCoopSession } from "../_core/coop-orchestrator";
import { notifyCoopEvent } from "../_core/coop-notify";
import { listCoopFilesForSession, normalizeCoopAttachments } from "../db/coop-files";

function deriveCoopTitle(text: string): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "未命名协作";
  return clean.length > 48 ? `${clean.slice(0, 48)}...` : clean;
}

function coopAccessMessage(kind: string): string {
  switch (kind) {
    case "profile_missing":
      return "当前用户未配置组织协作资料，请联系管理员开通";
    case "profile_pending":
      return "当前用户组织协作权限待启用，请联系管理员";
    case "profile_disabled":
      return "当前用户组织协作权限已停用";
    case "space_missing":
      return "当前用户未分配协作空间，请联系管理员";
    case "space_disabled":
      return "当前协作空间已停用";
    default:
      return "当前用户没有组织协作权限";
  }
}

const activeCoopProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const access = await requireActiveCoopProfile(ctx.user!.id);
  if (!access.ok) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: coopAccessMessage(access.error.kind),
    });
  }
  return next();
});

export const coopRouter = router({
  // ── 发起协作 session（后台组织协作权限）────────────────
  create: activeCoopProcedure
    .input(
      z.object({
        title: z.string().min(1).max(200),
        originMessage: z.string().max(10_000),
        consolidationPromptPreset: z.string().max(1000).optional(),
        creatorAdoptId: z.string().min(1),
        members: z
          .array(
            z.object({
              userId: z.number().int().positive(),
              targetAdoptId: z.string().min(1),
              subtask: z.string().min(1).max(2000),
              taskType: z.string().max(64).optional(),
            })
          )
          .min(1)
          .max(10),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const result = await createCoopSession({
        creatorUserId: ctx.user!.id,
        creatorAdoptId: input.creatorAdoptId,
        title: input.title,
        originMessage: input.originMessage,
        consolidationPromptPreset: input.consolidationPromptPreset,
        members: input.members,
      });
      // 异步推送邀请通知（微信/站内），不阻塞响应
      notifyCoopEvent({
        type: "session_created",
        sessionId: result.sessionId,
        creatorUserId: ctx.user!.id,
        creatorName: ctx.user!.name || ctx.user!.email || "发起人",
        title: input.title,
        members: input.members.map((m, i) => ({
          userId: m.userId,
          adoptId: m.targetAdoptId,
          subtask: m.subtask,
          requestId: result.requestIds[i],
        })),
      }).catch((e) => console.error("[coop] notify failed:", e));
      return result;
    }),

  // ── 查 session 详情（需登录；创建人或成员可见） ────────
  getSession: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const r = await getCoopSession(input.sessionId, ctx.user!.id);
      if (!r) throw new TRPCError({ code: "NOT_FOUND" });
      return r;
    }),

  // ── 发起人：修改协作标题 ───────────────────────────
  updateTitle: protectedProcedure
    .input(z.object({
      sessionId: z.string().min(1).max(80),
      title: z.string().min(1).max(120),
    }))
    .mutation(async ({ input, ctx }) => {
      const title = deriveCoopTitle(input.title);
      const ses = await getCoopSession(input.sessionId, ctx.user!.id);
      if (!ses) throw new TRPCError({ code: "NOT_FOUND", message: "协作不存在或无权访问" });
      if ((ses.session as any).creatorUserId !== ctx.user!.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "只有发起人可以修改协作名称" });
      }

      const { getDb } = await import("../db");
      const { lxCoopSessions } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const { appendCoopEvent } = await import("../db/coop");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(lxCoopSessions).set({ title }).where(eq(lxCoopSessions.id, input.sessionId));
      await appendCoopEvent({
        sessionId: input.sessionId,
        eventType: "session_renamed",
        actorUserId: ctx.user!.id,
        payload: { title },
      });
      return { ok: true, title };
    }),

  // ── 我的协作列表（发起 + 参与） ────────────────────
  listMySessions: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ input, ctx }) => {
      return await listMyCoopSessions(ctx.user!.id, input?.limit ?? 50);
    }),

    // ── 侧栏红点计数（只需登录） ─────────────────────────
  pendingCount: protectedProcedure.query(async ({ ctx }) => {
    return await countPendingCoop(ctx.user!.id);
  }),

  // ── @ mention 候选池（后台组织协作权限）────────────────
  mentionCandidates: activeCoopProcedure
    .input(
      z
        .object({
          keyword: z.string().optional(),
          groupId: z.number().int().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      return await listMentionCandidates({ ...(input || {}), viewerUserId: ctx.user!.id });
    }),

  // ── 被邀请者：同意 ─────────────────────────────────
  agree: activeCoopProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      modifiedSubtask: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const r = await agreeCoopRequest({
          requestId: input.requestId,
          userId: ctx.user!.id,
          modifiedSubtask: input.modifiedSubtask,
        });
        return r;
      } catch (e: any) {
        throw new TRPCError({
          code: e?.message?.includes("forbidden") ? "FORBIDDEN" : "BAD_REQUEST",
          message: e?.message || "agree failed",
        });
      }
    }),

  // ── 被邀请者：拒绝 ─────────────────────────────────
  reject: activeCoopProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const r = await rejectCoopRequest({
          requestId: input.requestId,
          userId: ctx.user!.id,
          reason: input.reason,
        });
        return r;
      } catch (e: any) {
        throw new TRPCError({
          code: e?.message?.includes("forbidden") ? "FORBIDDEN" : "BAD_REQUEST",
          message: e?.message || "reject failed",
        });
      }
    }),

  // ── 接收方：提交协作子任务结果（手动版，区别于 mock 自动跑）─────
  //   - 权限：当前用户必须是 request 的 targetUserId
  //   - 状态：群聊式协作允许 pending / approved / running 直接提交
  //   - payload.attachments 是 [{name, url, source: 'chat'|'task-xxx', size?}]
  //   - skipMemoryWrite: true 时记入 event payload，下游 memory-extractor 跳过此对话
  submitResult: activeCoopProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      resultText: z.string().min(1).max(20000),
      attachments: z.array(z.object({
        name: z.string().max(300),
        url: z.string().max(2000),
        source: z.enum(["chat", "task", "agent_workspace"]).default("chat"),
        size: z.number().int().nonnegative().optional(),
        adoptId: z.string().max(80).optional(),
        path: z.string().max(1000).optional(),
        fileId: z.number().int().positive().optional(),
      })).max(50).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { getDb } = await import("../db");
      const { clawCollabRequests } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const { appendCoopEvent } = await import("../db/coop");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "db not available" });

      // 拉 request + 校验权限
      const rows = await db
        .select({ req: clawCollabRequests })
        .from(clawCollabRequests)
        .where(eq(clawCollabRequests.id, input.requestId))
        .limit(1);
      const r = rows[0]?.req;
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "request not found" });
      if (r.targetUserId !== ctx.user!.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "not your request" });
      }
      if (!["pending", "running", "approved"].includes(r.status)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `cannot submit on status=${r.status}` });
      }

      const attachments = await normalizeCoopAttachments({
        sessionId: r.sessionId!,
        ownerUserId: ctx.user!.id,
        requestId: input.requestId,
        attachments: input.attachments || [],
      });

      // update request
      await db.update(clawCollabRequests)
        .set({
          status: "completed",
          resultSummary: input.resultText,
          completedAt: new Date(),
        })
        .where(eq(clawCollabRequests.id, input.requestId));

      // append event（含附件 + skipMemoryWrite hint）
      await appendCoopEvent({
        sessionId: r.sessionId!,
        eventType: "member_completed",
        actorUserId: ctx.user!.id,
        actorAdoptId: r.targetAdoptId,
        requestId: input.requestId,
        payload: {
          mode: "manual",
          text: input.resultText,
          attachments,
        },
      });

      return { ok: true, status: "completed" };
    }),

  // ── 发起人：软删除协作（写 deleted_at）─────────────────
  //   - 权限：creator-only
  //   - 行为：软删（数据保留），listMySessions 自动过滤；30 天回收站可后续做
  //   - 状态：任何状态都允许删（包括 published/closed）
  softDelete: activeCoopProcedure
    .input(z.object({ sessionId: z.string().min(1).max(80) }))
    .mutation(async ({ input, ctx }) => {
      const { getDb } = await import("../db");
      const { lxCoopSessions } = await import("../../drizzle/schema");
      const { eq, sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const rows = await db
        .select({ creator: lxCoopSessions.creatorUserId, deletedAt: sql`deleted_at` as any })
        .from(lxCoopSessions)
        .where(eq(lxCoopSessions.id, input.sessionId))
        .limit(1);
      const s = rows[0];
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "协作不存在" });
      if (s.creator !== ctx.user!.id) throw new TRPCError({ code: "FORBIDDEN", message: "只有发起人能删除" });
      if (s.deletedAt) return { ok: true, alreadyDeleted: true };

      await db.execute(sql`UPDATE lx_coop_sessions SET deleted_at = NOW() WHERE id = ${input.sessionId}`);
      const { appendCoopEvent } = await import("../db/coop");
      await appendCoopEvent({
        sessionId: input.sessionId,
        eventType: "session_deleted",
        actorUserId: ctx.user!.id,
      });
      return { ok: true };
    }),

  // ── 任何成员/发起人：从我的列表隐藏/取消隐藏 ──────────
  //   - hide=true: insert lx_coop_user_hidden
  //   - hide=false: delete from lx_coop_user_hidden
  //   - 权限：当前 user 必须是该 session 的成员或发起人（防伪造）
  toggleHide: activeCoopProcedure
    .input(z.object({ sessionId: z.string().min(1).max(80), hide: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const { getDb } = await import("../db");
      const { lxCoopSessions, clawCollabRequests } = await import("../../drizzle/schema");
      const { eq, sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // 校验：当前 user 是 creator 或 member
      const sesRows = await db
        .select({ creator: lxCoopSessions.creatorUserId })
        .from(lxCoopSessions)
        .where(eq(lxCoopSessions.id, input.sessionId))
        .limit(1);
      if (!sesRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "协作不存在" });
      const isCreator = sesRows[0].creator === ctx.user!.id;
      if (!isCreator) {
        const memRows = await db
          .select({ uid: clawCollabRequests.targetUserId })
          .from(clawCollabRequests)
          .where(eq(clawCollabRequests.sessionId, input.sessionId));
        const isMember = memRows.some((m) => m.uid === ctx.user!.id);
        if (!isMember) throw new TRPCError({ code: "FORBIDDEN", message: "你不是该协作的成员" });
      }

      if (input.hide) {
        await db.execute(sql`INSERT IGNORE INTO lx_coop_user_hidden (user_id, session_id) VALUES (${ctx.user!.id}, ${input.sessionId})`);
      } else {
        await db.execute(sql`DELETE FROM lx_coop_user_hidden WHERE user_id = ${ctx.user!.id} AND session_id = ${input.sessionId}`);
      }
      return { ok: true, hidden: input.hide };
    }),

  // ── 列事件流（支持增量轮询）─────────────────────────
  listEvents: protectedProcedure
    .input(z.object({
      sessionId: z.string().min(1),
      sinceId: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(200),
    }))
    .query(async ({ input, ctx }) => {
      // 权限：creator 或成员
      const ses = await getCoopSession(input.sessionId, ctx.user!.id);
      if (!ses) throw new TRPCError({ code: "NOT_FOUND" });
      const events = await listCoopEventsSince(input.sessionId, input.sinceId, input.limit);
      return { events, latestId: events.length > 0 ? Number(events[events.length - 1].id) : input.sinceId };
    }),

  // ── 协作共享文件列表 ───────────────────────────────
  files: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1).max(80) }))
    .query(async ({ input, ctx }) => {
      return await listCoopFilesForSession(input.sessionId, ctx.user!.id);
    }),

  // ── 群消息：当前 session 发起人或成员可发送普通群消息 ─────
  sendMessage: protectedProcedure
    .input(z.object({
      sessionId: z.string().min(1).max(80),
      text: z.string().min(1).max(10000),
      attachments: z.array(z.object({
        name: z.string().min(1).max(300),
        url: z.string().min(1).max(2000),
        source: z.enum(["chat", "task", "agent_workspace"]).default("chat"),
        size: z.number().int().nonnegative().optional(),
        adoptId: z.string().max(80).optional(),
        path: z.string().max(1000).optional(),
      })).max(50).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const ses = await getCoopSession(input.sessionId, ctx.user!.id);
      if (!ses) throw new TRPCError({ code: "NOT_FOUND", message: "协作不存在或无权访问" });
      const attachments = await normalizeCoopAttachments({
        sessionId: input.sessionId,
        ownerUserId: ctx.user!.id,
        attachments: input.attachments || [],
      });
      const { appendCoopEvent } = await import("../db/coop");
      await appendCoopEvent({
        sessionId: input.sessionId,
        eventType: "group_message",
        actorUserId: ctx.user!.id,
        payload: { text: input.text.trim(), attachments },
      });
      const recipientUserIds = [
        Number((ses.creator as any)?.userId || 0),
        ...((ses.members || []) as any[]).map((m) => Number(m.targetUserId || 0)),
      ].filter((uid) => uid > 0);
      notifyCoopEvent({
        type: "group_message",
        sessionId: input.sessionId,
        actorUserId: ctx.user!.id,
        actorName: ctx.user!.name || ctx.user!.email || "协作成员",
        title: String((ses.session as any).title || "协作任务"),
        text: input.text.trim(),
        recipientUserIds,
      }).catch((e) => console.error("[coop] group message notify failed:", e));
      const currentTitle = String((ses.session as any).title || "").trim();
      if (!currentTitle || currentTitle === "未命名协作") {
        const { getDb } = await import("../db");
        const { lxCoopSessions } = await import("../../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (db) {
          await db
            .update(lxCoopSessions)
            .set({ title: deriveCoopTitle(input.text) })
            .where(eq(lxCoopSessions.id, input.sessionId));
        }
      }
      return { ok: true };
    }),

    // ── 整合：调 LLM 生成汇总草稿（发起人触发，不写入 DB）────
  consolidate: activeCoopProcedure
    .input(z.object({
      sessionId: z.string().min(1),
      // 2026-04-17: 发起人可填的自定义汇总指令（如格式要求/重点关注/字数限制）
      customInstructions: z.string().max(1000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const data = await buildOrchestratorInput(input.sessionId);
      if (data.session.creatorUserId !== ctx.user!.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "only creator can consolidate" });
      }
      if (!isSessionReadyToConsolidate(data.members.map((m) => ({ status: m.status })))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "session not ready: some members not in terminal status" });
      }
      const { draft, providerUsed } = await consolidateCoopSession({
        sessionTitle: data.session.title || "协作任务",
        originMessage: data.session.originMessage || "",
        members: data.members,
        customInstructions: input.customInstructions,
      });
      // 记录 consolidation_drafted 事件
      const { appendCoopEvent } = await import("../db/coop");
      await appendCoopEvent({
        sessionId: input.sessionId,
        eventType: "consolidation_drafted",
        actorUserId: ctx.user!.id,
        payload: {
          providerUsed,
          draftLength: draft.length,
          hasCustomInstructions: Boolean(input.customInstructions?.trim()),
        },
      });
      return { draft, providerUsed };
    }),

  // ── 发布：写入 final_summary + 全员可见 ────────────────
  publish: activeCoopProcedure
    .input(z.object({
      sessionId: z.string().min(1),
      finalSummary: z.string().min(1).max(20_000),
      finalArtifacts: z.array(z.any()).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const r = await publishCoopSession({
          sessionId: input.sessionId,
          creatorUserId: ctx.user!.id,
          finalSummary: input.finalSummary,
          finalArtifacts: input.finalArtifacts,
        });
        // 发微信通知所有成员
        const { notifyCoopEvent } = await import("../_core/coop-notify");
        const data = await buildOrchestratorInput(input.sessionId);
        const memberIds = Array.from(
          new Set(data.members.map((m: any) => m.req?.targetUserId).filter(Boolean))
        );
        // 需要从 members 拿 targetUserId；上面的 mapping 没暴露，下面重新查
        const { getCoopSession } = await import("../db/coop");
        const snap = await getCoopSession(input.sessionId, ctx.user!.id);
        const allMemberIds = Array.from(new Set(snap!.members.map((m) => m.targetUserId)));
        notifyCoopEvent({
          type: "session_published",
          sessionId: input.sessionId,
          title: data.session.title || "协作任务",
          memberUserIds: allMemberIds.filter((id) => id !== ctx.user!.id),
        }).catch((e) => console.error("[coop] publish notify failed:", e));
        return r;
      } catch (e: any) {
        throw new TRPCError({
          code: e?.message?.includes("forbidden") ? "FORBIDDEN" : "BAD_REQUEST",
          message: e?.message || "publish failed",
        });
      }
    }),

  // ── 关闭/解散 ──────────────────────────────────────
  close: activeCoopProcedure
    .input(z.object({
      sessionId: z.string().min(1),
      mode: z.enum(["dissolve", "keep"]).default("keep"),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await closeCoopSession({
          sessionId: input.sessionId,
          creatorUserId: ctx.user!.id,
          mode: input.mode,
        });
      } catch (e: any) {
        throw new TRPCError({
          code: e?.message?.includes("forbidden") ? "FORBIDDEN" : "BAD_REQUEST",
          message: e?.message || "close failed",
        });
      }
    }),

    // ── 组织协作准入状态（前端用来判断是否渲染入口）───────
  isWhitelisted: protectedProcedure.query(async ({ ctx }) => {
    const access = await requireActiveCoopProfile(ctx.user!.id);
    return {
      whitelisted: access.ok,
      reason: access.ok ? null : access.error.kind,
      message: access.ok ? null : coopAccessMessage(access.error.kind),
    };
  }),
});
