import { publicProcedure, protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  getCurrentClawByUserId,
  listClawsByUserId,
  getClawByAdoptId,
  createClawAdoption,
  updateClawAdoptionStatus,
  listClawAdoptionsAdmin,
  updateClawAdoptionAdmin,
  batchUpdateClawAdoptionAdmin,
  getClawAdoptionAdminById,
  deleteClawAdoptionAdmin,
  appendClawAdoptionEvent,
  getClawProfileSettings,
  upsertClawProfileSettings,
  getSystemConfigValue,
  getSystemConfigNumber,
  upsertSystemConfig,
  listSkillMarketItems,
  listApprovedSkillMarketItems,
  getSkillMarketItem,
  insertSkillMarketItem,
  updateSkillMarketItem,
  deleteSkillMarketItem,
  incrementSkillDownload,
  resolveEffectiveRoleAssets,
  previewRoleAssetSeedSync,
  syncRoleAssetSeed,
  listRoleAssetGrants,
  replaceAdminRoleAssetGrantsForAsset,
  syncGlobalOpenSourceSkillGrants,
  deleteMessageFeedback,
  getMessageFeedbackAdminSummary,
  listMessageFeedbackForConversation,
  upsertMessageFeedback,
} from "../db";
import {
  APP_ROOT,
  assertClawOwnerOrThrow,
  bumpClawSessionEpochBestEffort,
  writeClawExecAudit,
} from "./helpers";
import {
  isJiuwenClawAdoptId,
  jiuwenClawAgentDir,
  jiuwenClawWorkspaceDir,
  resolveRuntimeAgentId,
} from "../_core/helpers";
import { getAdminSystemHealth } from "../_core/admin-system-health";
import { logDebug, logWarn } from "../_core/observability/logger";
import { auditActor, auditErrorMetadata, auditRequest, recordAuditBestEffort, recordAuditRequired } from "../_core/audit-events";
import { onboardBuiltinSkillsForAdopt } from "../_core/skills/skill-onboarding";
import { skillRegistry } from "../_core/skills/skill-registry";
import { listSkillsWithRoleDefaults } from "../_core/skills/role-default-skills";
import { roleSkillPreferences } from "../_core/skills/role-skill-preferences";
import { setAgentSkillEnabled } from "../_core/skills/skill-enable-service";
import { parseSkillSourceDirectory } from "../_core/skills/skill-source";
import { toPublicSkillMarketItem } from "../_core/skills/skill-market-policy";
import {
  remapLegacySkillMarketPath,
  skillStoreMarketplaceDir,
  safeSkillStorePath,
  removeSkillStorePath,
} from "../_core/skills/skill-store";
import type { Skill, SkillSource } from "../../shared/types/skill";
import {
  getAgentRoleTemplate,
  getRoleSkillMcpBaseline,
  getSkillMcpRequirement,
  listAgentRoleTemplates,
  resolveAgentRoleTemplate,
} from "../_core/role-templates";
import type { AgentRoleTemplate, AgentRuntime } from "../_core/role-templates";
import { resolveRoleRuntimeProvisionPlan } from "../_core/role-runtime-adapter";
import { getRoleRuntimeAdapter, isJiuwenSwarmProvisionEnabled } from "./role-runtime-adapters";
import { listConfiguredMcpServers, listMcpToolGroups } from "../_core/claw-skills";
import { MESSAGE_FEEDBACK_REASON_CODES } from "../../shared/message-feedback";
import { resolvePublicBaseUrl } from "../_core/public-base-url";
import { probeJiuwenSkillMcpReadiness } from "../_core/skill-mcp-readiness";
import { resolveActiveAgentRuntime, retiredRuntimeMessage } from "../_core/runtime-policy";
import {
  getEaAssistantModelAdminConfig,
  saveEaAssistantModelConfig,
  validateEaAssistantModel,
} from "../_core/ea-assistant-model";
import {
  applyNegativeMemoryFeedback,
  applyPositiveMemoryFeedback,
  changeAgentMemoryMode,
  confirmAgentMemory,
  forgetAgentMemory,
  listAgentMemoryView,
  refreshAgentMemorySynthesis,
  rememberExplicitPreference,
  rejectAgentMemory,
  updateAgentMemory,
} from "../_core/agent-memory";
import {
  JIUWEN_AUTO_MODEL_ID,
  JIUWEN_MODEL_PROVIDERS,
  JIUWEN_REASONING_LEVELS,
  listSelectableJiuwenModels,
  listJiuwenModelsWithSecrets,
  modelIdentity,
  replaceJiuwenModels,
  resolveAutomaticSelectableJiuwenModel,
  resolveSelectableJiuwenModel,
  sanitizeModelAdminError,
  toPublicJiuwenModels,
  validateJiuwenModel,
} from "../_core/jiuwenswarm-model-admin";

type ResolvedClawRuntime = "jiuwenclaw" | "legacy_archived" | "unsupported";

const skillIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "技能ID只能包含小写字母、数字和连字符");
const feedbackIdentitySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, "消息标识格式不正确");
const feedbackToolSchema = z.object({
  name: z.string().trim().min(1).max(128),
  status: z.enum(["running", "done", "error"]),
  durationMs: z.number().int().nonnegative().max(3_600_000).optional(),
});
const jiuwenModelDraftSchema = z.object({
  modelName: z.string().trim().min(1).max(200),
  alias: z.string().trim().max(200).default(""),
  apiBase: z.string().trim().url().max(2048),
  apiKey: z.string().max(8192).optional(),
  provider: z.enum(JIUWEN_MODEL_PROVIDERS),
  reasoningLevel: z.enum(JIUWEN_REASONING_LEVELS).default(""),
  temperature: z.number().min(0).max(2).default(0.95),
  isDefault: z.boolean().default(true),
  originIndex: z.number().int().nonnegative().optional(),
});
const eaAssistantModelDraftSchema = z.object({
  apiBase: z.string().trim().url().max(2048),
  modelName: z.string().trim().min(1).max(200),
  apiKey: z.string().max(8192).optional(),
  provider: z.enum(JIUWEN_MODEL_PROVIDERS).default("OpenAI"),
  timeoutMs: z.number().int().min(1000).max(120000).default(8000),
  disableThinking: z.boolean().default(true),
});

function safeChildPath(parentDir: string, childName: string): string {
  const parent = path.resolve(parentDir);
  const child = path.resolve(parent, childName);
  if (child !== parent && child.startsWith(`${parent}${path.sep}`)) return child;
  throw new Error("路径越权");
}

function safeDescendantPath(parentDir: string, candidatePath: string): string {
  const parent = path.resolve(parentDir);
  const candidate = path.resolve(candidatePath);
  if (candidate !== parent && candidate.startsWith(`${parent}${path.sep}`)) return candidate;
  throw new Error("路径越权");
}

const resolveClawRuntime = (adoptId: unknown): ResolvedClawRuntime => {
  return resolveActiveAgentRuntime(adoptId);
};

function buildClawEntryUrl(adoptId: string): string {
  return `${resolvePublicBaseUrl()}/claw/${encodeURIComponent(adoptId)}`;
}

type AdminClawAdoption = NonNullable<Awaited<ReturnType<typeof getClawAdoptionAdminById>>>;

const roleResettableStatuses = new Set(["creating", "active", "expiring"]);

type EffectiveRoleAssets = Awaited<ReturnType<typeof resolveEffectiveRoleAssets>>;

const diffSorted = (before: readonly string[] = [], after: readonly string[] = []) => {
  const beforeSet = new Set(before.map((item) => String(item || "").trim()).filter(Boolean));
  const afterSet = new Set(after.map((item) => String(item || "").trim()).filter(Boolean));
  return {
    added: [...afterSet].filter((item) => !beforeSet.has(item)).sort(),
    removed: [...beforeSet].filter((item) => !afterSet.has(item)).sort(),
  };
};

const diffEffectiveRoleAssets = (before: EffectiveRoleAssets, after: EffectiveRoleAssets) => ({
  skills: {
    default: diffSorted(before.skills.default, after.skills.default),
    optional: diffSorted(before.skills.optional, after.skills.optional),
  },
  mcpServers: {
    default: diffSorted(before.mcpServers.default, after.mcpServers.default),
    optional: diffSorted(before.mcpServers.optional, after.mcpServers.optional),
  },
});

const resolveRoleResetRuntime = (row: AdminClawAdoption): AgentRuntime => {
  const runtime = String(row.runtime || "").trim();
  if (runtime === "jiuwenswarm" || String(row.adoptId || "").startsWith("lgj-")) return "jiuwenswarm";
  throw new TRPCError({ code: "BAD_REQUEST", message: retiredRuntimeMessage() });
};

const applyAdminRoleReset = async (input: {
  before: AdminClawAdoption;
  role: AgentRoleTemplate;
  operatorId: number | null;
  targetStatus?: string | null;
}) => {
  const adoptId = String(input.before.adoptId || "");
  const agentId = String(input.before.agentId || "");
  const runtime = resolveRoleResetRuntime(input.before);
  const status = String(input.targetStatus || input.before.status || "");

  if (!adoptId || !agentId) {
    return {
      applied: false,
      runtime,
      reason: "missing runtime agent identifiers",
    };
  }
  if (!roleResettableStatuses.has(status)) {
    return {
      applied: false,
      runtime,
      reason: `status ${status || "unknown"} is not resettable`,
    };
  }

  const previousRoleTemplate = String(input.before.roleTemplate || "general-assistant");
  const previousEffectiveAssets = await resolveEffectiveRoleAssets(previousRoleTemplate);
  const effectiveAssets = await resolveEffectiveRoleAssets(input.role.id);
  const effectiveAssetDiff = diffEffectiveRoleAssets(previousEffectiveAssets, effectiveAssets);
  const activeSkillIds = await resolveActiveSkillIdsAfterRoleReset(adoptId, effectiveAssets);
  const runtimeAdapter = getRoleRuntimeAdapter(runtime);
  const skillReconcile = await runtimeAdapter.reconcileSkills({
    adoptId,
    agentId,
    role: input.role,
    effectiveAssets,
    activeSkillIds,
  });
  const mcpReconcile = await runtimeAdapter.reconcileMcp({
    adoptId,
    agentId,
    role: input.role,
    effectiveAssets,
  });
  roleSkillPreferences.clear(adoptId);
  const sessionEpoch = await runtimeAdapter.bumpSessionEpoch(adoptId, agentId);

  await appendClawAdoptionEvent({
    adoptionId: Number(input.before.id),
    eventType: "profile_updated",
    operatorType: "admin",
    operatorId: input.operatorId,
    detail: JSON.stringify({
      action: "role_reset",
      previousRoleTemplate,
      roleTemplate: input.role.id,
      industry: input.role.industry,
      runtime,
      previousEffectiveAssets,
      effectiveAssets,
      effectiveAssetDiff,
      activeSkillIds,
      skillReconcile,
      mcpReconcile,
      sessionEpoch,
    }),
  });

  return {
    applied: true,
    runtime,
    previousRoleTemplate,
    previousEffectiveAssets,
    effectiveAssets,
    effectiveAssetDiff,
    skillReconcile,
    mcpReconcile,
    sessionEpoch,
  };
};

const resolveSelectableAdoptRoleTemplate = (roleId?: string | null): AgentRoleTemplate => {
  const role = resolveAgentRoleTemplate(roleId);
  if (role.status !== "mvp") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `岗位暂未开放申请: ${role.name}`,
    });
  }
  return role;
};

const resolveRoleSkillAccessForAdoption = async (adoptId: string) => {
  const claw = await getClawByAdoptId(adoptId);
  const roleTemplate = String((claw as any)?.roleTemplate || "general-assistant");
  const effectiveAssets = await resolveEffectiveRoleAssets(roleTemplate);
  const allowedSkillIds = new Set([
    ...effectiveAssets.skills.default,
    ...effectiveAssets.skills.optional,
  ].map((skillId) => String(skillId || "").trim()).filter(Boolean));
  return {
    claw,
    roleTemplate,
    effectiveAssets,
    allowedSkillIds,
  };
};

const personalSkillSourceKinds = new Set(["uploaded", "generated"]);

const resolveActiveSkillIdsAfterRoleReset = async (
  adoptId: string,
  effectiveAssets: Awaited<ReturnType<typeof resolveEffectiveRoleAssets>>,
): Promise<string[]> => {
  const allowedSkillIds = new Set([
    ...effectiveAssets.skills.default,
    ...effectiveAssets.skills.optional,
  ].map((skillId) => String(skillId || "").trim()).filter(Boolean));
  const listed = await skillRegistry.listSkills(adoptId);
  if (!listed.ok) {
    logWarn("agent.role_reset.skill_list_failed", {
      adoptId,
      kind: listed.error.kind,
      detail: listed.error.detail,
    });
    return [];
  }
  return listed.value
    .filter((skill: Skill) => skill.enabled && skill.state === "ready")
    .filter((skill: Skill) => {
      const sourceKind = String(skill.source?.kind || "");
      if (personalSkillSourceKinds.has(sourceKind)) return true;
      return allowedSkillIds.has(String(skill.id || "").trim()) ||
        allowedSkillIds.has(String(skill.source?.skillId || "").trim());
    })
    .map((skill: Skill) => String(skill.id || skill.source?.skillId || "").trim())
    .filter(Boolean)
    .sort();
};

const randomRuntimeSuffix = () => nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);

type RuntimeModelOption = { id: string; name: string; desc?: string; isDefault?: boolean };
const iosLoadDebugEnabled = process.env.IOS_LOAD_DEBUG === "1";

function logIosLoadDebug(message: string, fields: Record<string, unknown> = {}): void {
  if (!iosLoadDebugEnabled) return;
  logDebug(`ios.load.${message}`, fields);
}

const getAvailableJiuwenModels = async (): Promise<RuntimeModelOption[]> => {
  try {
    const models = await listSelectableJiuwenModels();
    if (models.length > 0) {
      const automaticModel = resolveAutomaticSelectableJiuwenModel(models);
      const orderedModels = automaticModel
        ? [automaticModel, ...models.filter((model) => model.id !== automaticModel.id)]
        : models;
      return [
        {
          id: JIUWEN_AUTO_MODEL_ID,
          name: "自动",
          desc: automaticModel?.name || "由系统选择",
          isDefault: true,
        },
        ...orderedModels.map((model) => ({
          id: model.id,
          name: model.name,
          desc: model.description,
          isDefault: false,
        })),
      ];
    }
  } catch (error) {
    logWarn("model.catalog.read_failed", {
      error: sanitizeModelAdminError(error),
    });
  }
  const id = String(process.env.JIUWENCLAW_DEFAULT_MODEL || "glm-5.2").trim() || "glm-5.2";
  return [
    { id: JIUWEN_AUTO_MODEL_ID, name: "自动", desc: "由系统选择", isDefault: true },
    { id, name: id, desc: "JiuwenSwarm", isDefault: false },
  ];
};

const getAvailableModelsForRuntime = async (adoptId?: unknown): Promise<RuntimeModelOption[]> => {
  if (!String(adoptId || "").trim()) return await getAvailableJiuwenModels();
  const runtime = resolveClawRuntime(adoptId);
  if (runtime === "jiuwenclaw") return await getAvailableJiuwenModels();
  return [];
};

const skillMarketDir = () => skillStoreMarketplaceDir();

function pruneSkillRegistryForAdopt(adoptId: string): number {
  const registryPath = `${APP_ROOT}/data/skill-registry.json`;
  try {
    if (!existsSync(registryPath)) return 0;
    const rows = JSON.parse(String(readFileSync(registryPath, "utf-8") || "[]"));
    if (!Array.isArray(rows)) return 0;
    const next = rows.filter((row: any) => String(row?.adoptId || "") !== adoptId);
    if (next.length === rows.length) return 0;
    writeFileSync(registryPath, JSON.stringify(next, null, 2), "utf-8");
    return rows.length - next.length;
  } catch (e: any) {
    logWarn("agent.delete.skill_registry_prune_failed", {
      adoptId,
      error: String(e?.message || e),
    });
    return 0;
  }
}

export const clawRouter = router({
    me: protectedProcedure.query(async ({ ctx }) => {
      const userId = ctx.user!.id;
      const all = await listClawsByUserId(userId);

      const normalizeEntry = (c: any) => ({
        ...c,
        entryUrl: buildClawEntryUrl(String(c?.adoptId || "")),
        roleTemplate: String(c?.roleTemplate || "general-assistant"),
        industry: String(c?.industry || "general"),
        runtime: String(c?.runtime || resolveClawRuntime(c?.adoptId)),
        actualRuntime: resolveClawRuntime(c?.adoptId),
      });

      const adoptions = all.map(normalizeEntry);
      // 向后兼容：老前端读 adoption 取第一张（sort 保证 lgc-* 在前，行为跟 getCurrentClawByUserId 一致）
      const primary = adoptions[0] || null;

      return {
        hasClaw: adoptions.length > 0,
        adoption: primary,  // 保留老字段供未升级前端使用
        adoptions,          // 新字段，多 runtime 场景
      };
    }),

    getByAdoptId: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64) }))
      .query(async ({ input, ctx }) => {
        const startedAt = Date.now();
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);
        if (!claw) {
          logIosLoadDebug("trpc_claw_getByAdoptId", {
            adoptId: input.adoptId,
            userId: ctx.user?.id,
            found: false,
            ms: Date.now() - startedAt,
          });
          return null;
        }
        const profile = await getClawProfileSettings(Number((claw as any).id || 0));
        logIosLoadDebug("trpc_claw_getByAdoptId", {
          adoptId: input.adoptId,
          userId: ctx.user?.id,
          clawId: (claw as any).id,
          found: true,
          status: (claw as any).status,
          ms: Date.now() - startedAt,
        });
        return {
          adoptId: claw.adoptId,
          status: claw.status,
          entryUrl: buildClawEntryUrl(String(claw.adoptId || "")),
          expiresAt: claw.expiresAt,
          displayName: String((profile as any)?.displayName || "岗位智能体"),
          permissionProfile: String(claw.permissionProfile || "starter"),
          roleTemplate: String((claw as any).roleTemplate || "general-assistant"),
          roleName: getAgentRoleTemplate(String((claw as any).roleTemplate || "general-assistant"))?.name || "通用助手",
          industry: String((claw as any).industry || "general"),
          runtime: String((claw as any).runtime || resolveClawRuntime(claw.adoptId)),
          actualRuntime: resolveClawRuntime(claw.adoptId),
        };
      }),

    publicConfig: publicProcedure.query(async () => {
      const visibility = (await getSystemConfigValue("claw_visibility", "internal")).trim() || "internal";
      return { visibility: visibility === "internal" ? "internal" : "public" };
    }),

    listMessageFeedback: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        conversationId: feedbackIdentitySchema,
      }))
      .query(async ({ input, ctx }) => {
        await assertClawOwnerOrThrow(ctx, input.adoptId);
        const rows = await listMessageFeedbackForConversation(
          Number(ctx.user!.id),
          input.adoptId,
          input.conversationId,
        );
        return { rows };
      }),

    setMessageFeedback: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        conversationId: feedbackIdentitySchema,
        messageId: feedbackIdentitySchema,
        rating: z.enum(["positive", "negative"]).nullable(),
        reasonCodes: z.array(z.enum(MESSAGE_FEEDBACK_REASON_CODES)).max(8).default([]),
        comment: z.string().trim().max(500).optional(),
        selectedModelId: z.string().trim().max(200).optional(),
        actualModelId: z.string().trim().max(200).optional(),
        skillIds: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
        tools: z.array(feedbackToolSchema).max(30).default([]),
        inputTokens: z.number().int().nonnegative().max(2_000_000_000).optional(),
        outputTokens: z.number().int().nonnegative().max(2_000_000_000).optional(),
        durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);
        const userId = Number(ctx.user!.id);
        if (input.rating === null) {
          await deleteMessageFeedback(userId, input.adoptId, input.conversationId, input.messageId);
          return { ok: true, deleted: true };
        }
        const isNegative = input.rating === "negative";
        await upsertMessageFeedback({
          userId,
          adoptId: input.adoptId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          rating: input.rating,
          reasonCodes: isNegative ? input.reasonCodes : [],
          comment: isNegative ? input.comment?.trim() || undefined : undefined,
          roleTemplate: String((claw as any).roleTemplate || "general-assistant"),
          runtimeType: resolveClawRuntime(input.adoptId),
          selectedModelId: input.selectedModelId?.trim() || undefined,
          actualModelId: input.actualModelId?.trim() || undefined,
          skillIds: Array.from(new Set(input.skillIds)),
          tools: input.tools,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          durationMs: input.durationMs,
        });
        if (input.rating === "positive") {
          void applyPositiveMemoryFeedback({
            userId,
            adoptId: input.adoptId,
            conversationId: input.conversationId,
          }).catch(() => {});
        } else if (input.reasonCodes.includes("preference_mismatch")) {
          void applyNegativeMemoryFeedback({
            userId,
            adoptId: input.adoptId,
            conversationId: input.conversationId,
          }).catch(() => {});
        }
        return { ok: true, deleted: false };
      }),

    memoryView: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64) }))
      .query(async ({ input, ctx }) => {
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);
        return listAgentMemoryView({
          userId: Number(ctx.user!.id),
          adoptId: input.adoptId,
          adoptionId: Number(claw.id),
        });
      }),

    refreshMemorySynthesis: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64) }))
      .mutation(async ({ input, ctx }) => {
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);
        const result = await refreshAgentMemorySynthesis({
          userId: Number(ctx.user!.id),
          adoptId: input.adoptId,
          roleTemplate: String(claw.roleTemplate || "general-assistant"),
          force: true,
        });
        await recordAuditBestEffort({
          action: "memory.synthesis.refresh",
          result: "success",
          severity: "info",
          actorType: "user",
          ...auditActor(ctx.user),
          targetType: "claw_adoption",
          targetId: input.adoptId,
          agentInstanceId: input.adoptId,
          source: "claw_router",
          metadata: { count: result.count, model: result.model },
        });
        return result;
      }),

    setMemoryMode: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        mode: z.enum(["learn_and_use", "use_only", "off"]),
      }))
      .mutation(async ({ input, ctx }) => {
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);
        await changeAgentMemoryMode({
          userId: Number(ctx.user!.id),
          adoptId: input.adoptId,
          adoptionId: Number(claw.id),
          dbAgentId: String(claw.agentId || ""),
          mode: input.mode,
        });
        await recordAuditBestEffort({
          action: "memory.mode.update",
          result: "success",
          severity: "info",
          actorType: "user",
          ...auditActor(ctx.user),
          targetType: "claw_adoption",
          targetId: input.adoptId,
          agentInstanceId: input.adoptId,
          source: "claw_router",
          metadata: { mode: input.mode },
        });
        return { ok: true, mode: input.mode };
      }),

    rememberMemory: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        content: z.string().trim().min(4).max(800),
        kind: z.enum(["preference", "instruction", "entity", "procedure"]).default("preference"),
      }))
      .mutation(async ({ input, ctx }) => {
        await assertClawOwnerOrThrow(ctx, input.adoptId);
        const memory = await rememberExplicitPreference({
          adoptId: input.adoptId,
          content: input.content,
          kind: input.kind,
          channel: "web-settings",
        });
        await recordAuditBestEffort({
          action: "memory.preference.remember",
          result: "success",
          severity: "info",
          actorType: "user",
          ...auditActor(ctx.user),
          targetType: "agent_memory",
          targetId: String(memory.id),
          agentInstanceId: input.adoptId,
          source: "claw_router",
          metadata: { kind: memory.kind, scope: memory.scope },
        });
        return memory;
      }),

    confirmMemory: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        id: z.number().int().positive(),
      }))
      .mutation(async ({ input, ctx }) => {
        await assertClawOwnerOrThrow(ctx, input.adoptId);
        await confirmAgentMemory({ userId: Number(ctx.user!.id), adoptId: input.adoptId, id: input.id });
        return { ok: true };
      }),

    rejectMemory: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        id: z.number().int().positive(),
      }))
      .mutation(async ({ input, ctx }) => {
        await assertClawOwnerOrThrow(ctx, input.adoptId);
        await rejectAgentMemory({ userId: Number(ctx.user!.id), adoptId: input.adoptId, id: input.id });
        return { ok: true };
      }),

    updateMemory: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        id: z.number().int().positive(),
        content: z.string().trim().min(4).max(800),
      }))
      .mutation(async ({ input, ctx }) => {
        await assertClawOwnerOrThrow(ctx, input.adoptId);
        const memory = await updateAgentMemory({
          userId: Number(ctx.user!.id),
          adoptId: input.adoptId,
          id: input.id,
          content: input.content,
        });
        await recordAuditBestEffort({
          action: "memory.preference.update",
          result: "success",
          severity: "info",
          actorType: "user",
          ...auditActor(ctx.user),
          targetType: "agent_memory",
          targetId: String(memory.id),
          agentInstanceId: input.adoptId,
          source: "claw_router",
        });
        return memory;
      }),

    forgetMemory: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        id: z.number().int().positive(),
      }))
      .mutation(async ({ input, ctx }) => {
        await assertClawOwnerOrThrow(ctx, input.adoptId);
        const memory = await forgetAgentMemory({
          userId: Number(ctx.user!.id),
          adoptId: input.adoptId,
          id: input.id,
        });
        await recordAuditBestEffort({
          action: "memory.preference.forget",
          result: "success",
          severity: "info",
          actorType: "user",
          ...auditActor(ctx.user),
          targetType: "agent_memory",
          targetId: String(memory.id),
          agentInstanceId: input.adoptId,
          source: "claw_router",
        });
        return memory;
      }),

    adminMessageFeedbackSummary: adminProcedure
      .input(z.object({
        days: z.number().int().min(1).max(365).default(30),
        limit: z.number().int().min(1).max(100).default(30),
      }).optional())
      .query(async ({ input }) => getMessageFeedbackAdminSummary({
        days: input?.days ?? 30,
        limit: input?.limit ?? 30,
      })),

    roleTemplates: publicProcedure.query(() => {
      const baseline = getRoleSkillMcpBaseline();
      const roles = listAgentRoleTemplates().map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description,
        industry: role.industry,
        industryName: role.industryName,
        status: role.status,
        mvp: role.status === "mvp",
        displayOrder: role.displayOrder,
        runtime: role.runtime,
      }));
      return {
        version: baseline.version,
        defaultRole: baseline.schema.defaultRole,
        industries: Object.fromEntries(Object.entries(baseline.industries).map(([id, block]) => [id, { name: block.name }])),
        roles,
      };
    }),

    roleAssetSeedPreview: adminProcedure.query(async () => {
      const plan = await previewRoleAssetSeedSync();
      return {
        desiredCount: plan.desired.length,
        upsertCount: plan.upsert.length,
        pruneCount: plan.prune.length,
        untouchedDynamicCount: plan.untouchedDynamic.length,
        upsert: plan.upsert.slice(0, 100),
        prune: plan.prune.slice(0, 100),
      };
    }),

    roleAssetSeedSync: adminProcedure.mutation(async () => {
      const plan = await syncRoleAssetSeed();
      const openSourcePlan = await syncGlobalOpenSourceSkillGrants({ actor: "role-seed-sync" });
      return {
        desiredCount: plan.desired.length,
        upsertCount: plan.upsert.length,
        pruneCount: plan.prune.length,
        untouchedDynamicCount: plan.untouchedDynamic.length,
        openSourceSkillGrants: openSourcePlan,
      };
    }),

    getAvailableModels: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64).optional() }).optional())
      .query(async ({ input }) => {
        const startedAt = Date.now();
        const models = await getAvailableModelsForRuntime(input?.adoptId);
        logIosLoadDebug("trpc_claw_getAvailableModels", {
          adoptId: input?.adoptId || "",
          count: models.length,
          defaultModel: models.find((model) => model.isDefault)?.id || "",
          ms: Date.now() - startedAt,
        });
        return models;
      }),

    switchModel: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64), modelId: z.string().min(1).max(120) }))
      .mutation(async ({ input, ctx }) => {
        const runtimeType = resolveClawRuntime(input.adoptId);
        if (runtimeType !== "jiuwenclaw") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: retiredRuntimeMessage(),
          });
        }
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw) throw new Error("智能体实例不存在");
        if (Number(claw.userId) !== Number(ctx.user!.id)) {
          throw new Error("无权修改该智能体设置");
        }
        let jiuwenSelection: Awaited<ReturnType<typeof resolveSelectableJiuwenModel>> = null;
        try {
          jiuwenSelection = input.modelId === JIUWEN_AUTO_MODEL_ID
            ? resolveAutomaticSelectableJiuwenModel(await listSelectableJiuwenModels())
            : await resolveSelectableJiuwenModel(input.modelId);
        } catch (error) {
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: sanitizeModelAdminError(error) || "模型目录暂时不可用",
          });
        }
        if (!jiuwenSelection) throw new Error("不支持的模型");

        const previousSettings = await getClawProfileSettings(Number(claw.id));
        const previousModel = String((previousSettings as any)?.model || "");

        // 1) 保存到业务设置（用于页面回显）
        await upsertClawProfileSettings(Number(claw.id), {
          model: input.modelId,
          updatedBy: ctx.user!.id,
        } as any);

        await recordAuditBestEffort({
          action: "model.switched",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "agent",
          targetId: input.adoptId,
          targetName: String((claw as any).agentId || input.adoptId),
          agentInstanceId: input.adoptId,
          runtimeType,
          runtimeAgentId: String((claw as any).agentId || ""),
          metadata: {
            previousModel: previousModel || null,
            model: input.modelId,
            runtimeModel: jiuwenSelection.runtimeModelId || input.modelId,
            applied: false,
            effectiveFrom: "next_request",
            runtimeManaged: true,
          },
        });

        return {
          ok: true,
          model: input.modelId,
          applied: false,
          statusCode: null,
          applyError: null,
          runtimeManaged: true,
          effectiveFrom: "next_request" as const,
        };
      }),

    adminList: adminProcedure
      .input(z.object({ keyword: z.string().optional(), status: z.enum(["all", "creating", "active", "expiring", "recycled", "failed"]).optional() }).optional())
      .query(async ({ input }) => {
        const rows = await listClawAdoptionsAdmin({ keyword: input?.keyword, status: input?.status || "all", limit: 300 });
        const summary = {
          total: rows.length,
          creating: rows.filter((r) => r.status === "creating").length,
          active: rows.filter((r) => r.status === "active").length,
          expiring: rows.filter((r) => r.status === "expiring").length,
          recycled: rows.filter((r) => r.status === "recycled").length,
          failed: rows.filter((r) => r.status === "failed").length,
        };
        return { summary, rows };
      }),

    adminUpdate: adminProcedure
      .input(z.object({
        id: z.number().int().positive(),
        permissionProfile: z.enum(["starter", "plus", "internal"]).optional(),
        roleTemplate: z.string().min(1).max(64).optional(),
        ttlDays: z.number().int().min(0).max(365).optional(),
        status: z.enum(["creating", "active", "expiring", "recycled", "failed"]).optional(),
        expiresAt: z.string().datetime().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const before = await getClawAdoptionAdminById(input.id);
        if (!before) {
          throw new TRPCError({ code: "NOT_FOUND", message: "智能体不存在" });
        }
        const role = input.roleTemplate ? resolveAgentRoleTemplate(input.roleTemplate) : null;
        await updateClawAdoptionAdmin(input.id, {
          permissionProfile: input.permissionProfile as any,
          roleTemplate: role?.id,
          industry: role?.industry,
          ttlDays: input.ttlDays,
          status: input.status as any,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        });
        let roleReset: Awaited<ReturnType<typeof applyAdminRoleReset>> | null = null;
        if (role) {
          try {
            roleReset = await applyAdminRoleReset({
              before,
              role,
              operatorId: ctx.user?.id ?? null,
              targetStatus: input.status || null,
            });
          } catch (error: any) {
            await recordAuditBestEffort({
              action: "agent.role.reset_failed",
              ...auditActor(ctx.user),
              ...auditRequest(ctx.req),
              targetType: "agent",
              targetId: String(before.adoptId),
              targetName: before.agentId ? String(before.agentId) : null,
              agentInstanceId: String(before.adoptId),
              runtimeType: resolveClawRuntime(before.adoptId),
              runtimeAgentId: before.agentId ? String(before.agentId) : null,
              metadata: {
                id: input.id,
                previousRoleTemplate: before.roleTemplate || null,
                roleTemplate: role.id,
                industry: role.industry,
                roleRuntimeTarget: role.runtime,
                error: auditErrorMetadata(error),
              },
            });
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `岗位重置失败: ${error?.message || String(error)}`,
            });
          }
        }
        if (role && roleReset?.applied && "activeSkillIds" in roleReset) {
          await recordAuditBestEffort({
            action: "agent.role.changed",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "agent",
            targetId: String(before.adoptId || input.id),
            targetName: before.agentId ? String(before.agentId) : null,
            agentInstanceId: before.adoptId ? String(before.adoptId) : null,
            runtimeType: resolveClawRuntime(before.adoptId),
            runtimeAgentId: before.agentId ? String(before.agentId) : null,
            metadata: {
              id: input.id,
              previousRoleTemplate: roleReset.previousRoleTemplate,
              roleTemplate: role.id,
              industry: role.industry,
              runtime: roleReset.runtime,
              previousEffectiveAssets: roleReset.previousEffectiveAssets,
              effectiveAssets: roleReset.effectiveAssets,
              effectiveAssetDiff: roleReset.effectiveAssetDiff,
              activeSkillIds: roleReset.activeSkillIds,
              skillReconcile: roleReset.skillReconcile,
              mcpReconcile: roleReset.mcpReconcile,
              sessionEpoch: roleReset.sessionEpoch,
              changed: roleReset.previousRoleTemplate !== role.id,
            },
          });
        }
        await recordAuditBestEffort({
          action: "agent.lifecycle.admin_updated",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "agent",
          targetId: before.adoptId ? String(before.adoptId) : String(input.id),
          targetName: before.agentId ? String(before.agentId) : null,
          agentInstanceId: before.adoptId ? String(before.adoptId) : null,
          runtimeType: resolveClawRuntime(before.adoptId),
          runtimeAgentId: before.agentId ? String(before.agentId) : null,
          metadata: {
            id: input.id,
            permissionProfile: input.permissionProfile || null,
            previousRoleTemplate: before.roleTemplate || null,
            roleTemplate: role?.id || null,
            industry: role?.industry || null,
            roleRuntimeTarget: role?.runtime || null,
            reconcileApplied: Boolean(roleReset?.applied),
            roleReset,
            ttlDays: input.ttlDays ?? null,
            status: input.status || null,
            expiresAt: input.expiresAt || null,
          },
        });
        return { ok: true, roleReset };
      }),

    adminBatchUpdate: adminProcedure
      .input(z.object({
        ids: z.array(z.number().int().positive()).min(1),
        permissionProfile: z.enum(["starter", "plus", "internal"]).optional(),
        roleTemplate: z.string().min(1).max(64).optional(),
        ttlDays: z.number().int().min(0).max(365).optional(),
        status: z.enum(["creating", "active", "expiring", "recycled", "failed"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const role = input.roleTemplate ? resolveAgentRoleTemplate(input.roleTemplate) : null;
        const beforeRows = role
          ? (await Promise.all(input.ids.map((id) => getClawAdoptionAdminById(id)))).filter((row): row is AdminClawAdoption => Boolean(row))
          : [];
        if (role && beforeRows.length !== input.ids.length) {
          throw new TRPCError({ code: "NOT_FOUND", message: "部分智能体不存在" });
        }
        await batchUpdateClawAdoptionAdmin(input.ids, {
          permissionProfile: input.permissionProfile as any,
          roleTemplate: role?.id,
          industry: role?.industry,
          ttlDays: input.ttlDays,
          status: input.status as any,
        });
        const roleResetResults: Array<Awaited<ReturnType<typeof applyAdminRoleReset>> & { id: number; adoptId: string }> = [];
        if (role) {
          for (const before of beforeRows) {
            try {
              const roleReset = await applyAdminRoleReset({
                before,
                role,
                operatorId: ctx.user?.id ?? null,
                targetStatus: input.status || null,
              });
              roleResetResults.push({
                id: Number(before.id),
                adoptId: String(before.adoptId || ""),
                ...roleReset,
              });
              if (roleReset.applied && "activeSkillIds" in roleReset) {
                await recordAuditBestEffort({
                  action: "agent.role.changed",
                  ...auditActor(ctx.user),
                  ...auditRequest(ctx.req),
                  targetType: "agent",
                  targetId: String(before.adoptId || before.id),
                  targetName: before.agentId ? String(before.agentId) : null,
                  agentInstanceId: before.adoptId ? String(before.adoptId) : null,
                  runtimeType: resolveClawRuntime(before.adoptId),
                  runtimeAgentId: before.agentId ? String(before.agentId) : null,
                  metadata: {
                    id: before.id,
                    previousRoleTemplate: roleReset.previousRoleTemplate,
                    roleTemplate: role.id,
                    industry: role.industry,
                    runtime: roleReset.runtime,
                    previousEffectiveAssets: roleReset.previousEffectiveAssets,
                    effectiveAssets: roleReset.effectiveAssets,
                    effectiveAssetDiff: roleReset.effectiveAssetDiff,
                    activeSkillIds: roleReset.activeSkillIds,
                    skillReconcile: roleReset.skillReconcile,
                    mcpReconcile: roleReset.mcpReconcile,
                    sessionEpoch: roleReset.sessionEpoch,
                    changed: roleReset.previousRoleTemplate !== role.id,
                    source: "batch_admin_update",
                  },
                });
              }
            } catch (error: any) {
              await recordAuditBestEffort({
                action: "agent.role.reset_failed",
                ...auditActor(ctx.user),
                ...auditRequest(ctx.req),
                targetType: "agent",
                targetId: String(before.adoptId || before.id),
                targetName: before.agentId ? String(before.agentId) : null,
                agentInstanceId: before.adoptId ? String(before.adoptId) : null,
                runtimeType: resolveClawRuntime(before.adoptId),
                runtimeAgentId: before.agentId ? String(before.agentId) : null,
                metadata: {
                  id: before.id,
                  previousRoleTemplate: before.roleTemplate || null,
                  roleTemplate: role.id,
                  industry: role.industry,
                  roleRuntimeTarget: role.runtime,
                  error: auditErrorMetadata(error),
                  source: "batch_admin_update",
                },
              });
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: `批量岗位重置失败: ${String(before.adoptId || before.id)} ${error?.message || String(error)}`,
              });
            }
          }
        }
        await recordAuditBestEffort({
          action: "agent.lifecycle.batch_admin_updated",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "agent_batch",
          targetId: input.ids.join(","),
          metadata: {
            count: input.ids.length,
            permissionProfile: input.permissionProfile || null,
            roleTemplate: role?.id || null,
            industry: role?.industry || null,
            roleRuntimeTarget: role?.runtime || null,
            reconcileApplied: roleResetResults.some((item) => item.applied),
            roleResetCount: roleResetResults.filter((item) => item.applied).length,
            roleResetResults,
            ttlDays: input.ttlDays ?? null,
            status: input.status || null,
          },
        });
        return { ok: true, count: input.ids.length, roleResetResults };
      }),

    adminDelete: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const row = await getClawAdoptionAdminById(input.id);
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "智能体不存在" });
        }
        if (!["recycled", "failed"].includes(String(row.status))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "请先停用智能体，再执行删除" });
        }

        const adoptId = String(row.adoptId || "");
        const runtimeAgentId = resolveRuntimeAgentId(adoptId, String(row.agentId || ""));
        const jiuwenRuntime = isJiuwenClawAdoptId(adoptId);
        const workspacePath = jiuwenRuntime ? jiuwenClawWorkspaceDir(adoptId, row.agentId) : "";
        const agentStatePath = jiuwenRuntime ? path.dirname(jiuwenClawAgentDir(adoptId, row.agentId)) : "";
        const skillsRemoved = pruneSkillRegistryForAdopt(adoptId);
        const configPruned = false;
        try {
          if (existsSync(agentStatePath)) rmSync(agentStatePath, { recursive: true, force: true });
        } catch (e: any) {
          logWarn("agent.delete.runtime_state_failed", {
            adoptId,
            agentStatePath,
            error: String(e?.message || e),
          });
        }

        const deleted = await deleteClawAdoptionAdmin(input.id);
        bumpClawSessionEpochBestEffort(adoptId);
        await recordAuditBestEffort({
          action: "agent.lifecycle.deleted",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "agent",
          targetId: adoptId,
          targetName: String(row.agentId || ""),
          agentInstanceId: adoptId,
          runtimeType: resolveClawRuntime(adoptId),
          runtimeAgentId,
          metadata: {
            id: input.id,
            priorStatus: row.status,
            workspaceRemoved: !workspacePath || !existsSync(workspacePath),
            agentStateRemoved: !agentStatePath || !existsSync(agentStatePath),
            skillsRemoved,
            configPruned,
            runtimeRetired: !jiuwenRuntime,
          },
        });
        writeClawExecAudit({
          adoptId,
          agentId: String(row.agentId || ""),
          userId: ctx.user?.id ?? null,
          permissionProfile: String(row.permissionProfile || ""),
          message: "admin_delete_claw",
          ok: true,
          meta: {
            id: input.id,
            runtimeAgentId,
            status: row.status,
            workspaceRemoved: !workspacePath || !existsSync(workspacePath),
            agentStateRemoved: !agentStatePath || !existsSync(agentStatePath),
            skillsRemoved,
            configPruned,
            runtimeRetired: !jiuwenRuntime,
          },
        });

        return {
          ok: true,
          deleted: {
            id: deleted.id,
            adoptId: deleted.adoptId,
            agentId: deleted.agentId,
            status: deleted.status,
          },
          cleanup: {
            workspacePath,
            workspaceRemoved: !workspacePath || !existsSync(workspacePath),
            agentStatePath,
            agentStateRemoved: !agentStatePath || !existsSync(agentStatePath),
            skillsRemoved,
            configPruned,
          },
        };
      }),

    // ── 技能市场管理 ──

    // 管理员列表（从 DB + 文件系统）
    adminListMarketSkills: adminProcedure
      .input(z.object({ status: z.string().optional() }).optional())
      .query(async ({ input }) => {
        return listSkillMarketItems(input?.status);
      }),

    adminRoleAssetCatalog: adminProcedure.query(async () => {
      await syncGlobalOpenSourceSkillGrants({ actor: "admin-role-asset-catalog" });
      const roles = listAgentRoleTemplates()
        .filter((role) => role.status !== "disabled")
        .map((role) => ({
          id: role.id,
          name: role.name,
          industry: role.industry,
          status: role.status,
          displayOrder: role.displayOrder,
        }));
      const skills = await listSkillMarketItems("approved");
      const mcpGroups = listMcpToolGroups();
      const mcpServersById = new Map<string, any>();
      for (const server of listConfiguredMcpServers()) {
        mcpServersById.set(server.serverId, {
          ...server,
          name: server.serverId,
          groupId: "",
            groupName: "MCP 工具",
        });
      }
      for (const group of Array.isArray(mcpGroups.items) ? mcpGroups.items : []) {
        for (const child of Array.isArray((group as any).children) ? (group as any).children : []) {
          const serverId = String((child as any).serverId || "").trim();
          if (!serverId) continue;
          const existing = mcpServersById.get(serverId) || {};
          mcpServersById.set(serverId, {
            ...existing,
            serverId,
            name: (child as any).name || serverId,
            groupId: (group as any).id || "",
            groupName: (group as any).name || "",
            status: (child as any).status || existing.status || "unknown",
            configured: Boolean((child as any).configured || existing.configured),
            enabled: Boolean((child as any).enabled || existing.enabled),
          });
        }
      }
      const grants = await listRoleAssetGrants();
      return {
        roles,
        skills,
        mcpServers: Array.from(mcpServersById.values()).sort((a, b) => a.serverId.localeCompare(b.serverId)),
        grants,
      };
    }),

    adminSetRoleAssetGrants: adminProcedure
      .input(z.object({
        assetType: z.enum(["skill", "mcp_server"]),
        assetId: z.string().min(1).max(128),
        grants: z.array(z.object({
          roleKey: z.string().min(1).max(64),
          grantMode: z.enum(["default", "optional"]),
        })).max(100),
      }))
      .mutation(async ({ input, ctx }) => {
        const validRoleKeys = new Set(["*", ...listAgentRoleTemplates().map((role) => role.id)]);
        const grants = input.grants.map((grant) => ({
          roleKey: grant.roleKey.trim(),
          grantMode: grant.grantMode,
        }));
        for (const grant of grants) {
          if (!validRoleKeys.has(grant.roleKey)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `未知岗位: ${grant.roleKey}` });
          }
        }

        const assetId = input.assetId.trim();
        if (input.assetType === "skill") {
          const skills = await listSkillMarketItems("approved");
          if (!skills.some((skill: any) => String(skill.skillId) === assetId)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `未上架技能不存在: ${assetId}` });
          }
        } else {
          const mcpGroups = listMcpToolGroups();
          const serverIds = new Set<string>();
          for (const group of Array.isArray(mcpGroups.items) ? mcpGroups.items : []) {
            for (const child of Array.isArray((group as any).children) ? (group as any).children : []) {
              const serverId = String((child as any).serverId || "").trim();
              if (serverId) serverIds.add(serverId);
            }
          }
          if (!serverIds.has(assetId)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `未知 MCP server: ${assetId}` });
          }
        }

        const rows = await replaceAdminRoleAssetGrantsForAsset({
          assetType: input.assetType,
          assetId,
          grants,
          actor: ctx.user?.email || `user:${ctx.user?.id || "admin"}`,
        });
        await recordAuditBestEffort({
          action: "role_asset_grants.admin_set",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: input.assetType,
          targetId: assetId,
          metadata: {
            assetType: input.assetType,
            assetId,
            grants,
            adminGrantCount: grants.length,
          },
        });
        return { ok: true, rows };
      }),

    adminSystemHealth: adminProcedure.query(async () => getAdminSystemHealth(await getAvailableJiuwenModels())),

    // 管理员上传技能包（zip）— 通过 Express 路由处理，这里只做元数据入库
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

    // 审核（通过/拒绝/下架）— 同时移动文件目录
    adminReviewSkill: adminProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["approved", "rejected", "offline"]),
        reviewNote: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const item = await getSkillMarketItem(input.id);
        if (!item) throw new TRPCError({ code: "NOT_FOUND" });
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
          const newDir = safeChildPath(statusDir, `${itemSkillId}-${item.id}`);
          if (oldDir !== newDir) {
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
          if (input.status === "approved") {
            const origin = String((item as any).origin || "opensource");
            const approvedRows = await listSkillMarketItems("approved");
            for (const row of approvedRows) {
              if (Number(row.id) === Number(item.id)) continue;
              if (String(row.skillId) !== String(item.skillId)) continue;
              if (String((row as any).origin || "opensource") !== origin) continue;
              await updateSkillMarketItem(Number(row.id), { status: "offline" });
            }
          }
          await updateSkillMarketItem(input.id, {
            status: input.status,
            reviewNote: input.reviewNote || null,
            packagePath: newDir,
          });
          if (String((item as any).origin || "opensource") === "opensource") {
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

    // 查看技能源码（SKILL.md + 文本源码文件）
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
            entries = readdirSync(currentDir, { withFileTypes: true }) as any;
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

    // 删除
    adminDeleteMarketSkill: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const item = await getSkillMarketItem(input.id);
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
      }),

    // 用户端浏览已上架技能。技能市场全量开放；岗位只决定默认预装 skill 和 MCP 权限。
    marketList: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64).optional() }).optional())
      .query(async ({ input, ctx }) => {
        await syncGlobalOpenSourceSkillGrants({ actor: "market-list" });
        const rows = await listApprovedSkillMarketItems();
        const items = rows.map((row) => toPublicSkillMarketItem(row));
        const adoptId = String(input?.adoptId || "").trim();
        if (!adoptId) return items;
        await assertClawOwnerOrThrow(ctx, adoptId);
        return items;
      }),

    // 用户安装（复制到 workspace/skills/）
    marketInstall: protectedProcedure
      .input(z.object({ marketId: z.number(), adoptId: z.string().min(1).max(64) }))
      .mutation(async ({ input, ctx }) => {
        if (String(input.adoptId).startsWith("lgh-")) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Legacy runtime has been archived.",
          });
        }
        const item = await getSkillMarketItem(input.marketId);
        if (!item || item.status !== "approved") throw new TRPCError({ code: "NOT_FOUND", message: "技能不存在或未上架" });
        await assertClawOwnerOrThrow(ctx, input.adoptId);
        const claw = await getClawByAdoptId(input.adoptId);
        // DB may contain legacy .openclaw skill-market paths. New installs read
        // through SKILL_STORE first and only use legacy paths as compatibility.
        const resolvedPackagePath = remapLegacySkillMarketPath(item.packagePath || "");
        if (!resolvedPackagePath || !existsSync(resolvedPackagePath)) {
          throw new TRPCError({ code: "NOT_FOUND", message: "技能包源不存在" });
        }

        const parsed = parseSkillSourceDirectory(resolvedPackagePath, item.skillId || item.name || "market-skill");
        const source: SkillSource = {
          kind: "marketplace",
          skillId: parsed.skillId || item.skillId,
          displayName: item.name || parsed.displayName || item.skillId,
          description: item.description || parsed.description || "",
          sourcePath: resolvedPackagePath,
          marketplaceId: String(item.id),
          version: String(item.version || parsed.manifest?.version || "1.0.0"),
        };
        const installed = await skillRegistry.install(input.adoptId, source);
        if (!installed.ok) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: installed.error.detail });
        }
        await skillRegistry.updateScan(input.adoptId, source.skillId, {
          warnings: parsed.warnings,
          scannedAt: new Date().toISOString(),
        });
        await incrementSkillDownload(input.marketId);
        await recordAuditBestEffort({
          action: "skill.installed",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "skill",
          targetId: source.skillId,
          targetName: source.displayName,
          resourceType: "agent",
          resourceId: input.adoptId,
          agentInstanceId: input.adoptId,
          runtimeType: resolveClawRuntime(input.adoptId),
          runtimeAgentId: String(claw?.agentId || ""),
          metadata: {
            marketplaceId: input.marketId,
            version: source.version,
            warningCount: parsed.warnings.length,
            roleTemplate: String((claw as any)?.roleTemplate || "general-assistant"),
          },
        });
        return { ok: true, skillId: source.skillId, name: source.displayName, item: installed.value, warnings: parsed.warnings };
      }),

    adminGetConfig: adminProcedure.query(async () => {
      const visibility = (await getSystemConfigValue("claw_visibility", "internal")).trim() || "internal";
      const defaultProfile = (await getSystemConfigValue("claw_default_profile", "plus")).trim() || "plus";
      return {
        visibility: visibility === "internal" ? "internal" : "public",
        defaultProfile: (defaultProfile === "internal" ? "internal" : "plus") as "plus" | "internal",
      };
    }),

    adminSetConfig: adminProcedure
      .input(z.object({
        visibility: z.enum(["public", "internal"]).optional(),
        defaultProfile: z.enum(["plus", "internal"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        if (input.visibility) {
          await upsertSystemConfig(
            { key: "claw_visibility", value: input.visibility, description: "岗位智能体可见性：public/internal" },
            ctx.user!.id
          );
        }
        if (input.defaultProfile) {
          await upsertSystemConfig(
            { key: "claw_default_profile", value: input.defaultProfile, description: "新建岗位智能体默认角色：plus=员工，internal=管理员；底层 runtime 单独映射工具权限" },
            ctx.user!.id
          );
        }
        return { ok: true };
      }),

    adminGetModelSettings: adminProcedure.query(async () => {
      const [models, eaModel] = await Promise.all([
        listJiuwenModelsWithSecrets(),
        getEaAssistantModelAdminConfig(),
      ]);
      const publicModels = toPublicJiuwenModels(models);
      return {
        models: publicModels,
        eaModel,
        providers: [...JIUWEN_MODEL_PROVIDERS],
        reasoningLevels: [...JIUWEN_REASONING_LEVELS],
      };
    }),

    adminValidateAgentModel: adminProcedure
      .input(jiuwenModelDraftSchema)
      .mutation(async ({ input, ctx }) => {
        const started = Date.now();
        try {
          await validateJiuwenModel(input);
          await recordAuditBestEffort({
            action: "runtime.model.validate",
            result: "success",
            severity: "low",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "runtime_model",
            targetId: modelIdentity(input),
            runtimeType: "jiuwenswarm",
            metadata: { provider: input.provider, elapsedMs: Date.now() - started },
          });
          return { ok: true, elapsedMs: Date.now() - started };
        } catch (error: any) {
          await recordAuditBestEffort({
            action: "runtime.model.validate",
            result: "failed",
            severity: "medium",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "runtime_model",
            targetId: modelIdentity(input),
            runtimeType: "jiuwenswarm",
            errorCode: "MODEL_VALIDATION_FAILED",
            metadata: { provider: input.provider, elapsedMs: Date.now() - started },
          });
          throw new TRPCError({ code: "BAD_REQUEST", message: sanitizeModelAdminError(error) || "模型连接测试失败" });
        }
      }),

    adminSaveModelSettings: adminProcedure
      .input(z.object({
        models: z.array(jiuwenModelDraftSchema).min(1).max(30),
      }))
      .mutation(async ({ input, ctx }) => {
        try {
          const saved = await replaceJiuwenModels(input.models);
          await recordAuditBestEffort({
            action: "runtime.model.settings_updated",
            result: "success",
            severity: "medium",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "runtime_model",
            targetId: "jiuwenswarm",
            runtimeType: "jiuwenswarm",
            metadata: {
              modelCount: saved.length,
              primaryModel: saved[0]?.modelName || null,
            },
          });
          return { ok: true, count: saved.length };
        } catch (error: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: sanitizeModelAdminError(error) || "模型配置保存失败" });
        }
      }),

    adminValidateEaAssistantModel: adminProcedure
      .input(eaAssistantModelDraftSchema)
      .mutation(async ({ input, ctx }) => {
        const started = Date.now();
        try {
          const elapsedMs = await validateEaAssistantModel(input);
          await recordAuditBestEffort({
            action: "platform.model.validate",
            result: "success",
            severity: "low",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "platform_model",
            targetId: input.modelName,
            metadata: { provider: input.provider, elapsedMs },
          });
          return { ok: true, elapsedMs };
        } catch (error: any) {
          await recordAuditBestEffort({
            action: "platform.model.validate",
            result: "failed",
            severity: "medium",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "platform_model",
            targetId: input.modelName,
            errorCode: "EA_MODEL_VALIDATION_FAILED",
            metadata: { provider: input.provider, elapsedMs: Date.now() - started },
          });
          throw new TRPCError({ code: "BAD_REQUEST", message: sanitizeModelAdminError(error) || "Agent 平台模型连接测试失败" });
        }
      }),

    adminSaveEaAssistantModel: adminProcedure
      .input(eaAssistantModelDraftSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          await saveEaAssistantModelConfig(input, Number(ctx.user!.id));
          await recordAuditBestEffort({
            action: "platform.model.settings_updated",
            result: "success",
            severity: "medium",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "platform_model",
            targetId: input.modelName,
            metadata: { provider: input.provider, timeoutMs: input.timeoutMs, disableThinking: input.disableThinking },
          });
          return { ok: true };
        } catch (error: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: sanitizeModelAdminError(error) || "Agent 平台模型配置保存失败" });
        }
      }),

    // ── 品牌配置 ──
    adminGetBrand: adminProcedure.query(async () => {
      const { getBrandConfig } = await import("../_core/brand");
      return await getBrandConfig();
    }),

    adminSetBrand: adminProcedure
      .input(z.object({
        name: z.string().min(1).max(30).optional(),
        nameEn: z.string().min(1).max(50).optional(),
        platform: z.string().min(1).max(30).optional(),
        platformEn: z.string().min(1).max(50).optional(),
        slogan: z.string().max(100).optional(),
        accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        logo: z.string().max(200).optional(),
        favicon: z.string().max(200).optional(),
        systemPrompt: z.string().max(500).optional(),
        agentIdentity: z.string().max(500).optional(),
        githubUrl: z.string().max(200).optional(),
        pageTitle: z.string().max(100).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { BRAND_DB_KEYS } = await import("@shared/brand");
        for (const [field, dbKey] of Object.entries(BRAND_DB_KEYS)) {
          const val = (input as any)[field];
          if (val !== undefined && val !== null) {
            await upsertSystemConfig(
              { key: dbKey, value: String(val), description: `品牌配置: ${field}` },
              ctx.user!.id
            );
          }
        }
        // 刷新缓存
        const { invalidateBrandCache } = await import("../_core/brand");
        invalidateBrandCache();
        return { ok: true };
      }),

    getSettings: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64) }))
      .query(async ({ input, ctx }) => {
        const startedAt = Date.now();
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);
        const settings = await getClawProfileSettings(Number(claw.id));
        // 读取模型覆盖（存在 claw-model-overrides.json）
        let modelOverride = "";
        try {
          const { readFileSync } = await import("fs");
          const overrides = JSON.parse(readFileSync(`${APP_ROOT}/data/claw-model-overrides.json`, "utf8") || "{}");
          modelOverride = overrides[input.adoptId] || "";
        } catch {}
        const modelPreference = String((settings as any)?.model || modelOverride || "");
        const base = settings || {
          adoptionId: Number(claw.id),
          displayName: "岗位智能体",
          personaPrompt: "",
          stylePreset: "steady_research",
          memoryEnabled: "yes",
          memoryMode: "learn_and_use",
          memorySummary: "",
          contextTurns: 20,
          crossSessionContext: "yes",
        };
        logIosLoadDebug("trpc_claw_getSettings", {
          adoptId: input.adoptId,
          clawId: (claw as any).id,
          hasSettings: Boolean(settings),
          modelOverride: modelPreference,
          ms: Date.now() - startedAt,
        });
        return { ...base, model: modelPreference };
      }),

    updateSettings: protectedProcedure
      .input(
        z.object({
          adoptId: z.string().min(1).max(64),
          displayName: z.string().max(100).optional(),
          personaPrompt: z.string().max(5000).optional(),
          stylePreset: z.enum(["steady_research", "aggressive_trading", "education_advisor", "custom"]).optional(),
          memoryEnabled: z.enum(["yes", "no"]).optional(),
          memoryMode: z.enum(["learn_and_use", "use_only", "off"]).optional(),
          memorySummary: z.string().max(5000).optional(),
          contextTurns: z.number().int().min(5).max(100).optional(),
          crossSessionContext: z.enum(["yes", "no"]).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw) throw new Error("智能体实例不存在");
        if (Number(claw.userId) !== Number(ctx.user!.id)) {
          throw new Error("无权修改该智能体设置");
        }

        const { adoptId, ...patch } = input;
        if (patch.memoryMode !== undefined) {
          patch.memoryEnabled = patch.memoryMode === "off" ? "no" : "yes";
        } else if (patch.memoryEnabled !== undefined) {
          patch.memoryMode = patch.memoryEnabled === "no" ? "off" : "learn_and_use";
        }
        const updated = await upsertClawProfileSettings(Number(claw.id), {
          ...patch,
          updatedBy: ctx.user!.id,
        });

        return { success: true, settings: updated };
      }),

    adopt: protectedProcedure
      .input(
        z
          .object({
            permissionProfile: z.enum(["plus", "internal"]).optional(),
            roleTemplate: z.string().min(1).max(64).optional(),
            preferRuntime: z.literal("jiuwenswarm").optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const userId = ctx.user!.id;

        // 可见性复用 Demo 权限模型：internal 仅 all 用户可创建
        const clawVisibility = (await getSystemConfigValue("claw_visibility", "internal")).trim() || "internal";
        const userAccessLevel = ((ctx.user as any)?.accessLevel || "public_only") as "public_only" | "all";
        if (clawVisibility === "internal" && userAccessLevel !== "all") {
          throw new Error("当前岗位智能体为内部访问，仅内部权限用户可创建");
        }

        const preferRuntime = input?.preferRuntime;
        const role = resolveSelectableAdoptRoleTemplate(input?.roleTemplate);
        const provisionPlan = resolveRoleRuntimeProvisionPlan(role, {
          jiuwenswarmProvisionEnabled: isJiuwenSwarmProvisionEnabled(),
        });
        if (provisionPlan.runtime !== "jiuwenswarm") {
          throw new Error(retiredRuntimeMessage());
        }
        if (provisionPlan.runtime === "jiuwenswarm" && !isJiuwenSwarmProvisionEnabled()) {
          throw new Error("JiuwenSwarm 当前未配置。请先安装并启用 JiuwenSwarm runtime，再创建岗位智能体。");
        }
        if (preferRuntime && provisionPlan.runtime !== preferRuntime) {
          throw new Error("JiuwenSwarm 当前不可用，请稍后重试");
        }

        // 幂等：只复用目标 runtime 的现有实例，避免老 lgc-* 阻止创建当前默认的 lgj-*。
        const existing = (await listClawsByUserId(userId)).find((claw) => {
          const runtime = String((claw as any).runtime || resolveClawRuntime(claw.adoptId));
          if (runtime === provisionPlan.runtime) return true;
          return provisionPlan.runtime === "jiuwenswarm" && claw.adoptId.startsWith("lgj-");
        }) || null;
        if (existing) {
          const normalizedExisting = {
            ...existing,
            entryUrl: buildClawEntryUrl(String((existing as any).adoptId || "")),
          };
          return {
            success: true,
            reused: true,
            adoption: normalizedExisting,
          };
        }

        const defaultProfile = (await getSystemConfigValue("claw_default_profile", "plus")).trim() || "plus";
        const profile = input?.permissionProfile || (defaultProfile === "internal" ? "internal" : "plus");
        const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
        const runtimeAdapter = getRoleRuntimeAdapter(provisionPlan.runtime);
        const ttlDays = 0;

        const suffix = randomRuntimeSuffix();
        const adoptId = `lgj-${suffix}`;
        const agentId = `jiuwen_${adoptId}`;
        const entryUrl = buildClawEntryUrl(adoptId);
        const expiresAt = null;

        const adoptionId = await createClawAdoption({
          userId,
          adoptId,
          agentId,
          status: "creating",
          permissionProfile: profile as "starter" | "plus" | "internal",
          roleTemplate: role.id,
          industry: role.industry,
          runtime: provisionPlan.runtime,
          ttlDays,
          entryUrl,
          expiresAt,
        });
        await recordAuditBestEffort({
          action: "agent.lifecycle.create_requested",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "agent",
          targetId: adoptId,
          targetName: agentId,
          agentInstanceId: adoptId,
          runtimeType: provisionPlan.runtime,
          runtimeAgentId: agentId,
          metadata: {
            profile,
            roleTemplate: role.id,
            industry: role.industry,
            roleRuntimeTarget: role.runtime,
            requestedRuntime: provisionPlan.requestedRuntime,
            actualRuntime: provisionPlan.runtime,
            runtimeFallbackApplied: provisionPlan.fallbackApplied,
            runtimeFallbackReason: provisionPlan.fallbackReason || null,
            effectiveAssets,
            reconcileApplied: false,
            ttlDays,
            lifecycle: ttlDays > 0 ? "temporary" : "long_lived",
            source: "web",
          },
        });

        await appendClawAdoptionEvent({
          adoptionId,
          eventType: "create_requested",
          operatorType: "user",
          operatorId: userId,
          detail: JSON.stringify({
            profile,
            roleTemplate: role.id,
            industry: role.industry,
            roleRuntimeTarget: role.runtime,
            requestedRuntime: provisionPlan.requestedRuntime,
            actualRuntime: provisionPlan.runtime,
            runtimeFallbackApplied: provisionPlan.fallbackApplied,
            runtimeFallbackReason: provisionPlan.fallbackReason || null,
            effectiveAssets,
            reconcileApplied: false,
            ttlDays,
            lifecycle: ttlDays > 0 ? "temporary" : "long_lived",
            source: "web",
          }),
        });

        try {
          // 编排创建实例（mock/local-script 或 runtime adapter）
          const provision = await runtimeAdapter.provision({
            adoptId,
            agentId,
            userId,
            permissionProfile: profile as "starter" | "plus" | "internal",
            ttlDays,
            role,
            effectiveAssets,
          });
          const skillReconcile = await runtimeAdapter.reconcileSkills({ adoptId, agentId, role, effectiveAssets });
          const mcpReconcile = await runtimeAdapter.reconcileMcp({ adoptId, agentId, role, effectiveAssets });

          await updateClawAdoptionStatus(adoptionId, "active");

          await appendClawAdoptionEvent({
            adoptionId,
            eventType: "create_succeeded",
            operatorType: "system",
            operatorId: null,
            detail: JSON.stringify(provision),
          });
          await recordAuditBestEffort({
            action: "agent.lifecycle.create_succeeded",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "agent",
            targetId: adoptId,
            targetName: agentId,
            agentInstanceId: adoptId,
            runtimeType: provisionPlan.runtime,
            runtimeAgentId: agentId,
            metadata: {
              adoptionId,
              profile,
              roleTemplate: role.id,
              industry: role.industry,
              roleRuntimeTarget: role.runtime,
              requestedRuntime: provisionPlan.requestedRuntime,
              actualRuntime: provisionPlan.runtime,
              runtimeFallbackApplied: provisionPlan.fallbackApplied,
              runtimeFallbackReason: provisionPlan.fallbackReason || null,
              effectiveAssets,
              skillReconcile,
              mcpReconcile,
              reconcileApplied: Boolean(skillReconcile.applied || mcpReconcile.applied),
              ttlDays,
              entryUrl,
            },
          });

          onboardBuiltinSkillsForAdopt(adoptId, agentId).catch((error) => {
            logWarn("skill.onboarding.failed", {
              adoptId,
              error: error instanceof Error ? error.message : String(error),
            });
          });

          const latest = await getClawByAdoptId(adoptId);
          return {
            success: true,
            reused: false,
            adoption: latest
              ? {
                  ...latest,
                  entryUrl: buildClawEntryUrl(String((latest as any).adoptId || adoptId)),
                }
              : null,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await updateClawAdoptionStatus(adoptionId, "failed", { lastError: msg });
          await appendClawAdoptionEvent({
            adoptionId,
            eventType: "create_failed",
            operatorType: "system",
            operatorId: null,
            detail: msg,
          });
          await recordAuditBestEffort({
            action: "agent.lifecycle.create_failed",
            result: "failed",
            severity: "medium",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "agent",
            targetId: adoptId,
            targetName: agentId,
            agentInstanceId: adoptId,
            runtimeType: provisionPlan.runtime,
            runtimeAgentId: agentId,
            errorCode: "AGENT_CREATE_FAILED",
            metadata: auditErrorMetadata(error),
          });
          throw new Error(`岗位智能体创建失败：${msg}`);
        }
      }),

    chat: protectedProcedure
      .input(
        z.object({
          adoptId: z.string().min(1).max(64),
          message: z.string().min(1).max(4000),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await assertClawOwnerOrThrow(ctx, input.adoptId);
        if (!isJiuwenClawAdoptId(input.adoptId)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Legacy runtime has been archived",
          });
        }
        throw new TRPCError({
          code: "METHOD_NOT_SUPPORTED",
          message: "请使用流式对话接口 /api/claw/chat-stream",
        });
      }),

    // ── 技能管理 ──────────────────────────────────────────────
    probeSkillReadiness: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        skillId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
      }))
      .mutation(async ({ input, ctx }) => {
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);
        if (!isJiuwenClawAdoptId(input.adoptId)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Legacy runtime has been archived",
          });
        }
        return await probeJiuwenSkillMcpReadiness({
          adoptId: input.adoptId,
          skillId: input.skillId,
          roleTemplate: String(claw.roleTemplate || "general-assistant"),
        });
      }),

    // ── 技能管理（JiuwenSwarm）─────────────────────────────────
    listSkills: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64) }))
      .query(async ({ input, ctx }) => {
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);
        if (!isJiuwenClawAdoptId(input.adoptId)) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Legacy runtime has been archived" });
        }
        const listed = await listSkillsWithRoleDefaults({
          adoptId: input.adoptId,
          agentId: resolveRuntimeAgentId(input.adoptId, String(claw.agentId || "")),
          roleTemplate: String(claw.roleTemplate || "general-assistant"),
        });
        if (!listed.ok) {
          return { shared: [], system: [], private: [], privateNotInstalled: [] };
        }
        const privateSkills = listed.value.map((skill) => ({
          id: skill.id,
          label: skill.source.displayName || skill.id,
          desc: skill.source.description || "智能体技能",
          emoji: "⚡",
          source: "private" as const,
          scope: "private" as const,
          sourcePath: skill.sync.runtimePath || skill.source.sourcePath || "",
          ownerAgentId: input.adoptId,
          visible: true,
          runnable: skill.enabled && skill.state === "ready",
          reason: skill.enabled && skill.state === "ready" ? "" : skill.state,
          active: skill.enabled,
          state: skill.state,
          enabled: skill.enabled,
          sync: skill.sync,
          requirements: {
            mcpServers: Object.keys(getSkillMcpRequirement(skill.id).servers),
          },
        }));
        return {
          shared: [],
          system: [],
          private: privateSkills,
          privateNotInstalled: [],
          summary: {
            discovered: privateSkills.length,
            runnable: privateSkills.filter((skill) => skill.runnable).length,
          },
        };
      }),

    toggleSkill: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        skillId: skillIdSchema,
        enable: z.boolean(),
        source: z.enum(["system", "shared", "private"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);
        const result = await setAgentSkillEnabled({
          adoptId: input.adoptId,
          agentId: String(claw.agentId || ""),
          roleTemplate: String(claw.roleTemplate || "general-assistant"),
          skillId: input.skillId,
          enabled: input.enable,
        });
        if (!result.ok) {
          throw new TRPCError({
            code: result.kind === "runtime_retired" ? "PRECONDITION_FAILED" : result.kind === "not_found" ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR",
            message: result.detail,
          });
        }
        await recordAuditBestEffort({
          action: input.enable ? "skill.enabled" : "skill.disabled",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "skill",
          targetId: input.skillId,
          resourceType: "agent",
          resourceId: input.adoptId,
          agentInstanceId: input.adoptId,
          runtimeType: "jiuwenswarm",
          runtimeAgentId: resolveRuntimeAgentId(input.adoptId, String(claw.agentId || "")),
          metadata: { source: input.source || "private" },
        });
        return { ok: true, skillId: input.skillId, enabled: input.enable, item: result.item };
      }),

    // getMemory / updateMemory tRPC 端点已删除 (2026-04-20 review)
    // 前端改用 REST /api/claw/core-files/* + /api/claw/memory/*。

    // ── 会话历史（localStorage 为主，DB 备用）─────────────────
    // 前端用 localStorage，此接口供未来 DB 持久化预留
    getMessages: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64), limit: z.number().min(1).max(200).default(50) }))
      .query(async ({ input, ctx }) => {
        await assertClawOwnerOrThrow(ctx, input.adoptId);
        // 暂时返回空，前端用 localStorage
        return { messages: [] as Array<{ role: string; text: string; ts: number }> };
      }),

});
