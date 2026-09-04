import { existsSync } from "node:fs";
import path from "node:path";
import {
  getSkillIdentityBySkillId,
  listRoleAssetGrants,
  listSkillMarketItems,
  listSkillVersionsByIdentity,
} from "../db";
import { getAvailableJiuwenModels } from "./available-models";
import { JIUWEN_AUTO_MODEL_ID } from "./jiuwenswarm-model-admin";
import {
  listRepositorySkillCandidates,
} from "./skill-value-evaluation";
import {
  assessSkillValueEvaluationSupport,
  inspectCuratedSkillValueSuite,
  PRIORITY_SKILL_VALUE_EVALUATION_IDS,
} from "./skill-value-evaluation-support";
import {
  probeJiuwenSkillMcpReadiness,
  type SkillMcpReadiness,
} from "./skill-mcp-readiness";
import { listAgentRoleTemplates } from "./role-templates";
import { remapLegacySkillMarketPath } from "./skills/skill-store";
import { digestSkillSourceTree } from "./skills/skill-artifact-digest";

export async function resolveSkillValueRoleTemplate(skillId: string): Promise<string> {
  const validRoles = new Set(listAgentRoleTemplates().map(role => role.id));
  const grants = (await listRoleAssetGrants())
    .filter(grant =>
      grant.assetType === "skill"
      && grant.assetId === skillId
      && grant.enabled
      && grant.roleKey !== "*"
      && validRoles.has(grant.roleKey))
    .sort((left, right) => {
      if (left.grantMode !== right.grantMode) return left.grantMode === "default" ? -1 : 1;
      return left.roleKey.localeCompare(right.roleKey);
    });
  return grants[0]?.roleKey || "general-assistant";
}

function uncheckedReadiness(skillId: string, error: unknown): SkillMcpReadiness {
  return {
    skillId,
    status: "unchecked",
    canProceed: true,
    message: `运行环境暂未完成检查：${error instanceof Error ? error.message : String(error)}`.slice(0, 240),
    checkedAt: new Date().toISOString(),
    servers: [],
  };
}

export async function buildPrioritySkillValueEvaluationSupportCatalog(
  root = process.cwd(),
) {
  const [marketRows, models] = await Promise.all([
    listSkillMarketItems(),
    getAvailableJiuwenModels().catch(() => []),
  ]);
  const modelCount = models.filter(model => model.id !== JIUWEN_AUTO_MODEL_ID).length;

  return await Promise.all(PRIORITY_SKILL_VALUE_EVALUATION_IDS.map(async skillId => {
    const skillRows = marketRows.filter(row => String(row.skillId || "") === skillId);
    const marketItem = skillRows.find(row => row.status === "approved") || skillRows[0];
    const identity = await getSkillIdentityBySkillId(skillId);
    const storedVersions = identity
      ? (await listSkillVersionsByIdentity(identity.identityId))
        .filter(version => version.status === "approved")
      : [];
    const repositoryCandidate = listRepositorySkillCandidates(root, skillId)[0];
    const latestStored = storedVersions.find(version => version.versionId === identity?.latestApprovedVersionId)
      || storedVersions.sort((left, right) =>
        right.version.localeCompare(left.version, undefined, { numeric: true }))[0];
    const legacyPath = marketItem
      ? remapLegacySkillMarketPath(String(marketItem.packagePath || ""))
      : "";
    const legacyAvailable = Boolean(legacyPath && existsSync(path.join(legacyPath, "SKILL.md")));
    const target = latestStored
      ? {
          version: latestStored.version,
          artifactSha256: latestStored.artifactSha256,
          artifactAvailable: existsSync(path.join(latestStored.artifactPath, "SKILL.md")),
          source: "approved" as const,
        }
      : repositoryCandidate
        ? {
          version: repositoryCandidate.version,
          artifactSha256: repositoryCandidate.artifactSha256,
          artifactAvailable: existsSync(path.join(repositoryCandidate.artifactPath, "SKILL.md")),
          source: "candidate" as const,
        }
        : marketItem && legacyAvailable
          ? {
              version: String(marketItem.version || "1.0.0"),
              artifactSha256: digestSkillSourceTree(legacyPath).sha256,
              artifactAvailable: true,
              source: "approved" as const,
            }
          : null;
    const roleTemplate = await resolveSkillValueRoleTemplate(skillId);
    const readiness = await probeJiuwenSkillMcpReadiness({
      skillId,
      roleTemplate,
      allowPlannedEnterpriseRuntime: true,
    }).catch(error => uncheckedReadiness(skillId, error));
    const suite = inspectCuratedSkillValueSuite({
      root,
      skillId,
      version: target?.version || "",
      artifactSha256: target?.artifactSha256 || "",
    });

    return {
      skillId,
      name: String(marketItem?.name || skillId),
      version: target?.version || null,
      versionSource: target?.source || null,
      roleTemplate,
      requiredServerCount: readiness.servers.length,
      readiness,
      support: assessSkillValueEvaluationSupport({
        artifactAvailable: Boolean(target?.artifactAvailable),
        modelCount,
        suite,
        readiness,
      }),
    };
  }));
}
