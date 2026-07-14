import type { AgentRoleTemplate } from "./role-templates";

export type RoleAssetType = "skill" | "mcp_server";
export type RoleAssetGrantMode = "default" | "optional";
export type RoleAssetGrantSource = "seed" | "admin" | "market";

export type RoleAssetGrantRecord = {
  roleKey: string;
  assetType: RoleAssetType;
  assetId: string;
  grantMode: RoleAssetGrantMode;
  source: RoleAssetGrantSource;
  enabled: boolean;
};

export type RoleAssetGrantSeed = Omit<RoleAssetGrantRecord, "source" | "enabled"> & {
  source: "seed";
  enabled: true;
};

export type EffectiveRoleAssets = {
  skills: {
    default: string[];
    optional: string[];
  };
  mcpServers: {
    default: string[];
    optional: string[];
  };
};

export type RoleAssetSeedSyncPlan = {
  desired: RoleAssetGrantSeed[];
  upsert: RoleAssetGrantSeed[];
  prune: RoleAssetGrantRecord[];
  untouchedDynamic: RoleAssetGrantRecord[];
};

function normalizeUnique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).sort();
}

function grantKey(grant: Pick<RoleAssetGrantRecord, "roleKey" | "assetType" | "assetId" | "source">): string {
  return `${grant.roleKey}\0${grant.assetType}\0${grant.assetId}\0${grant.source}`;
}

export function buildSeedRoleAssetGrants(roles: AgentRoleTemplate[]): RoleAssetGrantSeed[] {
  const grants: RoleAssetGrantSeed[] = [];
  for (const role of roles) {
    for (const skillId of normalizeUnique(role.defaultSkills)) {
      grants.push({
        roleKey: role.id,
        assetType: "skill",
        assetId: skillId,
        grantMode: "default",
        source: "seed",
        enabled: true,
      });
    }
    for (const skillId of normalizeUnique(role.optionalSkills)) {
      grants.push({
        roleKey: role.id,
        assetType: "skill",
        assetId: skillId,
        grantMode: "optional",
        source: "seed",
        enabled: true,
      });
    }
    for (const mcpServer of normalizeUnique(role.mcpServers)) {
      grants.push({
        roleKey: role.id,
        assetType: "mcp_server",
        assetId: mcpServer,
        grantMode: "default",
        source: "seed",
        enabled: true,
      });
    }
  }
  const byKey = new Map<string, RoleAssetGrantSeed>();
  for (const grant of grants) byKey.set(grantKey(grant), grant);
  return Array.from(byKey.values()).sort((a, b) => grantKey(a).localeCompare(grantKey(b)));
}

export function planRoleAssetSeedSync(
  desiredSeed: RoleAssetGrantSeed[],
  existingGrants: RoleAssetGrantRecord[],
): RoleAssetSeedSyncPlan {
  const desiredByKey = new Map(desiredSeed.map((grant) => [grantKey(grant), grant]));
  const existingSeed = existingGrants.filter((grant) => grant.source === "seed");
  const existingSeedKeys = new Set(existingSeed.map(grantKey));

  return {
    desired: Array.from(desiredByKey.values()),
    upsert: Array.from(desiredByKey.entries())
      .filter(([key]) => !existingSeedKeys.has(key))
      .map(([, grant]) => grant),
    prune: existingSeed.filter((grant) => !desiredByKey.has(grantKey(grant))),
    untouchedDynamic: existingGrants.filter((grant) => grant.source !== "seed"),
  };
}

export function resolveEffectiveRoleAssetsFromGrants(
  roleKey: string,
  grants: RoleAssetGrantRecord[],
): EffectiveRoleAssets {
  const result: EffectiveRoleAssets = {
    skills: { default: [], optional: [] },
    mcpServers: { default: [], optional: [] },
  };
  const roleKeys = new Set([roleKey, "*"]);
  const seen = {
    skill: {
      default: new Set<string>(),
      optional: new Set<string>(),
    },
    mcp_server: {
      default: new Set<string>(),
      optional: new Set<string>(),
    },
  };

  for (const grant of grants) {
    if (!grant.enabled || !roleKeys.has(grant.roleKey)) continue;
    const assetId = String(grant.assetId || "").trim();
    if (!assetId) continue;
    const buckets = seen[grant.assetType];
    if (!buckets) continue;

    if (grant.grantMode === "default") {
      buckets.default.add(assetId);
      buckets.optional.delete(assetId);
    } else if (!buckets.default.has(assetId)) {
      buckets.optional.add(assetId);
    }
  }

  result.skills.default = Array.from(seen.skill.default).sort();
  result.skills.optional = Array.from(seen.skill.optional).sort();
  result.mcpServers.default = Array.from(seen.mcp_server.default).sort();
  result.mcpServers.optional = Array.from(seen.mcp_server.optional).sort();
  return result;
}

export function resolveEffectiveRoleAssetsFromBaseline(
  roleKey: string,
  roles: AgentRoleTemplate[],
  persistedGrants: RoleAssetGrantRecord[],
): EffectiveRoleAssets {
  const baselineGrants = buildSeedRoleAssetGrants(roles).filter((grant) => grant.roleKey === roleKey);
  const dynamicGrants = persistedGrants.filter((grant) => grant.source !== "seed");
  return resolveEffectiveRoleAssetsFromGrants(roleKey, [...baselineGrants, ...dynamicGrants]);
}
