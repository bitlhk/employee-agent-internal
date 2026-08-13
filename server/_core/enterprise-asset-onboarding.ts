import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const enterpriseAssetTypeSchema = z.enum([
  "knowledge_document",
  "business_data",
  "policy",
  "skill",
  "mcp_capability",
  "role_identity",
]);

export const enterpriseAssetMetadataSchema = z.object({
  ownerDepartment: z.string().min(1).max(200),
  classification: z.enum(["public", "internal", "sensitive", "restricted"]),
  applicableRoles: z.array(z.string().min(1).max(64)).min(1).max(64),
  applicableOrganizations: z.array(z.string().min(1).max(128)).max(128).default([]),
  lifecycle: z.enum(["draft", "active", "expired", "archived"]),
  authority: z.enum(["official", "approved", "reference", "personal"]).default("reference"),
  effectiveAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  documentSeriesId: z.string().min(1).max(128).nullable().optional(),
  supersedes: z.string().min(1).max(128).nullable().optional(),
  externalProcessingAllowed: z.boolean().default(false),
  relatedTasks: z.array(z.string().min(1).max(64)).max(64).default([]),
  policyCandidates: z.array(z.string().min(1).max(128)).max(64).default([]),
}).superRefine((value, ctx) => {
  if (value.effectiveAt && value.expiresAt && Date.parse(value.effectiveAt) >= Date.parse(value.expiresAt)) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "失效时间必须晚于生效时间" });
  }
});

export const enterpriseAssetManifestSchema = z.object({
  schemaVersion: z.literal("linggan.enterprise-asset/v1"),
  enterpriseId: z.string().min(1).max(128),
  assets: z.array(z.object({
    assetId: z.string().min(3).max(128).regex(/^[a-zA-Z0-9._-]+$/),
    name: z.string().min(1).max(240),
    assetType: enterpriseAssetTypeSchema,
    sourceUri: z.string().max(1000).nullable().optional(),
    file: z.string().max(700).nullable().optional(),
    versionLabel: z.string().min(1).max(64).default("1.0"),
    checksum: z.string().regex(/^[a-fA-F0-9]{64}$/),
    metadata: enterpriseAssetMetadataSchema,
  })).min(1).max(100),
});

export type EnterpriseAssetMetadata = z.infer<typeof enterpriseAssetMetadataSchema>;
export type EnterpriseAssetManifest = z.infer<typeof enterpriseAssetManifestSchema>;

export function parseEnterpriseAssetManifest(input: unknown): EnterpriseAssetManifest {
  return enterpriseAssetManifestSchema.parse(input);
}

export function newEnterpriseAssetCandidateId(): string {
  return `eac_${randomUUID().replace(/-/g, "")}`;
}

const ROLE_PACK_BY_ROLE: Record<string, string> = {
  "wealth-manager": "linggan-bank.wealth-manager",
  "insurance-advisor": "linggan-insurance.insurance-advisor",
};

export function analyzeEnterpriseAssetImpact(input: {
  assetType: z.infer<typeof enterpriseAssetTypeSchema>;
  enterpriseAssetId: string;
  sourceVersion: string;
  checksum: string;
  metadata: EnterpriseAssetMetadata;
}) {
  const rolePackIds = [...new Set(input.metadata.applicableRoles.map(role => ROLE_PACK_BY_ROLE[role]).filter(Boolean))];
  const reasons = [
    ...input.metadata.relatedTasks.map(taskId => `标杆任务 ${taskId} 需要重跑`),
    ...input.metadata.policyCandidates.map(policy => `策略候选 ${policy} 需要复核`),
  ];
  if (input.assetType === "knowledge_document") reasons.push("知识版本或内容变化会使既有引用证据失效");
  if (input.assetType === "mcp_capability" || input.assetType === "business_data") reasons.push("业务数据或能力契约变化需要重新验证 Readiness");
  if (input.assetType === "skill") reasons.push("Skill 变化需要重新运行任务级回归");
  return {
    enterpriseAssetId: input.enterpriseAssetId,
    sourceVersion: input.sourceVersion,
    checksum: input.checksum.toLowerCase(),
    affectedRoles: input.metadata.applicableRoles,
    affectedOrganizations: input.metadata.applicableOrganizations,
    affectedTaskIds: input.metadata.relatedTasks,
    affectedPolicyCandidates: input.metadata.policyCandidates,
    affectedRolePackIds: rolePackIds,
    requiresGoldenTaskRerun: input.metadata.relatedTasks.length > 0 || rolePackIds.length > 0,
    reasons,
    fingerprint: createHash("sha256").update(JSON.stringify({
      assetType: input.assetType,
      enterpriseAssetId: input.enterpriseAssetId,
      sourceVersion: input.sourceVersion,
      checksum: input.checksum.toLowerCase(),
      roles: [...input.metadata.applicableRoles].sort(),
      organizations: [...input.metadata.applicableOrganizations].sort(),
      tasks: [...input.metadata.relatedTasks].sort(),
      policies: [...input.metadata.policyCandidates].sort(),
    })).digest("hex"),
  };
}

export function targetTypeForEnterpriseAsset(assetType: z.infer<typeof enterpriseAssetTypeSchema>) {
  return ({
    knowledge_document: "knowledge_document",
    business_data: "enterprise_mcp",
    policy: "policy",
    skill: "skill",
    mcp_capability: "enterprise_mcp",
    role_identity: "role",
  } as const)[assetType];
}
