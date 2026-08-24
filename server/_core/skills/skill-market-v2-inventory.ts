import semver from "semver";
import type { Skill } from "../../../shared/types/skill";

export type LegacySkillMarketRow = {
  id: number;
  skillId: string;
  authorUserId: number | null;
  version: string | null;
  status: "pending" | "approved" | "rejected" | "offline";
  origin: string;
  author: string | null;
  license: string | null;
  packagePath: string | null;
};

export type LegacyRoleSkillGrant = {
  roleKey: string;
  assetId: string;
  grantMode: "default" | "optional";
  source: "seed" | "admin" | "market";
  enabled: boolean;
};

export type LegacySkillMaintainerMembership = {
  userId: number;
  organizationId: string;
  status: "active" | "revoked";
};

export type LegacySkillAdoption = {
  adoptId: string;
  roleTemplate: string;
};

export type SkillArtifactObservation = {
  marketplaceRowId: number;
  exists: boolean;
  insideSkillStore: boolean;
  sourceTreeSha256?: string;
  sourceSkillId?: string;
  validSource?: boolean;
  error?: string;
};

export type SkillMarketInventoryIssueCode =
  | "SKILL_ID_MAINTAINER_CONFLICT"
  | "USER_MAINTAINER_ORGANIZATION_MISSING"
  | "USER_MAINTAINER_ORGANIZATION_AMBIGUOUS"
  | "SKILL_VERSION_INVALID"
  | "SKILL_VERSION_DUPLICATE"
  | "SKILL_PACKAGE_PATH_MISSING"
  | "SKILL_PACKAGE_NOT_FOUND"
  | "SKILL_PACKAGE_OUTSIDE_STORE"
  | "SKILL_PACKAGE_DIGEST_FAILED"
  | "SKILL_PACKAGE_VALIDATION_FAILED"
  | "SKILL_PACKAGE_ID_MISMATCH"
  | "SKILL_ARTIFACT_DUPLICATE"
  | "REGISTRY_MARKETPLACE_ROW_MISSING"
  | "REGISTRY_MARKETPLACE_ID_MISMATCH"
  | "ROLE_MARKET_GRANT_TARGET_MISSING"
  | "ROLE_OPTIONAL_GRANT_DEPRECATED"
  | "ROLE_SKILL_GRANT_CONFLICT";

export type SkillMarketInventoryIssue = {
  severity: "blocker" | "warning";
  code: SkillMarketInventoryIssueCode;
  skillId?: string;
  marketplaceRowIds?: number[];
  adoptId?: string;
  roleKey?: string;
  detail: string;
};

export type SkillMaintenanceMigrationDecision = {
  marketplaceRowId: number;
  skillId: string;
  proposedMaintainerType: "system" | "user";
  proposedMaintainerUserId: number | null;
  upstreamAuthor: string | null;
  upstreamLicense: string | null;
  sourceOrigin: string;
  basis: "legacy_author_user" | "centrally_imported";
};

export type SkillMarketV2InventoryReport = {
  schemaVersion: "ea.skill-market.inventory.v1";
  generatedAt: string;
  dryRun: true;
  summary: {
    marketplaceRows: number;
    distinctSkillIds: number;
    approvedRows: number;
    proposedSystemMaintainedRows: number;
    proposedUserMaintainedRows: number;
    marketplaceRegistryInstalls: number;
    activeRoleSkillGrants: number;
    roleDefaultRegistryOverlaps: number;
    autoMappableMarketplaceRows: number;
    manualResolutionMarketplaceRows: number;
    blockers: number;
    warnings: number;
  };
  maintenanceDecisions: SkillMaintenanceMigrationDecision[];
  issues: SkillMarketInventoryIssue[];
};

function normalized(value: unknown): string {
  return String(value ?? "").trim();
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const current = groups.get(groupKey) || [];
    current.push(value);
    groups.set(groupKey, current);
  }
  return groups;
}

export function buildSkillMarketV2Inventory(input: {
  marketplaceRows: LegacySkillMarketRow[];
  registrySkills: Skill[];
  roleSkillGrants: LegacyRoleSkillGrant[];
  maintainerMemberships: LegacySkillMaintainerMembership[];
  adoptions: LegacySkillAdoption[];
  artifacts: SkillArtifactObservation[];
  generatedAt?: string;
}): SkillMarketV2InventoryReport {
  const issues: SkillMarketInventoryIssue[] = [];
  const rowsBySkillId = groupBy(input.marketplaceRows, row =>
    normalized(row.skillId)
  );
  const rowById = new Map(input.marketplaceRows.map(row => [row.id, row]));
  const approvedSkillIds = new Set(
    input.marketplaceRows
      .filter(row => row.status === "approved")
      .map(row => normalized(row.skillId))
  );
  const membershipsByUser = groupBy(
    input.maintainerMemberships.filter(
      membership => membership.status === "active"
    ),
    membership => String(membership.userId)
  );
  const artifactsByRow = new Map(
    input.artifacts.map(artifact => [artifact.marketplaceRowId, artifact])
  );
  const manualRows = new Set<number>();

  for (const [skillId, rows] of rowsBySkillId) {
    const maintainers = new Set(
      rows
        .map(row => row.authorUserId)
        .filter((maintainer): maintainer is number =>
          Number.isInteger(maintainer)
        )
    );
    if (maintainers.size > 1) {
      rows.forEach(row => manualRows.add(row.id));
      issues.push({
        severity: "blocker",
        code: "SKILL_ID_MAINTAINER_CONFLICT",
        skillId,
        marketplaceRowIds: rows.map(row => row.id),
        detail:
          "the legacy skillId is associated with more than one user maintainer and cannot be migrated automatically",
      });
    }

    const versions = groupBy(rows, row => normalized(row.version));
    for (const [version, versionRows] of versions) {
      if (versionRows.length > 1) {
        versionRows.forEach(row => manualRows.add(row.id));
        issues.push({
          severity: "blocker",
          code: "SKILL_VERSION_DUPLICATE",
          skillId,
          marketplaceRowIds: versionRows.map(row => row.id),
          detail: `legacy records contain duplicate version ${version || "<empty>"}`,
        });
      }
    }
  }

  for (const row of input.marketplaceRows) {
    const skillId = normalized(row.skillId);
    const version = normalized(row.version);
    if (row.authorUserId) {
      const memberships = membershipsByUser.get(String(row.authorUserId)) || [];
      if (memberships.length === 0) {
        manualRows.add(row.id);
        issues.push({
          severity: "warning",
          code: "USER_MAINTAINER_ORGANIZATION_MISSING",
          skillId,
          marketplaceRowIds: [row.id],
          detail:
            "user maintainer has no active organization membership for organization-scoped catalog migration",
        });
      } else if (
        new Set(memberships.map(membership => membership.organizationId)).size >
        1
      ) {
        manualRows.add(row.id);
        issues.push({
          severity: "warning",
          code: "USER_MAINTAINER_ORGANIZATION_AMBIGUOUS",
          skillId,
          marketplaceRowIds: [row.id],
          detail:
            "user maintainer belongs to multiple active organizations; target catalog organization must be selected explicitly",
        });
      }
    }
    if (semver.valid(version) !== version || !/^\d+\.\d+\.\d+$/.test(version)) {
      manualRows.add(row.id);
      issues.push({
        severity: "blocker",
        code: "SKILL_VERSION_INVALID",
        skillId,
        marketplaceRowIds: [row.id],
        detail: `legacy version ${version || "<empty>"} is not strict MAJOR.MINOR.PATCH`,
      });
    }
    if (!normalized(row.packagePath)) {
      manualRows.add(row.id);
      issues.push({
        severity: "blocker",
        code: "SKILL_PACKAGE_PATH_MISSING",
        skillId,
        marketplaceRowIds: [row.id],
        detail: "legacy marketplace record has no package path",
      });
      continue;
    }
    const artifact = artifactsByRow.get(row.id);
    if (!artifact?.exists) {
      manualRows.add(row.id);
      issues.push({
        severity: "blocker",
        code: "SKILL_PACKAGE_NOT_FOUND",
        skillId,
        marketplaceRowIds: [row.id],
        detail: "legacy package path does not exist",
      });
    } else if (!artifact.insideSkillStore) {
      issues.push({
        severity: "warning",
        code: "SKILL_PACKAGE_OUTSIDE_STORE",
        skillId,
        marketplaceRowIds: [row.id],
        detail:
          "package is outside the canonical SKILL_STORE and must be copied into immutable artifact storage",
      });
    }
    if (artifact?.error || (artifact?.exists && !artifact.sourceTreeSha256)) {
      manualRows.add(row.id);
      issues.push({
        severity: "blocker",
        code: "SKILL_PACKAGE_DIGEST_FAILED",
        skillId,
        marketplaceRowIds: [row.id],
        detail: artifact?.error || "package digest could not be calculated",
      });
    }
    if (artifact?.exists && artifact.validSource === false) {
      manualRows.add(row.id);
      issues.push({
        severity: "blocker",
        code: "SKILL_PACKAGE_VALIDATION_FAILED",
        skillId,
        marketplaceRowIds: [row.id],
        detail:
          artifact.error ||
          "package does not satisfy the current Skill source contract",
      });
    } else if (artifact?.sourceSkillId && artifact.sourceSkillId !== skillId) {
      manualRows.add(row.id);
      issues.push({
        severity: "blocker",
        code: "SKILL_PACKAGE_ID_MISMATCH",
        skillId,
        marketplaceRowIds: [row.id],
        detail: `package declares ${artifact.sourceSkillId}; immutable identity requires ${skillId}`,
      });
    }
  }

  const digestGroups = groupBy(
    input.artifacts.filter(artifact => artifact.sourceTreeSha256),
    artifact => artifact.sourceTreeSha256 || ""
  );
  for (const artifacts of digestGroups.values()) {
    const skillIds = new Set(
      artifacts
        .map(artifact =>
          normalized(rowById.get(artifact.marketplaceRowId)?.skillId)
        )
        .filter(Boolean)
    );
    if (skillIds.size <= 1) continue;
    issues.push({
      severity: "warning",
      code: "SKILL_ARTIFACT_DUPLICATE",
      marketplaceRowIds: artifacts.map(artifact => artifact.marketplaceRowId),
      detail:
        "the same source-tree digest is used by multiple Skill identities; review as a possible duplicate without auto-merging",
    });
  }

  const marketplaceRegistrySkills = input.registrySkills.filter(
    skill => skill.source.kind === "marketplace"
  );
  for (const skill of marketplaceRegistrySkills) {
    const marketplaceId = Number.parseInt(
      normalized(skill.source.marketplaceId),
      10
    );
    const row = Number.isFinite(marketplaceId)
      ? rowById.get(marketplaceId)
      : undefined;
    if (!row) {
      issues.push({
        severity: "blocker",
        code: "REGISTRY_MARKETPLACE_ROW_MISSING",
        skillId: skill.source.skillId,
        adoptId: skill.adoptId,
        detail:
          "installed marketplace Skill does not reference an existing legacy marketplace row",
      });
      continue;
    }
    if (normalized(row.skillId) !== normalized(skill.source.skillId)) {
      issues.push({
        severity: "blocker",
        code: "REGISTRY_MARKETPLACE_ID_MISMATCH",
        skillId: skill.source.skillId,
        marketplaceRowIds: [row.id],
        adoptId: skill.adoptId,
        detail:
          "installed source skillId does not match the referenced legacy marketplace row",
      });
    }
  }

  const activeRoleSkillGrants = input.roleSkillGrants.filter(
    grant => grant.enabled
  );
  for (const grant of activeRoleSkillGrants) {
    if (grant.grantMode === "optional") {
      issues.push({
        severity: "warning",
        code: "ROLE_OPTIONAL_GRANT_DEPRECATED",
        skillId: grant.assetId,
        roleKey: grant.roleKey,
        detail:
          "job-role optional Skill grants are not an authorization boundary and will not migrate to V2",
      });
    }
    if (
      grant.source === "market" &&
      !approvedSkillIds.has(normalized(grant.assetId))
    ) {
      issues.push({
        severity: "warning",
        code: "ROLE_MARKET_GRANT_TARGET_MISSING",
        skillId: grant.assetId,
        roleKey: grant.roleKey,
        detail:
          "active market grant does not reference an approved marketplace Skill",
      });
    }
  }
  const grantsByRoleSkill = groupBy(
    activeRoleSkillGrants,
    grant => `${grant.roleKey}\u0000${grant.assetId}`
  );
  for (const grants of grantsByRoleSkill.values()) {
    if (new Set(grants.map(grant => grant.grantMode)).size <= 1) continue;
    issues.push({
      severity: "warning",
      code: "ROLE_SKILL_GRANT_CONFLICT",
      skillId: grants[0].assetId,
      roleKey: grants[0].roleKey,
      detail:
        "active legacy grants disagree on whether the Skill is default or optional",
    });
  }

  const adoptionRole = new Map(
    input.adoptions.map(adoption => [adoption.adoptId, adoption.roleTemplate])
  );
  const defaultGrantKeys = new Set(
    activeRoleSkillGrants
      .filter(grant => grant.grantMode === "default")
      .map(grant => `${grant.roleKey}\u0000${grant.assetId}`)
  );
  const roleDefaultRegistryOverlaps = input.registrySkills.filter(skill => {
    const roleKey = adoptionRole.get(skill.adoptId);
    return (
      skill.source.kind === "marketplace" &&
      Boolean(roleKey) &&
      defaultGrantKeys.has(`${roleKey}\u0000${skill.source.skillId}`)
    );
  }).length;
  const maintenanceDecisions: SkillMaintenanceMigrationDecision[] =
    input.marketplaceRows.map(row => ({
      marketplaceRowId: row.id,
      skillId: normalized(row.skillId),
      proposedMaintainerType: row.authorUserId ? "user" : "system",
      proposedMaintainerUserId: row.authorUserId || null,
      upstreamAuthor: normalized(row.author) || null,
      upstreamLicense: normalized(row.license) || null,
      sourceOrigin: normalized(row.origin),
      basis: row.authorUserId ? "legacy_author_user" : "centrally_imported",
    }));

  return {
    schemaVersion: "ea.skill-market.inventory.v1",
    generatedAt: input.generatedAt || new Date().toISOString(),
    dryRun: true,
    summary: {
      marketplaceRows: input.marketplaceRows.length,
      distinctSkillIds: rowsBySkillId.size,
      approvedRows: input.marketplaceRows.filter(
        row => row.status === "approved"
      ).length,
      proposedSystemMaintainedRows: maintenanceDecisions.filter(
        decision => decision.proposedMaintainerType === "system"
      ).length,
      proposedUserMaintainedRows: maintenanceDecisions.filter(
        decision => decision.proposedMaintainerType === "user"
      ).length,
      marketplaceRegistryInstalls: marketplaceRegistrySkills.length,
      activeRoleSkillGrants: activeRoleSkillGrants.length,
      roleDefaultRegistryOverlaps,
      autoMappableMarketplaceRows:
        input.marketplaceRows.length - manualRows.size,
      manualResolutionMarketplaceRows: manualRows.size,
      blockers: issues.filter(issue => issue.severity === "blocker").length,
      warnings: issues.filter(issue => issue.severity === "warning").length,
    },
    maintenanceDecisions,
    issues,
  };
}
