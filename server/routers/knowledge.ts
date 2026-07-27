import { nanoid } from "nanoid";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { assertClawOwnerOrThrow } from "./helpers";
import {
  createKnowledgeBaseRecord,
  deleteKnowledgeBaseRecord,
  deleteKnowledgeDocumentsByBase,
  getAccessibleKnowledgeBase,
  getKnowledgeDocumentByPublicId,
  listAccessibleKnowledgeBases,
  listKnowledgeDocuments,
  updateKnowledgeBaseRecord,
} from "../db";
import {
  getKnowledgeServiceHealth,
  publicKnowledgeDocument,
  queueKnowledgeIndex,
  searchKnowledgeBase,
} from "../_core/knowledge-service";
import { removeKnowledgeBaseFiles } from "../_core/knowledge-storage";

async function identity(ctx: any, adoptId: string) {
  const claw = await assertClawOwnerOrThrow(ctx, adoptId);
  return {
    claw,
    userId: Number(ctx.user!.id),
    groupId: Number(ctx.user!.groupId || 0),
    roleTemplate: String(claw.roleTemplate || "general-assistant"),
  };
}

async function accessibleBase(ctx: any, adoptId: string, publicId: string) {
  const actor = await identity(ctx, adoptId);
  const base = await getAccessibleKnowledgeBase({ publicId, ...actor });
  if (!base) throw new TRPCError({ code: "NOT_FOUND", message: "知识库不存在或无权访问" });
  return { ...actor, base };
}

export const knowledgeRouter = router({
  list: protectedProcedure
    .input(z.object({ adoptId: z.string().min(1).max(64) }))
    .query(async ({ input, ctx }) => {
      const actor = await identity(ctx, input.adoptId);
      const items = await listAccessibleKnowledgeBases(actor);
      return { items };
    }),

  detail: protectedProcedure
    .input(z.object({ adoptId: z.string().min(1).max(64), knowledgeBaseId: z.string().min(1).max(64) }))
    .query(async ({ input, ctx }) => {
      const { base } = await accessibleBase(ctx, input.adoptId, input.knowledgeBaseId);
      const documents = (await listKnowledgeDocuments(base.id)).map(publicKnowledgeDocument);
      return { base, documents };
    }),

  create: protectedProcedure
    .input(z.object({
      adoptId: z.string().min(1).max(64),
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).default(""),
    }))
    .mutation(async ({ input, ctx }) => {
      const actor = await identity(ctx, input.adoptId);
      return createKnowledgeBaseRecord({
        publicId: `kb_${nanoid(18)}`,
        ownerUserId: actor.userId,
        ownerGroupId: actor.groupId,
        scope: "personal",
        roleTemplate: null,
        name: input.name,
        description: input.description,
      });
    }),

  update: protectedProcedure
    .input(z.object({
      adoptId: z.string().min(1).max(64),
      knowledgeBaseId: z.string().min(1).max(64),
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).default(""),
    }))
    .mutation(async ({ input, ctx }) => {
      const { base, userId } = await accessibleBase(ctx, input.adoptId, input.knowledgeBaseId);
      if (base.scope !== "personal" || base.ownerUserId !== userId) throw new TRPCError({ code: "FORBIDDEN", message: "只读知识库不能修改" });
      await updateKnowledgeBaseRecord({ id: base.id, ownerUserId: userId, name: input.name, description: input.description });
      return { ok: true };
    }),

  remove: protectedProcedure
    .input(z.object({ adoptId: z.string().min(1).max(64), knowledgeBaseId: z.string().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      const { base, userId } = await accessibleBase(ctx, input.adoptId, input.knowledgeBaseId);
      if (base.scope !== "personal" || base.ownerUserId !== userId) throw new TRPCError({ code: "FORBIDDEN", message: "只读知识库不能删除" });
      await deleteKnowledgeDocumentsByBase(base.id);
      const removed = await deleteKnowledgeBaseRecord(base.id, userId);
      if (removed) removeKnowledgeBaseFiles(base.publicId);
      return { ok: removed };
    }),

  reindex: protectedProcedure
    .input(z.object({ adoptId: z.string().min(1).max(64), knowledgeBaseId: z.string().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      const { base, userId } = await accessibleBase(ctx, input.adoptId, input.knowledgeBaseId);
      if (base.ownerUserId !== userId && ctx.user!.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "只读知识库不能重建索引" });
      void queueKnowledgeIndex(base).catch(() => {});
      return { ok: true, status: "indexing" as const };
    }),

  search: protectedProcedure
    .input(z.object({
      adoptId: z.string().min(1).max(64),
      knowledgeBaseId: z.string().min(1).max(64),
      query: z.string().trim().min(1).max(4000),
      limit: z.number().int().min(1).max(20).default(8),
    }))
    .query(async ({ input, ctx }) => {
      const { base } = await accessibleBase(ctx, input.adoptId, input.knowledgeBaseId);
      return searchKnowledgeBase(base, input.query, input.limit);
    }),

  serviceHealth: protectedProcedure
    .query(async () => getKnowledgeServiceHealth()),

  documentInfo: protectedProcedure
    .input(z.object({ adoptId: z.string().min(1).max(64), knowledgeBaseId: z.string().min(1).max(64), documentId: z.string().min(1).max(64) }))
    .query(async ({ input, ctx }) => {
      const { base } = await accessibleBase(ctx, input.adoptId, input.knowledgeBaseId);
      const document = await getKnowledgeDocumentByPublicId(input.documentId);
      if (!document || document.knowledgeBaseId !== base.id) throw new TRPCError({ code: "NOT_FOUND", message: "文档不存在" });
      return publicKnowledgeDocument(document);
    }),
});
