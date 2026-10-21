import { existsSync } from "fs";
import { nanoid } from "nanoid";
import path from "path";
import { z } from "zod";
import { getAvailableJiuwenModels, type RuntimeModelOption } from "../_core/available-models";
import { JIUWEN_MODEL_PROVIDERS, JIUWEN_REASONING_LEVELS } from "../_core/jiuwenswarm-model-admin";
import { logDebug } from "../_core/observability/logger";
import { resolvePublicBaseUrl } from "../_core/public-base-url";
import { resolveActiveAgentRuntime } from "../_core/runtime-policy";
import { listRepositorySkillCandidates } from "../_core/skill-value-evaluation";
import { type SkillValueEvaluationArtifact } from "../_core/skill-value-evaluation-runner";
import { digestSkillSourceTree } from "../_core/skills/skill-artifact-digest";
import { remapLegacySkillMarketPath, skillStoreMarketplaceDir } from "../_core/skills/skill-store";
import { getSkillIdentityBySkillId, getSkillMarketItem, getSkillVersionById } from "../db";
import { APP_ROOT } from "./helpers";

export type ResolvedClawRuntime = "jiuwenclaw" | "legacy_archived" | "unsupported";

export const skillIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "技能ID只能包含小写字母、数字和连字符");

export const feedbackIdentitySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, "消息标识格式不正确");

export const feedbackToolSchema = z.object({
  name: z.string().trim().min(1).max(128),
  status: z.enum(["running", "done", "error"]),
  durationMs: z.number().int().nonnegative().max(3_600_000).optional(),
});

export const jiuwenModelDraftSchema = z.object({
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

export const eaAssistantModelDraftSchema = z.object({
  apiBase: z.string().trim().url().max(2048),
  modelName: z.string().trim().min(1).max(200),
  apiKey: z.string().max(8192).optional(),
  provider: z.enum(JIUWEN_MODEL_PROVIDERS).default("OpenAI"),
  timeoutMs: z.number().int().min(1000).max(120000).default(8000),
  disableThinking: z.boolean().default(true),
});

export function safeChildPath(parentDir: string, childName: string): string {
  const parent = path.resolve(parentDir);
  const child = path.resolve(parent, childName);
  if (child !== parent && child.startsWith(`${parent}${path.sep}`)) return child;
  throw new Error("路径越权");
}

export const resolveClawRuntime = (adoptId: unknown): ResolvedClawRuntime => {
  return resolveActiveAgentRuntime(adoptId);
};

export function buildClawEntryUrl(adoptId: string): string {
  return `${resolvePublicBaseUrl()}/claw/${encodeURIComponent(adoptId)}`;
}

export const randomRuntimeSuffix = () => nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);

export const iosLoadDebugEnabled = process.env.IOS_LOAD_DEBUG === "1";

export function logIosLoadDebug(message: string, fields: Record<string, unknown> = {}): void {
  if (!iosLoadDebugEnabled) return;
  logDebug(`ios.load.${message}`, fields);
}

export const getAvailableModelsForRuntime = async (adoptId?: unknown): Promise<RuntimeModelOption[]> => {
  if (!String(adoptId || "").trim()) return await getAvailableJiuwenModels();
  const runtime = resolveClawRuntime(adoptId);
  if (runtime === "jiuwenclaw") return await getAvailableJiuwenModels();
  return [];
};

export const skillMarketDir = () => skillStoreMarketplaceDir();

export async function resolveSkillValueArtifact(
  skillId: string,
  versionId: string,
): Promise<SkillValueEvaluationArtifact> {
  if (versionId === "without_target_skill") return null;
  if (versionId.startsWith("candidate_")) {
    const candidate = listRepositorySkillCandidates(APP_ROOT, skillId)
      .find(item => item.versionId === versionId);
    if (!candidate) throw new Error("所选候选版本不存在");
    return candidate;
  }
  if (versionId.startsWith("legacy-market-")) {
    const marketId = Number(versionId.slice("legacy-market-".length));
    const item = await getSkillMarketItem(marketId);
    if (!item || String(item.skillId || "") !== skillId) {
      throw new Error("所选 Skill 版本不存在");
    }
    const artifactPath = remapLegacySkillMarketPath(String(item.packagePath || ""));
    if (!artifactPath || !existsSync(artifactPath)) throw new Error("Skill Artifact 不存在");
    return {
      versionId,
      version: String(item.version || "1.0.0"),
      artifactSha256: digestSkillSourceTree(artifactPath).sha256,
      artifactPath,
    };
  }
  const identity = await getSkillIdentityBySkillId(skillId);
  const stored = await getSkillVersionById(versionId);
  if (
    !identity
    || !stored
    || stored.skillIdentityId !== identity.identityId
    || stored.status !== "approved"
  ) {
    throw new Error("所选 Skill 版本不可用于评测");
  }
  return {
    versionId: stored.versionId,
    version: stored.version,
    artifactSha256: stored.artifactSha256,
    artifactPath: stored.artifactPath,
  };
}
