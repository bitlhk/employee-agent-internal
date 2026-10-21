import { TRPCError } from "@trpc/server";
import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import path from "path";
import { z } from "zod";
import { auditActor, auditErrorMetadata, auditRequest, recordAuditBestEffort, recordAuditRequired } from "../_core/audit-events";
import { getAvailableJiuwenModels } from "../_core/available-models";
import { JIUWEN_AUTO_MODEL_ID } from "../_core/jiuwenswarm-model-admin";
import { getSkillMcpRequirement } from "../_core/role-templates";
import { probeJiuwenSkillMcpReadiness } from "../_core/skill-mcp-readiness";
import { listRepositorySkillCandidates, prepareSkillValueEvaluationPlan, } from "../_core/skill-value-evaluation";
import { buildPrioritySkillValueEvaluationSupportCatalog, resolveSkillValueRoleTemplate, } from "../_core/skill-value-evaluation-catalog";
import { createEaSkillEvaluationContextAdapter, ensureEaSkillEvaluationContextPrincipal, } from "../_core/skill-value-evaluation-context";
import { cancelSkillValueEvaluationJob, getSkillValueEvaluationJob, listSkillValueEvaluationJobs, startSkillValueEvaluationJob } from "../_core/skill-value-evaluation-runner";
import { assessSkillValueEvaluationSupport, inspectCuratedSkillValueSuite, } from "../_core/skill-value-evaluation-support";
import { digestSkillSourceTree } from "../_core/skills/skill-artifact-digest";
import { parseSkillSourceDirectory } from "../_core/skills/skill-source";
import { remapLegacySkillMarketPath, removeSkillStorePath, safeSkillStorePath } from "../_core/skills/skill-store";
import { adminProcedure } from "../_core/trpc";
import { deleteSkillMarketItem, getSkillIdentityById, getSkillIdentityBySkillId, getSkillMarketItem, getSkillVersionById, getSkillVersionByLegacyMarketId, insertSkillMarketItem, listSkillMarketItems, listSkillMarketV2Projection, listSkillVersionsByIdentity, reviewSkillVersionByLegacyMarketId, syncGlobalOpenSourceSkillGrants, updateSkillMarketItem } from "../db";
import { resolveSkillValueArtifact, safeChildPath, skillIdSchema, skillMarketDir } from './claw-shared';
import { APP_ROOT } from "./helpers";

export const clawSkillAdminProcedures = {
adminListMarketSkills: adminProcedure
      .input(z.object({ status: z.string().optional() }).optional())
      .query(async ({ input }) => {
        const rows = await listSkillMarketItems(input?.status);
        const projection = await listSkillMarketV2Projection(
          rows.map(row => String(row.skillId || "")).filter(Boolean),
          undefined,
          true,
        ).catch(() => ({ identities: [], versions: [], installations: [] }));
        const identityBySkillId = new Map(projection.identities.map(identity => [identity.skillId, identity]));
        const versionByMarketId = new Map(projection.versions
          .filter(version => version.legacyMarketId)
          .map(version => [Number(version.legacyMarketId), version]));
        const versionCount = new Map<string, number>();
        for (const version of projection.versions) {
          versionCount.set(version.skillIdentityId, (versionCount.get(version.skillIdentityId) || 0) + 1);
        }
        return rows.map(row => {
          const identity = identityBySkillId.get(String(row.skillId || ""));
          const version = versionByMarketId.get(Number(row.id));
          return {
            ...row,
            identityId: identity?.identityId,
            maintainerType: identity?.maintainerType,
            maintainerUserId: identity?.maintainerUserId,
            versionId: version?.versionId,
            artifactSha256: version?.artifactSha256,
            versionCount: identity ? versionCount.get(identity.identityId) || 0 : 0,
          };
        });
      }),
adminSkillEvaluationContext: adminProcedure
      .input(z.object({ skillId: skillIdSchema }))
      .query(async ({ input }) => {
        const marketRows = (await listSkillMarketItems())
          .filter(row => String(row.skillId || "") === input.skillId);
        const marketItem = marketRows.find(row => row.status === "approved") || marketRows[0];
        if (!marketItem) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Skill 不存在" });
        }
        const identity = await getSkillIdentityBySkillId(input.skillId);
        const storedVersions = identity
          ? (await listSkillVersionsByIdentity(identity.identityId))
            .filter(version => version.status === "approved")
          : [];
        const approvedVersions = storedVersions.length > 0
          ? storedVersions.map(version => ({
              versionId: version.versionId,
              version: version.version,
              artifactSha256: version.artifactSha256,
              artifactAvailable: existsSync(path.join(version.artifactPath, "SKILL.md")),
              submittedAt: version.submittedAt,
              isLatest: version.versionId === identity?.latestApprovedVersionId,
              releaseStatus: "approved" as const,
            }))
          : (() => {
              const artifactPath = remapLegacySkillMarketPath(String(marketItem.packagePath || ""));
              const digest = artifactPath && existsSync(artifactPath)
                ? digestSkillSourceTree(artifactPath)
                : null;
              return [{
                versionId: `legacy-market-${marketItem.id}`,
                version: String(marketItem.version || "1.0.0"),
                artifactSha256: digest?.sha256 || "",
                artifactAvailable: Boolean(artifactPath && existsSync(path.join(artifactPath, "SKILL.md"))),
                submittedAt: marketItem.createdAt,
                isLatest: true,
                releaseStatus: "approved" as const,
              }];
            })();
        const repositoryCandidates = listRepositorySkillCandidates(APP_ROOT, input.skillId);
        const candidateVersions = repositoryCandidates.map((candidate, index) => ({
          versionId: candidate.versionId,
          version: candidate.version,
          artifactSha256: candidate.artifactSha256,
          artifactAvailable: existsSync(path.join(candidate.artifactPath, "SKILL.md")),
          submittedAt: null,
          isLatest: false,
          releaseStatus: "candidate" as const,
          isRecommendedCandidate: index === 0,
        }));
        const versions = [...candidateVersions, ...approvedVersions];
        const [models, roleTemplate] = await Promise.all([
          getAvailableJiuwenModels(),
          resolveSkillValueRoleTemplate(input.skillId),
        ]);
        const selectableModels = models.filter(model => model.id !== JIUWEN_AUTO_MODEL_ID);
        const readiness = await probeJiuwenSkillMcpReadiness({
          skillId: input.skillId,
          roleTemplate,
          allowPlannedEnterpriseRuntime: true,
        }).catch((error): import("../_core/skill-mcp-readiness").SkillMcpReadiness => ({
          skillId: input.skillId,
          status: "unchecked",
          canProceed: true,
          message: `运行环境暂未完成检查：${error instanceof Error ? error.message : String(error)}`.slice(0, 240),
          checkedAt: new Date().toISOString(),
          servers: [],
        }));
        const versionsWithSupport = versions.map(version => ({
          ...version,
          evaluationSupport: assessSkillValueEvaluationSupport({
            artifactAvailable: version.artifactAvailable,
            modelCount: selectableModels.length,
            suite: inspectCuratedSkillValueSuite({
              root: APP_ROOT,
              skillId: input.skillId,
              version: version.version,
              artifactSha256: version.artifactSha256,
            }),
            readiness,
          }),
        }));
        const recommendedModel = selectableModels.find(model => model.id === "glm-5.2")
          || selectableModels[0];
        return {
          skill: {
            skillId: input.skillId,
            name: String(marketItem.name || input.skillId),
            description: String(marketItem.description || ""),
            category: String(marketItem.category || "general"),
            author: String(marketItem.author || ""),
          },
          versions: versionsWithSupport,
          models: selectableModels.map(model => ({
            id: model.id,
            name: model.name,
            description: model.desc || "",
          })),
          recommendedModelId: recommendedModel?.id || JIUWEN_AUTO_MODEL_ID,
          defaultComparison: {
            left: { mode: "without_target_skill" as const, versionId: null },
            right: {
              mode: "skill_version" as const,
              versionId: candidateVersions.find(version => version.isRecommendedCandidate)?.versionId
                || versionsWithSupport.find(version => version.isLatest)?.versionId
                || versionsWithSupport[0]?.versionId
                || null,
            },
          },
          roleTemplate,
          readiness,
        };
      }),
adminSkillEvaluationSupportMatrix: adminProcedure.query(async () => {
      return await buildPrioritySkillValueEvaluationSupportCatalog(APP_ROOT);
    }),
adminPrepareSkillEvaluation: adminProcedure
      .input(z.object({
        skillId: skillIdSchema,
        targetVersionId: z.string().trim().min(1).max(128),
      }))
      .mutation(async ({ input, ctx }) => {
        const marketRows = (await listSkillMarketItems())
          .filter(row => String(row.skillId || "") === input.skillId);
        const marketItem = marketRows.find(row => row.status === "approved") || marketRows[0];
        if (!marketItem) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Skill 不存在" });
        }
        const identity = await getSkillIdentityBySkillId(input.skillId);
        let version: {
          versionId: string;
          version: string;
          artifactSha256: string;
          artifactPath: string;
        } | null = null;
        if (input.targetVersionId.startsWith("legacy-market-")) {
          const legacyMarketId = Number(input.targetVersionId.slice("legacy-market-".length));
          const legacyItem = marketRows.find(row => Number(row.id) === legacyMarketId);
          if (legacyItem) {
            const artifactPath = remapLegacySkillMarketPath(String(legacyItem.packagePath || ""));
            if (artifactPath && existsSync(artifactPath)) {
              version = {
                versionId: input.targetVersionId,
                version: String(legacyItem.version || "1.0.0"),
                artifactSha256: digestSkillSourceTree(artifactPath).sha256,
                artifactPath,
              };
            }
          }
        } else if (input.targetVersionId.startsWith("candidate_")) {
          const candidate = listRepositorySkillCandidates(APP_ROOT, input.skillId)
            .find(item => item.versionId === input.targetVersionId);
          if (candidate) version = candidate;
        } else {
          const stored = await getSkillVersionById(input.targetVersionId);
          if (
            stored
            && identity
            && stored.skillIdentityId === identity.identityId
            && stored.status === "approved"
          ) {
            version = {
              versionId: stored.versionId,
              version: stored.version,
              artifactSha256: stored.artifactSha256,
              artifactPath: stored.artifactPath,
            };
          }
        }
        if (!version) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "所选 Skill 版本不可用于评测" });
        }
        try {
          const roleTemplate = await resolveSkillValueRoleTemplate(input.skillId);
          const usesCustomerContext = Object.keys(
            getSkillMcpRequirement(input.skillId).servers,
          ).includes("customer_context");
          let contextAdapter: Parameters<typeof prepareSkillValueEvaluationPlan>[0]["contextAdapter"];
          if (usesCustomerContext) {
            try {
              const principal = await ensureEaSkillEvaluationContextPrincipal({
                organization: String(ctx.user.organization || "EA Skill Evaluation"),
                roleTemplate,
              });
              contextAdapter = createEaSkillEvaluationContextAdapter({ principal });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              contextAdapter = {
                adapterId: "ea-customer-context-v1",
                async load() {
                  throw new Error(message);
                },
              };
            }
          }
          const plan = await prepareSkillValueEvaluationPlan({
            root: APP_ROOT,
            skillId: input.skillId,
            skillName: String(marketItem.name || input.skillId),
            description: marketItem.description,
            version,
            roleTemplate,
            contextAdapter,
          });
          await recordAuditBestEffort({
            action: "skill.value_evaluation.prepared",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "skill",
            targetId: input.skillId,
            targetName: String(marketItem.name || input.skillId),
            metadata: {
              targetVersionId: version.versionId,
              targetVersion: version.version,
              analyzerModel: plan.analyzerModel,
              analyzerStatus: plan.analyzerStatus,
              promptCount: plan.prompts.length,
              planFingerprint: plan.planFingerprint,
              contextStatus: plan.context.status,
              contextProviderId: plan.context.providerId,
              contextSnapshotFingerprint: plan.context.snapshotFingerprint,
              contextSeedCount: plan.context.seedCount,
            },
          });
          return plan;
        } catch (error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: error instanceof Error ? error.message : "准备 Skill 评测失败",
          });
        }
      }),
adminStartSkillEvaluation: adminProcedure
      .input(z.object({
        skillId: skillIdSchema,
        left: z.object({
          selectionId: z.string().trim().min(1).max(128),
          modelId: z.string().trim().min(1).max(200),
        }),
        right: z.object({
          selectionId: z.string().trim().min(1).max(128),
          modelId: z.string().trim().min(1).max(200),
        }),
        prompts: z.array(z.object({
          promptId: z.string().trim().min(1).max(128),
          name: z.string().trim().min(1).max(120),
          prompt: z.string().trim().min(8).max(4_000),
          evaluationGoal: z.string().trim().min(1).max(500),
        })).min(1).max(5),
      }))
      .mutation(async ({ input, ctx }) => {
        if (
          input.left.selectionId === input.right.selectionId
          && input.left.modelId === input.right.modelId
        ) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "左右配置完全相同" });
        }
        const marketRows = (await listSkillMarketItems())
          .filter(row => String(row.skillId || "") === input.skillId);
        const marketItem = marketRows.find(row => row.status === "approved") || marketRows[0];
        if (!marketItem) throw new TRPCError({ code: "NOT_FOUND", message: "Skill 不存在" });
        const availableModels = await getAvailableJiuwenModels();
        const availableModelIds = new Set(
          availableModels
            .filter(model => model.id !== JIUWEN_AUTO_MODEL_ID)
            .map(model => model.id),
        );
        if (
          !availableModelIds.has(input.left.modelId)
          || !availableModelIds.has(input.right.modelId)
        ) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "所选模型当前不可用" });
        }
        try {
          const [leftArtifact, rightArtifact, roleTemplate] = await Promise.all([
            resolveSkillValueArtifact(input.skillId, input.left.selectionId),
            resolveSkillValueArtifact(input.skillId, input.right.selectionId),
            resolveSkillValueRoleTemplate(input.skillId),
          ]);
          const preflight = await probeJiuwenSkillMcpReadiness({
            skillId: input.skillId,
            roleTemplate,
            force: true,
            allowPlannedEnterpriseRuntime: true,
          });
          const job = startSkillValueEvaluationJob({
            skillId: input.skillId,
            skillName: String(marketItem.name || input.skillId),
            roleTemplate,
            organization: String(ctx.user.organization || "EA Skill Evaluation"),
            left: { modelId: input.left.modelId, artifact: leftArtifact },
            right: { modelId: input.right.modelId, artifact: rightArtifact },
            prompts: input.prompts,
            preflight,
          });
          await recordAuditBestEffort({
            action: "skill.value_evaluation.started",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "skill",
            targetId: input.skillId,
            targetName: String(marketItem.name || input.skillId),
            metadata: {
              jobId: job.jobId,
              roleTemplate,
              leftSelectionId: input.left.selectionId,
              rightSelectionId: input.right.selectionId,
              leftModelId: input.left.modelId,
              rightModelId: input.right.modelId,
              promptCount: input.prompts.length,
              configurationFingerprint: job.configurationFingerprint,
              preflightStatus: preflight.status,
              preflightMessage: preflight.message,
            },
          });
          return job;
        } catch (error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: error instanceof Error ? error.message : "启动 Skill 评测失败",
          });
        }
      }),
adminGetSkillEvaluationJob: adminProcedure
      .input(z.object({ jobId: z.string().trim().min(1).max(128) }))
      .query(({ input }) => {
        const job = getSkillValueEvaluationJob(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "评测任务不存在或已过期" });
        return job;
      }),
adminCancelSkillEvaluationJob: adminProcedure
      .input(z.object({ jobId: z.string().trim().min(1).max(128) }))
      .mutation(async ({ input, ctx }) => {
        const job = cancelSkillValueEvaluationJob(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "评测任务不存在或已过期" });
        await recordAuditBestEffort({
          action: "skill.value_evaluation.cancelled",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "skill",
          targetId: job.skillId,
          targetName: job.skillName,
          metadata: { jobId: job.jobId, status: job.status },
        });
        return job;
      }),
adminListSkillEvaluationJobs: adminProcedure
      .input(z.object({
        skillId: skillIdSchema,
        limit: z.number().int().min(1).max(100).optional(),
      }))
      .query(({ input, ctx }) => listSkillValueEvaluationJobs({
        skillId: input.skillId,
        organization: String(ctx.user.organization || "EA Skill Evaluation"),
        limit: input.limit,
      })),
adminPublishSkill: adminProcedure
      .input(z.object({
        skillId: skillIdSchema,
        name: z.string().min(1).max(128),
        description: z.string().optional(),
        author: z.string().optional(),
        version: z.string().optional(),
        category: z.enum(["finance", "dev", "data", "writing", "general"]).optional(),
        origin: z.enum(["opensource", "finance", "squad"]).optional(),
        license: z.string().optional(),
        status: z.enum(["pending", "approved", "rejected", "offline"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const marketDir = skillMarketDir();
        const status = input.status || "approved";
        const id = await insertSkillMarketItem({
          skillId: input.skillId,
          name: input.name,
          description: input.description || null,
          author: input.author || "官方",
          authorUserId: ctx.user!.id,
          version: input.version || "1.0.0",
          category: input.category || "general",
          origin: input.origin || "opensource",
          status,
          license: input.license || "MIT",
          packagePath: `${marketDir}/${status}/${input.skillId}`,
        });
        if (status === "approved" && (input.origin || "opensource") === "opensource") {
          await syncGlobalOpenSourceSkillGrants({ actor: ctx.user?.email || `user:${ctx.user?.id || "admin"}` });
        }
        await recordAuditBestEffort({
          action: "skill.market.created",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "skill",
          targetId: input.skillId,
          targetName: input.name,
          metadata: {
            marketId: id,
            status,
            category: input.category || "general",
            origin: input.origin || "opensource",
            version: input.version || "1.0.0",
          },
        });
        return { ok: true, id };
      }),
adminReviewSkill: adminProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["approved", "rejected", "offline"]),
        reviewNote: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const item = await getSkillMarketItem(input.id);
        if (!item) throw new TRPCError({ code: "NOT_FOUND" });
        const v2Version = await getSkillVersionByLegacyMarketId(input.id);
        if (
          input.status === "approved"
          && v2Version
          && Number(v2Version.submittedBy) === Number(ctx.user!.id)
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "发布人不能审核自己的技能版本，请由另一位管理员复核",
          });
        }
        if (input.status === "approved") {
          await recordAuditRequired({
            action: "skill.market.approved.requested",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "skill",
            targetId: String(item.skillId || item.id),
            targetName: item.name || null,
            metadata: {
              marketId: input.id,
              previousStatus: item.status || null,
              reviewNotePresent: Boolean(input.reviewNote),
            },
          });
        }
        try {
          const marketDir = skillMarketDir();
          const itemSkillId = skillIdSchema.parse(String(item.skillId || ""));
          const oldRaw = item.packagePath || path.join(marketDir, String(item.status || "pending"), itemSkillId);
          const oldDir = remapLegacySkillMarketPath(oldRaw);
          if (input.status === "approved") {
            if (!existsSync(oldDir)) {
              throw new TRPCError({ code: "NOT_FOUND", message: "待审核技能包不存在" });
            }
            const scan = parseSkillSourceDirectory(oldDir, itemSkillId);
            if (scan.warnings.length > 0) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `技能安全扫描未通过: ${scan.warnings.slice(0, 5).join("；")}`,
              });
            }
          }
          const statusDir = safeChildPath(marketDir, input.status);
          const newDir = v2Version
            ? oldDir
            : safeChildPath(statusDir, `${itemSkillId}-${item.id}`);
          if (!v2Version && oldDir !== newDir) {
            try {
              mkdirSync(path.dirname(newDir), { recursive: true });
              if (existsSync(oldDir)) {
                cpSync(oldDir, newDir, { recursive: true, force: true });
                try {
                  const oldStorePath = safeSkillStorePath(oldDir);
                  rmSync(oldStorePath, { recursive: true, force: true });
                } catch {}
              } else {
                mkdirSync(newDir, { recursive: true });
              }
            } catch {}
          }
          if (input.status === "approved" && !v2Version) {
            const origin = String((item).origin || "opensource");
            const approvedRows = await listSkillMarketItems("approved");
            for (const row of approvedRows) {
              if (Number(row.id) === Number(item.id)) continue;
              if (String(row.skillId) !== String(item.skillId)) continue;
              if (String((row).origin || "opensource") !== origin) continue;
              await updateSkillMarketItem(Number(row.id), { status: "offline" });
            }
          }
          if (v2Version) {
            await reviewSkillVersionByLegacyMarketId({
              legacyMarketId: input.id,
              status: input.status === "offline" ? "withdrawn" : input.status,
              reviewedBy: ctx.user!.id,
              reviewNote: input.reviewNote || null,
            });
            const identity = await getSkillIdentityById(v2Version.skillIdentityId);
            const versions = await listSkillVersionsByIdentity(v2Version.skillIdentityId);
            const latestMarketId = versions.find(version => (
              version.versionId === identity?.latestApprovedVersionId
            ))?.legacyMarketId;
            const marketRows = await listSkillMarketItems();
            for (const row of marketRows) {
              if (String(row.skillId || "") !== String(item.skillId || "")) continue;
              const linked = versions.find(version => Number(version.legacyMarketId) === Number(row.id));
              if (!linked || linked.status !== "approved") continue;
              await updateSkillMarketItem(Number(row.id), {
                status: Number(row.id) === Number(latestMarketId) ? "approved" : "offline",
              });
            }
          }
          const compatibilityStatus = v2Version && input.status === "approved"
            ? (await getSkillIdentityById(v2Version.skillIdentityId))?.latestApprovedVersionId === v2Version.versionId
              ? "approved"
              : "offline"
            : input.status;
          await updateSkillMarketItem(input.id, {
            status: compatibilityStatus,
            reviewNote: input.reviewNote || null,
            packagePath: newDir,
          });
          if (String((item).origin || "opensource") === "opensource") {
            await syncGlobalOpenSourceSkillGrants({ actor: ctx.user?.email || `user:${ctx.user?.id || "admin"}` });
          }
          if (input.status === "approved") {
            await recordAuditRequired({
              action: "skill.market.approved.completed",
              ...auditActor(ctx.user),
              ...auditRequest(ctx.req),
              targetType: "skill",
              targetId: String(item.skillId || item.id),
              targetName: item.name || null,
              metadata: {
                marketId: input.id,
                previousStatus: item.status || null,
                status: input.status,
                reviewNotePresent: Boolean(input.reviewNote),
              },
            });
          } else {
            await recordAuditBestEffort({
              action: "skill.market.reviewed",
              ...auditActor(ctx.user),
              ...auditRequest(ctx.req),
              targetType: "skill",
              targetId: String(item.skillId || item.id),
              targetName: item.name || null,
              metadata: {
                marketId: input.id,
                previousStatus: item.status || null,
                status: input.status,
                reviewNotePresent: Boolean(input.reviewNote),
              },
            });
          }
        } catch (error) {
          if (input.status === "approved") {
            await recordAuditBestEffort({
              action: "skill.market.approved.failed",
              result: "failed",
              severity: "high",
              ...auditActor(ctx.user),
              ...auditRequest(ctx.req),
              targetType: "skill",
              targetId: String(item.skillId || item.id),
              targetName: item.name || null,
              errorCode: "SKILL_MARKET_APPROVAL_FAILED",
              metadata: {
                marketId: input.id,
                previousStatus: item.status || null,
                reviewNotePresent: Boolean(input.reviewNote),
                ...auditErrorMetadata(error),
              },
            });
          }
          throw error;
        }
        return { ok: true };
      }),
adminViewSkillSource: adminProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const item = await getSkillMarketItem(input.id);
        if (!item) throw new TRPCError({ code: "NOT_FOUND" });
        const { readFileSync, readdirSync, existsSync, statSync } = await import("fs");
        const { join } = await import("path");
        const dir = remapLegacySkillMarketPath(item.packagePath || "");
        let skillMd = "";
        let scripts: string[] = [];
        const sourceFiles: Array<{ path: string; content: string; size: number; truncated: boolean }> = [];
        const skippedDirs = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"]);
        const allowedSuffixes = [
          ".md",
          ".txt",
          ".py",
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          ".json",
          ".yaml",
          ".yml",
          ".sh",
          ".sql",
          ".xml",
          ".toml",
          ".ini",
          ".template",
        ];
        const maxFiles = 40;
        const maxBytes = 120 * 1024;
        const isViewableSource = (relativePath: string) => {
          const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
          if (normalized === "skill.md") return false;
          if (/(^|\/)(\.env|secrets?|credentials?|tokens?|passwords?)(\.|\/|$)/.test(normalized)) return false;
          if (/\.(pem|key|p12|pfx|crt|cer|der|sqlite|db|zip|tar|gz|png|jpg|jpeg|gif|webp|pdf|docx|xlsx)$/i.test(normalized)) return false;
          return allowedSuffixes.some((suffix) => normalized.endsWith(suffix));
        };
        const collectSourceFiles = (currentDir: string, prefix = "") => {
          if (sourceFiles.length >= maxFiles) return;
          let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
          try {
            entries = readdirSync(currentDir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (sourceFiles.length >= maxFiles) break;
            const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
            const fullPath = join(currentDir, entry.name);
            if (entry.isDirectory()) {
              if (!skippedDirs.has(entry.name)) collectSourceFiles(fullPath, relativePath);
              continue;
            }
            if (!entry.isFile() || !isViewableSource(relativePath)) continue;
            try {
              const stat = statSync(fullPath);
              const tooLarge = stat.size > maxBytes;
              const content = tooLarge
                ? `文件大小 ${stat.size} bytes，超过源码预览上限 ${maxBytes} bytes。`
                : readFileSync(fullPath, "utf8");
              if (!tooLarge && content.includes("\u0000")) continue;
              sourceFiles.push({
                path: relativePath.replace(/\\/g, "/"),
                content,
                size: stat.size,
                truncated: tooLarge,
              });
            } catch {}
          }
        };
        try { skillMd = readFileSync(`${dir}/SKILL.md`, "utf8"); } catch {}
        try { if (existsSync(`${dir}/scripts`)) scripts = readdirSync(`${dir}/scripts`); } catch {}
        if (dir) collectSourceFiles(dir);
        sourceFiles.sort((a, b) => {
          const aRank = a.path.startsWith("scripts/") ? 0 : a.path.startsWith("templates/") ? 1 : a.path.startsWith("reference/") ? 2 : 3;
          const bRank = b.path.startsWith("scripts/") ? 0 : b.path.startsWith("templates/") ? 1 : b.path.startsWith("reference/") ? 2 : 3;
          return aRank - bRank || a.path.localeCompare(b.path);
        });
        return { skillMd, scripts, sourceFiles, dir };
      }),
adminDeleteMarketSkill: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const item = await getSkillMarketItem(input.id);
        const version = await getSkillVersionByLegacyMarketId(input.id);
        if (version) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "版本化技能保留发布审计记录；请使用拒绝或下架，不支持物理删除",
          });
        }
        if (item?.packagePath) {
          try {
            const packagePath = safeSkillStorePath(remapLegacySkillMarketPath(String(item.packagePath)));
            removeSkillStorePath(packagePath);
          } catch {}
        }
        await deleteSkillMarketItem(input.id);
        await recordAuditBestEffort({
          action: "skill.market.deleted",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "skill",
          targetId: String(item?.skillId || input.id),
          targetName: item?.name || null,
          metadata: {
            marketId: input.id,
            priorStatus: item?.status || null,
            packagePathPresent: Boolean(item?.packagePath),
          },
        });
        return { ok: true };
      })
};
