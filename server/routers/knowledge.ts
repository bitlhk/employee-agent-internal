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
  listKnowledgeBasesOwnedByUser,
  listKnowledgeDocuments,
  updateKnowledgeDocumentGovernance,
  updateKnowledgeBaseRecord,
} from "../db";
import {
  getKnowledgeServiceHealth,
  publicKnowledgeDocument,
  queueKnowledgeIndex,
  searchKnowledgeBase,
} from "../_core/knowledge-service";
import {
  KNOWLEDGE_EXTENSIONS,
  knowledgeExtension,
  readKnowledgeDocumentSourceMetadata,
  removeKnowledgeBaseFiles,
  safeKnowledgeFilename,
} from "../_core/knowledge-storage";
import {
  buildCapturedKnowledgeMarkdown,
  normalizeCapturedKnowledgeTitle,
  persistCapturedKnowledge,
} from "../_core/knowledge-capture";
import { resolveRuntimeWorkspace } from "../_core/helpers";
import { resolveExistingWorkspacePath } from "../_core/file-path-security";
import { isWorkspaceUiVisiblePath } from "../_core/claw-files";
import { scanUploadForMalware, validateUploadContent } from "../_core/upload-security";
import { readFile, stat } from "fs/promises";
import path from "path";

const DEFAULT_CAPTURE_BASE_NAME = "我的工作沉淀";
const MAX_CAPTURE_FILE_BYTES = 50 * 1024 * 1024;

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

async function writableCaptureBase(ctx: any, adoptId: string, publicId?: string) {
  const actor = await identity(ctx, adoptId);
  if (publicId) {
    const base = await getAccessibleKnowledgeBase({ publicId, ...actor });
    if (!base) throw new TRPCError({ code: "NOT_FOUND", message: "知识库不存在或无权访问" });
    if (base.scope !== "personal" || base.ownerUserId !== actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "只能沉淀到自己的个人知识库" });
    }
    return { ...actor, base, created: false };
  }
  const existing = (await listKnowledgeBasesOwnedByUser(actor.userId)).find((base) => (
    base.scope === "personal" && base.name === DEFAULT_CAPTURE_BASE_NAME
  ));
  if (existing) return { ...actor, base: existing, created: false };
  const base = await createKnowledgeBaseRecord({
    publicId: `kb_${nanoid(18)}`,
    ownerUserId: actor.userId,
    ownerGroupId: actor.groupId,
    scope: "personal",
    name: DEFAULT_CAPTURE_BASE_NAME,
    description: "由岗位智能体对话与任务产物沉淀形成的个人知识。",
  });
  return { ...actor, base, created: true };
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
      const documents = (await listKnowledgeDocuments(base.id)).map((document) => ({
        ...publicKnowledgeDocument(document),
        source: readKnowledgeDocumentSourceMetadata(base.publicId, document.publicId),
      }));
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
      void queueKnowledgeIndex(base, "manual_reindex").catch(() => {});
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

  updateDocumentGovernance: protectedProcedure
    .input(z.object({
      adoptId: z.string().min(1).max(64),
      knowledgeBaseId: z.string().min(1).max(64),
      documentId: z.string().min(1).max(64),
      versionLabel: z.string().trim().min(1).max(64),
      lifecycle: z.enum(["draft", "active", "expired", "archived"]),
      sourceDepartment: z.string().trim().max(120).default(""),
      classification: z.enum(["public", "internal", "sensitive", "restricted"]),
      authority: z.enum(["official", "approved", "reference", "personal"]),
      externalProcessingAllowed: z.boolean(),
      effectiveAt: z.string().datetime().nullable().optional(),
      expiresAt: z.string().datetime().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { base, userId } = await accessibleBase(ctx, input.adoptId, input.knowledgeBaseId);
      if (base.ownerUserId !== userId && ctx.user!.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "无权维护该知识库的文档治理信息" });
      }
      const document = await getKnowledgeDocumentByPublicId(input.documentId);
      if (!document || document.knowledgeBaseId !== base.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "文档不存在" });
      }
      const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : null;
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (effectiveAt && expiresAt && expiresAt.getTime() <= effectiveAt.getTime()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "失效时间必须晚于生效时间" });
      }
      await updateKnowledgeDocumentGovernance({
        id: document.id,
        knowledgeBaseId: base.id,
        versionLabel: input.versionLabel,
        lifecycle: input.lifecycle,
        sourceDepartment: input.sourceDepartment,
        classification: input.classification,
        authority: input.authority,
        externalProcessingAllowed: input.externalProcessingAllowed,
        effectiveAt,
        expiresAt,
      });
      void queueKnowledgeIndex(base, "governance_changed").catch(() => {});
      return { ok: true };
    }),

  capture: protectedProcedure
    .input(z.discriminatedUnion("sourceType", [
      z.object({
        sourceType: z.literal("chat"),
        adoptId: z.string().min(1).max(64),
        knowledgeBaseId: z.string().min(1).max(64).optional(),
        title: z.string().trim().min(1).max(120),
        answer: z.string().trim().min(1).max(120_000),
        question: z.string().max(20_000).optional(),
        includeQuestion: z.boolean().default(false),
        conversationId: z.string().max(128).optional(),
        messageId: z.string().max(128).optional(),
        modelId: z.string().max(160).optional(),
      }),
      z.object({
        sourceType: z.literal("workspace"),
        adoptId: z.string().min(1).max(64),
        knowledgeBaseId: z.string().min(1).max(64).optional(),
        workspacePath: z.string().trim().min(1).max(700),
      }),
    ]))
    .mutation(async ({ input, ctx }) => {
      const target = await writableCaptureBase(ctx, input.adoptId, input.knowledgeBaseId);
      const capturedAt = new Date();
      if (input.sourceType === "chat") {
        const title = normalizeCapturedKnowledgeTitle(input.title) || "岗位智能体工作沉淀";
        const markdown = buildCapturedKnowledgeMarkdown({
          title,
          answer: input.answer,
          question: input.question,
          includeQuestion: input.includeQuestion,
          capturedAt,
        });
        const saved = await persistCapturedKnowledge({
          base: target.base,
          filename: `${safeKnowledgeFilename(title)}.md`,
          content: Buffer.from(markdown, "utf8"),
          metadata: {
            type: "chat",
            capturedAt: capturedAt.toISOString(),
            adoptId: input.adoptId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            modelId: input.modelId,
            captureMode: input.includeQuestion ? "turn" : "answer",
          },
        });
        return {
          ok: true,
          duplicate: saved.duplicate,
          createdBase: target.created,
          knowledgeBase: target.base,
          document: publicKnowledgeDocument(saved.document),
        };
      }

      if (!isWorkspaceUiVisiblePath(input.workspacePath)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "该工作空间文件不能加入知识库" });
      }
      const workspace = resolveRuntimeWorkspace(target.claw, input.adoptId);
      const absolute = resolveExistingWorkspacePath(workspace, input.workspacePath);
      if (!absolute) throw new TRPCError({ code: "NOT_FOUND", message: "工作空间文件不存在" });
      const fileStat = await stat(absolute);
      if (!fileStat.isFile()) throw new TRPCError({ code: "BAD_REQUEST", message: "只能加入文件" });
      if (fileStat.size > MAX_CAPTURE_FILE_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "文件超过知识库大小限制" });
      const filename = safeKnowledgeFilename(path.basename(input.workspacePath));
      const extension = knowledgeExtension(filename);
      if (!KNOWLEDGE_EXTENSIONS.has(extension)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `暂不支持 .${extension || "unknown"} 文件` });
      }
      const content = await readFile(absolute);
      const contentCheck = validateUploadContent(extension, content);
      if (!contentCheck.ok) throw new TRPCError({ code: "BAD_REQUEST", message: contentCheck.error });
      const malwareCheck = await scanUploadForMalware(content);
      if (!malwareCheck.ok) throw new TRPCError({ code: "BAD_REQUEST", message: malwareCheck.error });
      const saved = await persistCapturedKnowledge({
        base: target.base,
        filename,
        content,
        metadata: {
          type: "workspace",
          capturedAt: capturedAt.toISOString(),
          adoptId: input.adoptId,
          workspacePath: input.workspacePath,
        },
      });
      return {
        ok: true,
        duplicate: saved.duplicate,
        createdBase: target.created,
        knowledgeBase: target.base,
        document: publicKnowledgeDocument(saved.document),
      };
    }),
});
