import { publicProcedure, protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { execFileSync, execSync } from "child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
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
  touchClawActivity,
  listBusinessAgentAudit,
  reverseTenantToken,
  getTenantAuditStats,
  resolveEffectiveRoleAssets,
  previewRoleAssetSeedSync,
  syncRoleAssetSeed,
  listRoleAssetGrants,
  replaceAdminRoleAssetGrantsForAsset,
  syncGlobalOpenSourceSkillGrants,
  getDb,
} from "../db";
import {
  APP_ROOT,
  OPENCLAW_HOME,
  OPENCLAW_JSON_PATH,
  clawDailyUsage,
  getAvailableClawModelsFromConfig,
  buildClawSessionKey,
  assertClawOwnerOrThrow,
  bumpClawSessionEpochBestEffort,
  applyClawSessionModelViaGatewayCommand,
  setAgentModelInOpenclawConfig,
  provisionEmployeeAgentInstance,
  writeClawExecAudit,
} from "./helpers";
import { isJiuwenClawAdoptId, JIUWENCLAW_HOME, jiuwenClawServiceId, resolveRuntimeAgentId } from "../_core/helpers";
import { getAuditBaselineHealth } from "../_core/audit-health";
import { auditActor, auditErrorMetadata, auditRequest, recordAuditBestEffort, recordAuditRequired } from "../_core/audit-events";
import { onboardBuiltinSkillsForAdopt } from "../_core/skills/skill-onboarding";
import { skillRegistry } from "../_core/skills/skill-registry";
import { listSkillsWithRoleDefaults } from "../_core/skills/role-default-skills";
import { parseSkillSourceDirectory } from "../_core/skills/skill-source";
import { toPublicSkillMarketItem } from "../_core/skills/skill-market-policy";
import {
  remapLegacySkillMarketPath,
  skillStoreMarketplaceDir,
  safeSkillStorePath,
  removeSkillStorePath,
} from "../_core/skills/skill-store";
import { cleanupOpenClawWeixinBindingForAdopt } from "../_core/claw-weixin";
import type { Skill, SkillSource } from "../../shared/types/skill";
import { restoreDeletedProtectedCoreFiles, snapshotProtectedCoreFiles } from "../_core/core-file-guard";
import {
  getAgentRoleTemplate,
  getRoleSkillMcpBaseline,
  listAgentRoleTemplates,
  resolveAgentRoleTemplate,
} from "../_core/role-templates";
import type { AgentRoleTemplate, AgentRuntime } from "../_core/role-templates";
import { resolveRoleRuntimeProvisionPlan } from "../_core/role-runtime-adapter";
import { getRoleRuntimeAdapter, isJiuwenSwarmProvisionEnabled } from "./role-runtime-adapters";
import { listConfiguredMcpServers, listMcpToolGroups } from "../_core/claw-skills";
import {
  getEaAssistantModelAdminConfig,
  saveEaAssistantModelConfig,
  validateEaAssistantModel,
} from "../_core/ea-assistant-model";
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

type ResolvedClawRuntime = "openclaw" | "jiuwenclaw" | "legacy_archived";

const skillIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "技能ID只能包含小写字母、数字和连字符");
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
  const id = String(adoptId || "");
  if (id.startsWith("lgj-")) return "jiuwenclaw";
  if (id.startsWith("lgh-")) return "legacy_archived";
  return "openclaw";
};

function buildRemoteSshArgs(remoteUser: string, remoteHost: string, connectTimeoutSec = 8): string[] {
  if (process.env.CLAW_REMOTE_PASSWORD) {
    throw new Error("CLAW_REMOTE_PASSWORD is not supported. Use SSH key or agent authentication with known_hosts.");
  }
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `ConnectTimeout=${connectTimeoutSec}`,
  ];
  const knownHosts = String(process.env.CLAW_REMOTE_KNOWN_HOSTS_FILE || "").trim();
  if (knownHosts) args.push("-o", `UserKnownHostsFile=${knownHosts}`);
  const keyPath = String(process.env.CLAW_REMOTE_SSH_KEY || "").trim();
  if (keyPath) args.push("-i", keyPath);
  args.push(`${remoteUser}@${remoteHost}`);
  return args;
}

function runRemoteShellCommand(remoteUser: string, remoteHost: string, command: string, timeoutMs = 10000): string {
  return execFileSync("ssh", [...buildRemoteSshArgs(remoteUser, remoteHost), command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: timeoutMs,
  }).trim();
}

function execRemoteShellCommand(remoteUser: string, remoteHost: string, command: string, timeoutMs = 10000): void {
  execFileSync("ssh", [...buildRemoteSshArgs(remoteUser, remoteHost), command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

function publicAppBaseUrl(): string {
  const raw =
    process.env.WORKFORCE_AGENT_PUBLIC_BASE_URL
    || process.env.FRONTEND_URL
    || process.env.PUBLIC_BASE_URL
    || "http://localhost:5180";
  return String(raw || "").replace(/\/+$/, "");
}

function buildClawEntryUrl(adoptId: string): string {
  return `${publicAppBaseUrl()}/claw/${encodeURIComponent(adoptId)}`;
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
  return "openclaw";
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
    console.warn("[ROLE-RESET][SKILLS] failed to list installed skills; using role defaults only", {
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
  console.log(`[IOS-LOAD] ${message}`, fields);
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
    console.warn("[models] failed to read JiuwenSwarm model catalog; using configured fallback", {
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
  const runtime = resolveClawRuntime(adoptId);
  if (runtime === "jiuwenclaw") return await getAvailableJiuwenModels();
  if (runtime === "legacy_archived") return [];
  return getAvailableClawModelsFromConfig();
};

const openClawWorkspaceDir = (runtimeAgentId: string) => `${OPENCLAW_HOME}/workspace-${String(runtimeAgentId || "").trim()}`;
const openClawAgentStateDir = (runtimeAgentId: string) => `${OPENCLAW_HOME}/agents/${String(runtimeAgentId || "").trim()}`;
const openClawSharedSkillsDir = () => `${OPENCLAW_HOME}/skills-shared`;
const skillMarketDir = () => skillStoreMarketplaceDir();

function safeExec(command: string, timeout = 8000): { ok: boolean; output: string; error?: string } {
  try {
    return {
      ok: true,
      output: execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim(),
    };
  } catch (e: any) {
    return {
      ok: false,
      output: String(e?.stdout || "").trim(),
      error: String(e?.stderr || e?.message || e).trim(),
    };
  }
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function resolveOpenClawCli(): string {
  const candidates = [
    process.env.OPENCLAW_BIN,
    `${process.env.HOME || ""}/.npm-global/bin/openclaw`,
    `${process.env.HOME || ""}/.local/bin/openclaw`,
    `${process.env.HOME || ""}/bin/openclaw`,
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return shellQuote(candidate);
  }
  return "openclaw";
}

function safeJson<T = any>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function redactHealthValue(value: any): any {
  if (Array.isArray(value)) return value.map(redactHealthValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|secret|password|apiKey|cookie/i.test(key)) out[key] = "***";
    else out[key] = redactHealthValue(raw);
  }
  return out;
}

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
    console.warn("[ADMIN-DELETE-CLAW] failed to prune skill registry", { adoptId, error: String(e?.message || e) });
    return 0;
  }
}

function pruneOpenClawAgentConfig(agentIds: string[]): boolean {
  try {
    if (!existsSync(OPENCLAW_JSON_PATH)) return false;
    const config = JSON.parse(String(readFileSync(OPENCLAW_JSON_PATH, "utf-8") || "{}"));
    const list = Array.isArray(config?.agents?.list) ? config.agents.list : null;
    if (!list) return false;
    const idSet = new Set(agentIds.map((id) => String(id || "").trim()).filter(Boolean));
    const next = list.filter((entry: any) => !idSet.has(String(entry?.id || "")));
    if (next.length === list.length) return false;
    config.agents.list = next;
    writeFileSync(OPENCLAW_JSON_PATH, JSON.stringify(config, null, 2), "utf-8");
    return true;
  } catch (e: any) {
    console.warn("[ADMIN-DELETE-CLAW] failed to prune openclaw config", { agentIds, error: String(e?.message || e) });
    return false;
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
        if (runtimeType === "legacy_archived") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Legacy runtime has been archived. Provision a JiuwenClaw agent instead.",
          });
        }
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw) throw new Error("智能体实例不存在");
        if (Number(claw.userId) !== Number(ctx.user!.id)) {
          throw new Error("无权修改该智能体设置");
        }
        let jiuwenSelection: Awaited<ReturnType<typeof resolveSelectableJiuwenModel>> = null;
        if (runtimeType === "jiuwenclaw") {
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
        } else {
          const allowed = new Set((await getAvailableModelsForRuntime(input.adoptId)).map((m) => m.id));
          if (!allowed.has(input.modelId)) throw new Error("不支持的模型");
        }

        const previousSettings = await getClawProfileSettings(Number(claw.id));
        const previousModel = String((previousSettings as any)?.model || "");

        // 1) 保存到业务设置（用于页面回显）
        await upsertClawProfileSettings(Number(claw.id), {
          model: input.modelId,
          updatedBy: ctx.user!.id,
        } as any);

        if (runtimeType !== "openclaw") {
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
              runtimeModel: jiuwenSelection?.runtimeModelId || input.modelId,
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
        }

        // 2) 通过 OpenClaw 会话命令即时切换（不重启 gateway）
        const sessionKey = buildClawSessionKey(String((claw as any).adoptId || input.adoptId), Number((claw as any).userId || 0));
        const applied = await applyClawSessionModelViaGatewayCommand({
          agentId: String((claw as any).agentId || ""),
          sessionKey,
          modelId: input.modelId,
        });

        // 2.5) 持久化到 openclaw.json agents.list[].model —— gateway 热加载后路由才真正切过来
        const cfgApplied = setAgentModelInOpenclawConfig(String((claw as any).agentId || ""), input.modelId);
        if (!cfgApplied.ok) {
          throw new Error(`模型切换持久化失败（${cfgApplied.error}）。当前会话已临时生效，但重启或热加载后会回退到原模型。`);
        }

        // 2.6) 持久化到 claw-model-overrides.json —— 刷新后下拉能记住用户选择
        try {
          const { readFileSync, writeFileSync, existsSync } = await import("fs");
          const op = APP_ROOT + "/data/claw-model-overrides.json";
          let obj: any = {};
          if (existsSync(op)) { try { obj = JSON.parse(readFileSync(op, "utf8") || "{}"); } catch {} }
          obj[input.adoptId] = input.modelId;
          writeFileSync(op, JSON.stringify(obj, null, 2), "utf8");
        } catch (e) { console.warn("[switchModel] overrides persist failed:", e); }

        await recordAuditBestEffort({
          action: "model.switched",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "agent",
          targetId: input.adoptId,
          targetName: String((claw as any).agentId || input.adoptId),
          agentInstanceId: input.adoptId,
          runtimeType: resolveClawRuntime(input.adoptId),
          runtimeAgentId: String((claw as any).agentId || ""),
          metadata: {
            previousModel: previousModel || null,
            model: input.modelId,
            applied: applied.ok,
            statusCode: applied.statusCode || null,
            persistedToConfig: cfgApplied.ok,
          },
        });

        return {
          ok: true,
          model: input.modelId,
          applied: applied.ok,
          statusCode: applied.statusCode || null,
          applyError: applied.ok ? null : applied.error || applied.respText || null,
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
        const workspacePath = openClawWorkspaceDir(runtimeAgentId);
        const agentStatePath = openClawAgentStateDir(runtimeAgentId);
        const skillsRemoved = pruneSkillRegistryForAdopt(adoptId);
        const configPruned = pruneOpenClawAgentConfig([String(row.agentId || ""), runtimeAgentId, `trial_${adoptId}`]);
        const weixinCleanup = cleanupOpenClawWeixinBindingForAdopt(adoptId, row);

        try {
          if (existsSync(workspacePath)) rmSync(workspacePath, { recursive: true, force: true });
        } catch (e: any) {
          console.warn("[ADMIN-DELETE-CLAW] failed to remove workspace", { adoptId, workspacePath, error: String(e?.message || e) });
        }
        try {
          if (existsSync(agentStatePath)) rmSync(agentStatePath, { recursive: true, force: true });
        } catch (e: any) {
          console.warn("[ADMIN-DELETE-CLAW] failed to remove agent state", { adoptId, agentStatePath, error: String(e?.message || e) });
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
            workspaceRemoved: !existsSync(workspacePath),
            agentStateRemoved: !existsSync(agentStatePath),
            skillsRemoved,
            configPruned,
            weixinCleanup: {
              removed: Boolean(weixinCleanup?.removed),
              accountIdPresent: Boolean(weixinCleanup?.accountId),
              userIdPresent: Boolean(weixinCleanup?.userId),
            },
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
            workspaceRemoved: !existsSync(workspacePath),
            agentStateRemoved: !existsSync(agentStatePath),
            skillsRemoved,
            configPruned,
            weixinCleanup,
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
            workspaceRemoved: !existsSync(workspacePath),
            agentStatePath,
            agentStateRemoved: !existsSync(agentStatePath),
            skillsRemoved,
            configPruned,
            weixinCleanup,
          },
        };
      }),

    adminProvisionLegacyClaw: adminProcedure
      .input(z.object({
        userId: z.number().int().positive(),
        // Regex 严格限死 profileName 字符范围，execFileSync 再兜底不走 shell
        profileName: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      }))
      .mutation(async ({ input }) => {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Legacy runtime has been archived. Provision JiuwenClaw agents instead." });
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
          groupName: "OpenClaw MCP",
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

    adminSystemHealth: adminProcedure.query(async () => {
      const checkedAt = new Date().toISOString();
      const openclawCli = resolveOpenClawCli();
      const health = {
        ok: true,
        output: JSON.stringify({ status: "ok", timestamp: checkedAt }),
        error: "",
      };
      const pm2 = safeExec("pm2 jlist", 8000);
      const openclawStatus = safeExec(`${openclawCli} status --json`, 12000);
      const channelStatus = safeExec(`${openclawCli} channels status --deep`, 12000);
      const gitBranch = safeExec("git rev-parse --abbrev-ref HEAD", 5000);
      const gitCommit = safeExec("git rev-parse --short HEAD", 5000);
      const openclawProcesses = safeExec("pgrep -af '^openclaw( |$)'", 5000);

      const pm2Rows = pm2.ok ? safeJson<any[]>(pm2.output || "[]", []) : [];
      const appName = process.env.PM2_APP_NAME || (APP_ROOT.includes("linggan-platform") ? "linggan-claw" : "employee-agent");
      const app = Array.isArray(pm2Rows)
        ? pm2Rows.find((row) => String(row?.name || "") === appName) || pm2Rows.find((row) => /employee-agent|linggan-claw/.test(String(row?.name || "")))
        : null;

      const openclawJson = openclawStatus.ok ? safeJson<any>(openclawStatus.output, null) : null;
      const config = existsSync(OPENCLAW_JSON_PATH) ? safeJson<any>(String(readFileSync(OPENCLAW_JSON_PATH, "utf8") || "{}"), {}) : {};
      const availableModels = getAvailableClawModelsFromConfig();
      const availableModelIds = new Set(availableModels.map((model) => model.id));
      const primary = String(config?.agents?.defaults?.model?.primary || "");
      const agentModelDrift = (Array.isArray(config?.agents?.list) ? config.agents.list : [])
        .map((agent: any) => {
          const model = typeof agent?.model === "string" ? agent.model : String(agent?.model?.primary || "");
          return { id: String(agent?.id || ""), model };
        })
        .filter((agent: any) => agent.model && availableModelIds.size > 0 && !availableModelIds.has(agent.model));

      const dbTables = ["users", "business_agent_audit", "business_agent_tenant_map", "skill_marketplace"] as const;
      const dbTableSet = new Set<string>(dbTables);
      const dbHealth: any = { ok: false, tables: [] as any[], skillMarketApproved: null, claws: null, error: "" };
      const dbStartedAt = Date.now();
      try {
        const db = await getDb();
        if (!db) throw new Error("DB not available");
        dbHealth.ok = true;
        for (const table of dbTables) {
          if (!dbTableSet.has(table)) continue;
          const result: any = await db.execute(`SHOW TABLES LIKE '${table}'`);
          const rows = Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : [];
          dbHealth.tables.push({ name: table, exists: rows.length > 0 });
        }
        const approved: any = await db.execute("SELECT COUNT(*) AS count FROM skill_marketplace WHERE status = 'approved'");
        const claws: any = await db.execute(`
          SELECT
            COUNT(*) AS total,
            SUM(status = 'active') AS active,
            SUM(status = 'active' AND (runtime = 'jiuwenswarm' OR adoptId LIKE 'lgj-%')) AS jiuwenActive,
            SUM(status = 'active' AND (runtime = 'openclaw' OR adoptId LIKE 'lgc-%')) AS openclawActive
          FROM claw_adoptions
        `);
        dbHealth.skillMarketApproved = Number((approved?.[0]?.[0] || approved?.[0] || {}).count || 0);
        const clawRow = claws?.[0]?.[0] || claws?.[0] || {};
        dbHealth.claws = {
          total: Number(clawRow.total || 0),
          active: Number(clawRow.active || 0),
          jiuwenActive: Number(clawRow.jiuwenActive || 0),
          openclawActive: Number(clawRow.openclawActive || 0),
        };
      } catch (e: any) {
        dbHealth.error = String(e?.message || e);
      } finally {
        dbHealth.latencyMs = Date.now() - dbStartedAt;
      }

      const auditBaseline = await getAuditBaselineHealth();

      const channelLines = channelStatus.output.split(/\r?\n/).filter((line) => line.trim().startsWith("- "));
      const channels = channelLines.map((line) => ({
        raw: line.replace(/^\-\s*/, ""),
        ok: /\brunning\b/.test(line) && !/\bstopped\b|\berror:/i.test(line),
        warn: /\bdisconnected\b|degraded|timed out/i.test(line),
      }));

      const processLines = openclawProcesses.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      type HealthStatus = "ok" | "warning" | "error" | "disabled";
      type HealthCheck = {
        key: string;
        group: "platform" | "runtime" | "database" | "channels" | "audit";
        label: string;
        provider?: string;
        status: HealthStatus;
        detail: string;
        meta?: Record<string, unknown>;
      };
      const checks: HealthCheck[] = [];
      const pushCheck = (check: HealthCheck) => checks.push(check);
      const appStatus = String(app?.pm2_env?.status || "");
      pushCheck({
        key: "platform.app",
        group: "platform",
        label: "平台服务",
        provider: "ea",
        status: health.ok && appStatus === "online" ? "ok" : "error",
        detail: `${app?.name || appName} · ${appStatus || "unknown"} · CPU ${app?.monit?.cpu ?? "-"}% · 重启 ${app?.pm2_env?.restart_time ?? "-"} 次`,
      });

      const jiuwenActive = Number(dbHealth.claws?.jiuwenActive || 0);
      const jiuwenEnabled = jiuwenActive > 0 || process.env.WORKFORCE_AGENT_HEALTH_CHECK_JIUWEN === "true";
      const jiuwenGlobalSessionsDir = path.join(JIUWENCLAW_HOME, "agent", "sessions");
      const jiuwenServiceDir = path.join(JIUWENCLAW_HOME, `service_${jiuwenClawServiceId()}`);
      const countDirs = (dir: string) => {
        try {
          return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
        } catch {
          return 0;
        }
      };
      const jiuwenHomeExists = existsSync(JIUWENCLAW_HOME);
      const jiuwenGlobalSessionCount = countDirs(jiuwenGlobalSessionsDir);
      const jiuwenServiceAgentCount = countDirs(jiuwenServiceDir);
      const jiuwenService = safeExec("systemctl is-active jiuwenswarm.service", 3000);
      const jiuwenRecentLog = (() => {
        const logPath = path.join(APP_ROOT, "logs", "jiuwenclaw-exec.log");
        if (!existsSync(logPath)) return { requests24h: 0, completes24h: 0 };
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        let requests24h = 0;
        let completes24h = 0;
        try {
          const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-5000);
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              const ts = Date.parse(String(event?.ts || ""));
              if (!Number.isFinite(ts) || ts < cutoff) continue;
              if (event?.event === "chat_stream_request") requests24h += 1;
              if (event?.event === "chat_stream_complete") completes24h += 1;
            } catch {}
          }
        } catch {}
        return { requests24h, completes24h };
      })();
      pushCheck({
        key: "runtime.jiuwenswarm",
        group: "runtime",
        label: "JiuwenSwarm Runtime",
        provider: "jiuwenswarm",
        status: !jiuwenEnabled
          ? "disabled"
          : jiuwenHomeExists
            ? "ok"
            : "error",
        detail: !jiuwenEnabled
          ? "当前没有启用 JiuwenSwarm 智能体"
          : `${jiuwenActive} 个 active · sessions ${jiuwenGlobalSessionCount} · service agents ${jiuwenServiceAgentCount} · 24h 请求 ${jiuwenRecentLog.requests24h}`,
        meta: {
          home: JIUWENCLAW_HOME,
          serviceId: jiuwenClawServiceId(),
          serviceStatus: jiuwenService.output || jiuwenService.error || "",
          ...jiuwenRecentLog,
        },
      });

      const openclawActive = Number(dbHealth.claws?.openclawActive || 0);
      const openclawEnabled = openclawActive > 0 || process.env.WORKFORCE_AGENT_HEALTH_CHECK_OPENCLAW === "true";
      pushCheck({
        key: "runtime.openclaw",
        group: "runtime",
        label: "OpenClaw Runtime",
        provider: "openclaw",
        status: !openclawEnabled
          ? "disabled"
          : openclawJson?.gateway?.reachable
            ? "ok"
            : processLines.length > 0
              ? "warning"
              : "error",
        detail: !openclawEnabled
          ? "当前没有启用 OpenClaw 智能体"
          : `active ${openclawActive} · gateway ${openclawJson?.gateway?.reachable ? "reachable" : "unreachable"} · process ${processLines.length}`,
      });

      pushCheck({
        key: "data.database",
        group: "database",
        label: "数据库",
        provider: "mysql",
        status: dbHealth.ok && (dbHealth.tables || []).every((table: any) => table.exists) ? "ok" : "error",
        detail: dbHealth.ok
          ? `active ${dbHealth.claws?.active ?? 0}/${dbHealth.claws?.total ?? 0} · 技能 ${dbHealth.skillMarketApproved ?? 0} · ${dbHealth.latencyMs ?? "-"} ms`
          : dbHealth.error || "数据库不可用",
      });
      pushCheck({
        key: "data.audit",
        group: "audit",
        label: "审计基线",
        provider: "audit-ledger",
        status: auditBaseline?.ok ? "ok" : "warning",
        detail: `表 ${(auditBaseline?.tables || []).filter((table: any) => table.exists).length}/${(auditBaseline?.tables || []).length || 4} · DLQ ${auditBaseline?.dlq?.eventCount ?? 0}`,
      });
      pushCheck({
        key: "channels.status",
        group: "channels",
        label: "频道连接",
        provider: "channels",
        status: channels.length === 0
          ? "disabled"
          : channels.some((channel) => channel.ok)
            ? channels.some((channel) => channel.warn) ? "warning" : "ok"
            : "warning",
        detail: channels.length === 0
          ? "暂无运行中的频道状态输出"
          : `${channels.filter((channel) => channel.ok).length}/${channels.length} 运行`,
      });
      const summary = {
        ok: checks.every((check) => check.status === "ok" || check.status === "disabled"),
        error: checks.filter((check) => check.status === "error").length,
        warning: checks.filter((check) => check.status === "warning").length,
        disabled: checks.filter((check) => check.status === "disabled").length,
      };

      return redactHealthValue({
        checkedAt,
        summary,
        checks,
        runtimes: {
          primary: jiuwenActive > 0 ? "jiuwenswarm" : openclawActive > 0 ? "openclaw" : "none",
          jiuwenswarm: {
            enabled: jiuwenEnabled,
            active: jiuwenActive,
            home: JIUWENCLAW_HOME,
            serviceId: jiuwenClawServiceId(),
            globalSessions: jiuwenGlobalSessionCount,
            serviceAgents: jiuwenServiceAgentCount,
            serviceStatus: jiuwenService.output || "",
            recent: jiuwenRecentLog,
          },
          openclaw: {
            enabled: openclawEnabled,
            active: openclawActive,
          },
        },
        app: {
          name: appName,
          healthOk: health.ok,
          health: health.ok ? safeJson(health.output, { raw: health.output }) : null,
          pm2: app ? {
            name: app.name,
            status: app.pm2_env?.status,
            restarts: app.pm2_env?.restart_time,
            uptime: app.pm2_env?.pm_uptime,
            memory: app.monit?.memory,
            cpu: app.monit?.cpu,
          } : null,
          git: { branch: gitBranch.output || "", commit: gitCommit.output || "" },
          errors: [health.error, pm2.error].filter(Boolean),
        },
        openclaw: {
          reachable: Boolean(openclawJson?.gateway?.reachable),
          version: openclawJson?.runtimeVersion || "",
          cli: openclawCli.replace(/^'|'$/g, ""),
          gateway: openclawJson?.gateway || null,
          service: openclawJson?.gatewayService?.runtimeShort || openclawJson?.gatewayService || null,
          processCount: processLines.length,
          processes: processLines,
          errors: [openclawStatus.error, openclawProcesses.error].filter(Boolean),
        },
        channels: {
          ok: channelStatus.ok,
          lines: channels,
          raw: channelStatus.output,
          error: channelStatus.error || "",
        },
        models: {
          primary,
          available: availableModels,
          allowlist: availableModels.map((model) => model.id),
          agentModelDrift,
        },
        database: dbHealth,
        audit: auditBaseline,
      });
    }),

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

        adminListSharedSkills: adminProcedure.query(async () => {
      const sharedDir = openClawSharedSkillsDir();
      const { readdirSync, readFileSync, existsSync, statSync } = await import("fs");
      const skills: Array<{ id: string; name: string; description: string; hasScripts: boolean }> = [];
      try {
        const dirs = readdirSync(sharedDir).filter(d => statSync(`${sharedDir}/${d}`).isDirectory());
        for (const id of dirs) {
          let name = id;
          let description = "";
          let hasScripts = existsSync(`${sharedDir}/${id}/scripts`);
          try {
            const md = readFileSync(`${sharedDir}/${id}/SKILL.md`, "utf8");
            const fm = md.match(/^---\n([\s\S]*?)\n---/);
            if (fm) {
              const nameMatch = fm[1].match(/^name:\s*"?([^"\n]+)"?/m);
              const descMatch = fm[1].match(/^description:\s*"?([^"\n]+)"?/m);
              if (nameMatch) name = nameMatch[1].trim();
              if (descMatch) description = descMatch[1].trim().slice(0, 200);
            }
          } catch {}
          skills.push({ id, name, description, hasScripts });
        }
      } catch {}
      return skills;
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
            preferRuntime: z.enum(["jiuwenswarm", "openclaw"]).optional(),
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
        if (provisionPlan.runtime === "jiuwenswarm" && !isJiuwenSwarmProvisionEnabled()) {
          throw new Error("JiuwenSwarm 当前未配置。请先安装并启用 JiuwenSwarm runtime，再创建岗位智能体。");
        }
        if (preferRuntime && provisionPlan.runtime !== preferRuntime) {
          throw new Error(
            preferRuntime === "jiuwenswarm"
              ? "JiuwenSwarm 当前不可用，请稍后重试"
              : "OpenClaw 当前不可用，请稍后重试",
          );
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
        const adoptId = provisionPlan.runtime === "jiuwenswarm" ? `lgj-${suffix}` : `lgc-${suffix}`;
        const agentId = provisionPlan.runtime === "jiuwenswarm" ? `jiuwen_${adoptId}` : `trial_${adoptId}`;
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
            console.warn("[SKILL-ONBOARD] failed", {
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
        const startedAt = Date.now();
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);

        // ── 每日对话额度检查 ──
        const profile = String(claw.permissionProfile || "starter");
        if (profile === "starter") {
          const dailyLimit = Number(process.env.CLAW_STARTER_DAILY_LIMIT || 50);
          const count = clawDailyUsage.increment(input.adoptId);
          if (count > dailyLimit) {
            throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `今日对话已达上限（${dailyLimit}轮），请联系管理员调整角色或配额` });
          }
        }

        // ── touch 活跃时间（best-effort）──
        touchClawActivity(input.adoptId);

        const chatMode = (process.env.CLAW_CHAT_MODE || "mock").trim();

        if (chatMode === "local-openclaw" || chatMode === "remote-openclaw") {
          const openclawHome = process.env.CLAW_OPENCLAW_HOME || process.env.OPENCLAW_HOME || "";
          const remoteOpenclawHome = OPENCLAW_HOME;
          const timeoutSec = Number(process.env.CLAW_CHAT_TIMEOUT_SECONDS || 90);
          // 安全转义：清理 shell 特殊字符，防止命令注入
          const escapedMsg = input.message
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/`/g, "\\`")
            .replace(/\$/g, "\\$")
            .replace(/\r/g, "")
            .slice(0, 4000)

          const remoteHost = process.env.CLAW_REMOTE_HOST || "";
          const remoteUser = process.env.CLAW_REMOTE_USER || "root";
          const useRemote = chatMode === "remote-openclaw" || !!remoteHost;
          const runtimeAgentIdForGuard = String((claw as any).agentId || "");
          const coreFileSnapshot = snapshotProtectedCoreFiles(openClawWorkspaceDir(runtimeAgentIdForGuard));
          const restoreCoreFiles = (phase: string) => {
            restoreDeletedProtectedCoreFiles(coreFileSnapshot, {
              adoptId: input.adoptId,
              agentId: runtimeAgentIdForGuard,
              phase,
            });
          };

          const runAgentOnce = () => {
            if (useRemote) {
              if (!remoteHost) {
                throw new Error("remote-openclaw mode requires CLAW_REMOTE_HOST");
              }
              const remoteCmd = [
                `OPENCLAW_HOME=\"${remoteOpenclawHome}\"`,
                "openclaw agent",
                `--agent \"${claw.agentId}\"`,
                `--message \"${escapedMsg}\"`,
                "--thinking off",
                "--json",
                `--timeout ${timeoutSec}`,
              ].join(" ");

              return runRemoteShellCommand(remoteUser, remoteHost, remoteCmd, (timeoutSec + 10) * 1000);
            }

            const cmd = [
              openclawHome ? `OPENCLAW_HOME=\"${openclawHome}\"` : "",
              "openclaw agent",
              `--agent \"${claw.agentId}\"`,
              `--message \"${escapedMsg}\"`,
              "--json",
              `--timeout ${timeoutSec}`,
            ]
              .filter(Boolean)
              .join(" ");

            return execSync(cmd, {
              cwd: process.cwd(),
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf8",
            }).trim();
          };

          try {
            let out = "";
            try {
              out = runAgentOnce();
            } catch (firstErr: any) {
              const firstMsg = firstErr?.stderr?.toString?.() || firstErr?.message || String(firstErr);
              if (String(firstMsg).includes("Unknown agent id")) {
                // 懒创建：老记录可能是 mock 阶段生成，首次聊天时补建 agent
                if (useRemote) {
                  const addCmd = [
                    `OPENCLAW_HOME=\"${remoteOpenclawHome}\"`,
                    "openclaw agents add",
                    `\"${claw.agentId}\"`,
                    `--workspace \"${OPENCLAW_HOME}/workspace-lingganclaw/${claw.agentId}\"`,
                    "--non-interactive",
                  ].join(" ");
                  execRemoteShellCommand(remoteUser, remoteHost, addCmd, 10000);
                } else {
                  provisionEmployeeAgentInstance({
                    adoptId: input.adoptId,
                    agentId: claw.agentId,
                    userId: Number(claw.userId),
                    permissionProfile: (claw.permissionProfile as any) || "starter",
                    ttlDays: Number(claw.ttlDays || 7),
                  });
                }
                out = runAgentOnce();
              } else {
                throw firstErr;
              }
            }
            restoreCoreFiles("trpc_chat_done");

            let parsed: any = null;
            try {
              parsed = out ? JSON.parse(out) : null;
            } catch {
              parsed = { raw: out };
            }

            const reply =
              parsed?.result?.payloads?.[0]?.text ||
              parsed?.result?.payload?.text ||
              parsed?.response?.text ||
              parsed?.response ||
              parsed?.reply ||
              parsed?.text ||
              parsed?.raw ||
              "（已调用 OpenClaw，但未解析到回复文本）";

            writeClawExecAudit({
              adoptId: input.adoptId,
              agentId: String((claw as any).agentId || ""),
              userId: Number((claw as any).userId || 0),
              permissionProfile: String((claw as any).permissionProfile || "starter"),
              message: input.message,
              ok: true,
              durationMs: Date.now() - startedAt,
              meta: parsed?.meta || null,
            });

            return {
              ok: true,
              adoptId: input.adoptId,
              reply: String(reply),
              ts: Date.now(),
              mode: chatMode,
            };
          } catch (error: any) {
            restoreCoreFiles("trpc_chat_error");
            const msg = error?.stderr?.toString?.() || error?.message || String(error);
            writeClawExecAudit({
              adoptId: input.adoptId,
              agentId: String((claw as any).agentId || ""),
              userId: Number((claw as any).userId || 0),
              permissionProfile: String((claw as any).permissionProfile || "starter"),
              message: input.message,
              ok: false,
              durationMs: Date.now() - startedAt,
              error: msg,
            });
            throw new Error(`岗位智能体对话引擎调用失败：${msg}`);
          }
        }

        // 默认 mock
        const reply = `岗位智能体已收到：${input.message}\n\n（对话引擎接入中，下一步将切到真实 OpenClaw 会话）`;
        return {
          ok: true,
          adoptId: input.adoptId,
          reply,
          ts: Date.now(),
          mode: "mock",
        };
      }),

    // ── 技能管理 ──────────────────────────────────────────────
    // ── 技能管理（三层架构）────────────────────────────────────
    // Layer1: openclaw 系统内置  /usr/lib/node_modules/openclaw/skills/
    // Layer2: 灵感公共金融技能  /root/.openclaw/skills-shared/
    // Layer3: 智能体私有技能      /root/.openclaw/workspace-lingganclaw/{agentId}/skills/
    listSkills: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64) }))
      .query(async ({ input, ctx }) => {
        const claw = await assertClawOwnerOrThrow(ctx, input.adoptId);

        if (isJiuwenClawAdoptId(input.adoptId)) {
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
          }));
          return {
            shared: [],
            system: [],
            private: privateSkills,
            privateNotInstalled: [],
            summary: {
              discovered: privateSkills.length,
              runnable: privateSkills.filter((s) => s.runnable).length,
            },
          };
        }

        if (String(input.adoptId).startsWith("lgh-")) {
          return { shared: [], system: [], private: [], privateNotInstalled: [], summary: { discovered: 0, runnable: 0 } };
        }

        const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
        const remoteUser = process.env.CLAW_REMOTE_USER || "root";
        const userSkillsDir = `${openClawWorkspaceDir(String(claw.agentId || ""))}/skills`;
        const sharedSkillsDir = openClawSharedSkillsDir();
        const systemSkillsDir = `/usr/lib/node_modules/openclaw/skills`;
        const useRemote = !!remoteHost && remoteHost !== "127.0.0.1";

        const runRemote = (cmd: string) => {
          if (useRemote) {
            return runRemoteShellCommand(remoteUser, remoteHost, cmd, 8000);
          }
          return execSync(cmd, { encoding: "utf8", stdio: ["ignore","pipe","pipe"] }).trim();
        };

        const SHARED_META: Record<string, { label: string; desc: string; emoji: string }> = {};

        const SYSTEM_META: Record<string, { label: string; desc: string; emoji: string }> = {
          // 办公效率
          "docx":             { label: "Word 文档", desc: "创建、读取、编辑 Word 文档", emoji: "📄" },
          "xlsx":             { label: "Excel 表格", desc: "电子表格与数据分析", emoji: "📊" },
          "pdf":              { label: "PDF 处理", desc: "读取、创建、合并 PDF", emoji: "📑" },
          "pptx-doc":         { label: "PPT 演示", desc: "创建与编辑演示文稿", emoji: "📽" },
          "internal-comms":   { label: "公文写作", desc: "通知、纪要、周报模板", emoji: "📋" },
          // 金融分析
          "stock-query":      { label: "股票行情", desc: "A股/港股/美股实时行情", emoji: "📈" },
          "finance-news":     { label: "金融资讯", desc: "市场动态与宏观政策", emoji: "📰" },
          "research-report":  { label: "研报解读", desc: "研究报告与财务数据", emoji: "🔬" },
          "quant-lite":       { label: "量化工具", desc: "技术指标与趋势判断", emoji: "📉" },
          // 工具
          "skill-creator":    { label: "技能工坊", desc: "设计与创建新技能", emoji: "🛠" },
          "weather":          { label: "天气查询", desc: "查询城市实时天气", emoji: "🌤" },
        };

        const lsLines = (cmd: string) => {
          try {
            const out = runRemote(cmd);
            return out ? out.split("\n").map(s => s.trim()).filter(Boolean) : [];
          } catch {
            return [];
          }
        };

        // discovery: system/shared/private 三层统一发现
        const systemIds = lsLines(`ls ${systemSkillsDir} 2>/dev/null || echo ""`);
        const sharedIds = lsLines(`ls ${sharedSkillsDir} 2>/dev/null || echo ""`);
        const privateIdsRaw = lsLines(`cd ${userSkillsDir} 2>/dev/null && find . -maxdepth 1 -not -type l -mindepth 1 -printf '%f\n' | sort || echo ""`);
        const activeSkills = lsLines(`ls ${userSkillsDir} 2>/dev/null || echo ""`);

        const privateIds = privateIdsRaw.filter(id => !sharedIds.includes(id) && !systemIds.includes(id));

        // only show skills defined in SYSTEM_META (deps satisfied on this host)
        const system = systemIds.filter(id => id in SYSTEM_META).map((id) => {
          const active = activeSkills.includes(id);
          return {
            id,
            label: SYSTEM_META[id]?.label || id,
            desc: SYSTEM_META[id]?.desc || "系统技能",
            emoji: SYSTEM_META[id]?.emoji || "🧩",
            source: "system" as const,
            scope: "system" as const,
            sourcePath: `${systemSkillsDir}/${id}`,
            visible: true,
            runnable: active,
            reason: active ? "" : "not_mounted",
            active,
          };
        });

        const shared = sharedIds.map((id) => {
          const active = activeSkills.includes(id);
          return {
            id,
            label: SHARED_META[id]?.label || id,
            desc: SHARED_META[id]?.desc || "公共金融技能",
            emoji: SHARED_META[id]?.emoji || "💹",
            source: "shared" as const,
            scope: "shared" as const,
            sourcePath: `${sharedSkillsDir}/${id}`,
            visible: true,
            runnable: active,
            reason: active ? "" : "not_mounted",
            active,
          };
        });

        const privateSkills = privateIds.map((id) => ({
          id,
          label: id,
          desc: "自定义技能",
          emoji: "⚡",
          source: "private" as const,
          scope: "private" as const,
          sourcePath: `${userSkillsDir}/${id}`,
          ownerAgentId: String(claw.agentId || ""),
          visible: true,
          runnable: true,
          reason: "",
          active: true,
        }));

        return {
          system,
          shared,
          private: privateSkills,
          summary: {
            discovered: system.length + shared.length + privateSkills.length,
            runnable: system.filter(s => s.runnable).length + shared.filter(s => s.runnable).length + privateSkills.filter(s => s.runnable).length,
          },
        };
      }),

    toggleSkill: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        skillId: skillIdSchema,
        enable: z.boolean(),
        source: z.enum(["system", "shared"]),  // 只有 system/shared 需要 toggle；private 永远激活
      }))
      .mutation(async ({ input, ctx }) => {
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw) throw new Error("智能体实例不存在");
        if (String(claw.userId) !== String(ctx.user!.id)) throw new Error("无权操作");

        const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
        const remoteUser = process.env.CLAW_REMOTE_USER || "root";
        const useRemote = !!remoteHost && remoteHost !== "127.0.0.1";

        // 与个人技能链路对齐：运行时优先 trial_{adoptId}
        const trialAgentId = `trial_${input.adoptId}`;
        const trialAgentDir = `${OPENCLAW_HOME}/agents/${trialAgentId}`;
        const runtimeAgentId = existsSync(trialAgentDir) ? trialAgentId : String(claw.agentId || "");

        const userSkillsBase = path.resolve(openClawWorkspaceDir(runtimeAgentId), "skills");
        const userSkillLink = safeChildPath(userSkillsBase, input.skillId);
        // 源目录：system 来自 openclaw 内置，shared 来自公共库
        const srcDir = input.source === "system"
          ? path.resolve("/usr/lib/node_modules/openclaw/skills", input.skillId)
          : safeChildPath(openClawSharedSkillsDir(), input.skillId);
        if (input.enable) {
          // 使用软链接指向共享源目录，改技能时智能体自动获得最新版本，无需重新 toggle
          if (useRemote) {
            execRemoteShellCommand(
              remoteUser,
              remoteHost,
              [
                `mkdir -p ${shellQuote(userSkillsBase)}`,
                `rm -rf ${shellQuote(userSkillLink)} 2>/dev/null || true`,
                `ln -sfn ${shellQuote(srcDir)} ${shellQuote(userSkillLink)}`,
              ].join(" && "),
              8000
            );
          } else {
            mkdirSync(userSkillsBase, { recursive: true });
            const baseReal = realpathSync(userSkillsBase);
            const linkParentReal = realpathSync(path.dirname(userSkillLink));
            if (linkParentReal !== baseReal) throw new Error("路径越权");
            rmSync(userSkillLink, { recursive: true, force: true });
            symlinkSync(srcDir, userSkillLink, "dir");
          }
        } else {
          // 删除软链接（不影响源目录）
          if (useRemote) {
            execRemoteShellCommand(remoteUser, remoteHost, `rm -f ${shellQuote(userSkillLink)} 2>/dev/null || true`, 8000);
          } else {
            const baseReal = existsSync(userSkillsBase) ? realpathSync(userSkillsBase) : path.resolve(userSkillsBase);
            const linkParentReal = existsSync(path.dirname(userSkillLink)) ? realpathSync(path.dirname(userSkillLink)) : path.resolve(path.dirname(userSkillLink));
            if (linkParentReal !== baseReal) throw new Error("路径越权");
            if (existsSync(userSkillLink)) {
              const stat = lstatSync(userSkillLink);
              if (stat.isSymbolicLink()) rmSync(userSkillLink, { force: true });
              else throw new Error("只能移除技能软链接");
            }
          }
        }

        // 与个人技能安装链路对齐：技能变更后 bump epoch，触发聊天使用新技能快照
        bumpClawSessionEpochBestEffort(String(input.adoptId));

        await recordAuditBestEffort({
          action: input.enable ? "skill.enabled" : "skill.disabled",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "skill",
          targetId: input.skillId,
          resourceType: "agent",
          resourceId: input.adoptId,
          agentInstanceId: input.adoptId,
          runtimeType: resolveClawRuntime(input.adoptId),
          runtimeAgentId,
          metadata: { source: input.source },
        });

        return { ok: true, skillId: input.skillId, enabled: input.enable };
      }),

    // 上传/创建私有技能
    upsertPrivateSkill: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        skillId: skillIdSchema,
        skillMd: z.string().min(10).max(50000),  // SKILL.md 内容
      }))
      .mutation(async ({ input, ctx }) => {
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw) throw new Error("智能体实例不存在");
        if (String(claw.userId) !== String(ctx.user!.id)) throw new Error("无权操作");

        const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
        const remoteUser = process.env.CLAW_REMOTE_USER || "root";
        const useRemote = !!remoteHost && remoteHost !== "127.0.0.1";

        const skillDir = `${openClawWorkspaceDir(String(claw.agentId || ""))}/skills/${input.skillId}`;

        if (useRemote) {
          const encoded = Buffer.from(input.skillMd, "utf8").toString("base64");
          const cmd = `mkdir -p ${shellQuote(skillDir)} && printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(`${skillDir}/SKILL.md`)}`;
          execRemoteShellCommand(remoteUser, remoteHost, cmd, 8000);
        } else {
          const fs = await import("fs");
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(`${skillDir}/SKILL.md`, input.skillMd, "utf8");
        }
        await recordAuditBestEffort({
          action: "skill.private.upserted",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "skill",
          targetId: input.skillId,
          resourceType: "agent",
          resourceId: input.adoptId,
          agentInstanceId: input.adoptId,
          runtimeType: resolveClawRuntime(input.adoptId),
          runtimeAgentId: String(claw.agentId || ""),
          metadata: {
            skillMdBytes: Buffer.byteLength(input.skillMd, "utf8"),
          },
        });
        return { ok: true, skillId: input.skillId };
      }),

    // 删除私有技能
    deletePrivateSkill: protectedProcedure
      .input(z.object({
        adoptId: z.string().min(1).max(64),
        skillId: skillIdSchema,
      }))
      .mutation(async ({ input, ctx }) => {
        const claw = await getClawByAdoptId(input.adoptId);
        if (!claw) throw new Error("智能体实例不存在");
        if (String(claw.userId) !== String(ctx.user!.id)) throw new Error("无权操作");

        const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
        const remoteUser = process.env.CLAW_REMOTE_USER || "root";
        const useRemote = !!remoteHost && remoteHost !== "127.0.0.1";

        const skillsBase = path.resolve(openClawWorkspaceDir(String(claw.agentId || "")), "skills");
        const skillDir = safeChildPath(skillsBase, input.skillId);
        if (useRemote) {
          execRemoteShellCommand(remoteUser, remoteHost, `rm -rf ${shellQuote(skillDir)} 2>/dev/null || true`, 8000);
        } else {
          const baseReal = existsSync(skillsBase) ? realpathSync(skillsBase) : path.resolve(skillsBase);
          const parentReal = existsSync(path.dirname(skillDir)) ? realpathSync(path.dirname(skillDir)) : path.resolve(path.dirname(skillDir));
          if (parentReal !== baseReal) throw new Error("路径越权");
          rmSync(skillDir, { recursive: true, force: true });
        }
        await recordAuditBestEffort({
          action: "skill.private.deleted",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "skill",
          targetId: input.skillId,
          resourceType: "agent",
          resourceId: input.adoptId,
          agentInstanceId: input.adoptId,
          runtimeType: resolveClawRuntime(input.adoptId),
          runtimeAgentId: String(claw.agentId || ""),
        });
        return { ok: true };
      }),

    // getMemory / updateMemory tRPC 端点已删除 (2026-04-20 review)
    // 前端改用 REST /api/claw/core-files/* + /api/claw/memory/* (已分叉 lgh-/lgc-)

    // ── 会话历史（localStorage 为主，DB 备用）─────────────────
    // 前端用 localStorage，此接口供未来 DB 持久化预留
    getMessages: protectedProcedure
      .input(z.object({ adoptId: z.string().min(1).max(64), limit: z.number().min(1).max(200).default(50) }))
      .query(async ({ input, ctx }) => {
        await assertClawOwnerOrThrow(ctx, input.adoptId);
        // 暂时返回空，前端用 localStorage
        return { messages: [] as Array<{ role: string; text: string; ts: number }> };
      }),

    // ── Day 4: TIL 审计面板 API (管理员) ─────────────────────────────
    adminTenantAuditList: adminProcedure
      .input(z.object({
        userId: z.number().int().positive().optional(),
        agentId: z.string().max(64).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional().default(100),
      }).optional())
      .query(async ({ input }) => {
        const rows = await listBusinessAgentAudit({
          userId: input?.userId,
          agentId: input?.agentId,
          fromIso: input?.from,
          toIso: input?.to,
          limit: input?.limit,
        });
        return { rows, count: rows.length };
      }),

    adminTenantAuditReverse: adminProcedure
      .input(z.object({ tenantToken: z.string().min(1).max(64) }))
      .query(async ({ input }) => {
        return await reverseTenantToken(input.tenantToken);
      }),

    adminTenantAuditStats: adminProcedure
      .query(async () => {
        return await getTenantAuditStats();
      }),

});
