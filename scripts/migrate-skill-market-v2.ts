import "dotenv/config";

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import { and, desc, eq, or } from "drizzle-orm";
import {
  runtimeOrganizationMemberships,
  roleAssetGrants,
  agentSkillAssignments,
  agentSkillInstallations,
  clawAdoptions,
  skillIdentities,
  skillMarketplace,
  skillVersions,
  users,
} from "../drizzle/schema";
import {
  digestSkillSourceTree,
  materializeImmutableSkillArtifact,
} from "../server/_core/skills/skill-artifact";
import { resolveLegacyCanonicalSkillId } from "../shared/skill-market-v2";
import { normalizeLegacySkillVersion } from "../server/_core/skills/skill-market-v2-service";
import { parseSkillSourceDirectory } from "../server/_core/skills/skill-source";
import { remapLegacySkillMarketPath } from "../server/_core/skills/skill-store";
import { closeDbConnection, getDb } from "../server/db/connection";

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function legacyStatus(
  value: string
): "pending" | "approved" | "rejected" | "withdrawn" {
  if (value === "approved") return "approved";
  if (value === "rejected") return "rejected";
  if (value === "offline") return "withdrawn";
  return "pending";
}

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required");
  const [legacyRows, memberships, userRows, adminRows] = await Promise.all([
    db.select().from(skillMarketplace).orderBy(skillMarketplace.id),
    db
      .select()
      .from(runtimeOrganizationMemberships)
      .where(eq(runtimeOrganizationMemberships.status, "active")),
    db.select({ id: users.id, organization: users.organization }).from(users),
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .orderBy(users.id)
      .limit(1),
  ]);
  const fallbackAdminId = adminRows[0]?.id || userRows[0]?.id;
  if (!fallbackAdminId)
    throw new Error(
      "at least one user is required for legacy release provenance"
    );
  const usersById = new Map(userRows.map(row => [row.id, row]));
  const organizationsByUser = new Map<number, string>();
  for (const membership of memberships) {
    if (!organizationsByUser.has(membership.userId)) {
      organizationsByUser.set(membership.userId, membership.organizationId);
    }
  }
  const grouped = new Map<string, typeof legacyRows>();
  for (const row of legacyRows) {
    const current = grouped.get(row.skillId) || [];
    current.push(row);
    grouped.set(row.skillId, current);
  }

  const summary = {
    identitiesCreated: 0,
    versionsCreated: 0,
    installationsBackfilled: 0,
    canonicalSkillIdsNormalized: 0,
    skipped: 0,
    failed: 0,
  };
  for (const [legacySkillId, rows] of grouped) {
    const preferred = [...rows].sort((left, right) => {
      const rank = {
        approved: 0,
        pending: 1,
        offline: 2,
        rejected: 3,
      } as const;
      return rank[left.status] - rank[right.status] || right.id - left.id;
    });
    let skillId = legacySkillId;
    for (const row of preferred) {
      const sourcePath = remapLegacySkillMarketPath(
        String(row.packagePath || "")
      );
      if (!sourcePath || !existsSync(sourcePath)) continue;
      try {
        const parsed = parseSkillSourceDirectory(sourcePath, legacySkillId);
        const canonical = resolveLegacyCanonicalSkillId(
          legacySkillId,
          parsed.skillId
        );
        if (canonical) skillId = canonical;
        break;
      } catch {
        // Version import below records the actionable package error.
      }
    }
    if (skillId !== legacySkillId) {
      const conflicting = (
        await db
          .select()
          .from(skillMarketplace)
          .where(eq(skillMarketplace.skillId, skillId))
          .limit(1)
      )[0];
      if (conflicting && !rows.some(row => row.id === conflicting.id)) {
        throw new Error(
          `canonical skillId ${skillId} is already reserved by another marketplace row`
        );
      }
      await db
        .update(skillMarketplace)
        .set({ skillId })
        .where(eq(skillMarketplace.skillId, legacySkillId));
      await db
        .update(roleAssetGrants)
        .set({ assetId: skillId })
        .where(
          and(
            eq(roleAssetGrants.assetType, "skill"),
            eq(roleAssetGrants.assetId, legacySkillId)
          )
        );
      summary.canonicalSkillIdsNormalized++;
    }
    const maintainerIds = [
      ...new Set(
        rows
          .map(row => row.authorUserId)
          .filter((id): id is number => Boolean(id))
      ),
    ];
    const maintainerType =
      maintainerIds.length > 0 ? ("user" as const) : ("system" as const);
    const maintainerUserId =
      maintainerType === "user" ? maintainerIds[0] : null;
    const organizationId = maintainerUserId
      ? organizationsByUser.get(maintainerUserId) ||
        String(usersById.get(maintainerUserId)?.organization || "").trim() ||
        `legacy-user-${maintainerUserId}`
      : null;
    const identityId = stableId("skill", skillId);
    let identity = (
      await db
        .select()
        .from(skillIdentities)
        .where(
          or(
            eq(skillIdentities.skillId, skillId),
            eq(skillIdentities.skillId, legacySkillId)
          )
        )
        .limit(1)
    )[0];
    if (identity && identity.skillId !== skillId) {
      const versions = await db
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(eq(skillVersions.skillIdentityId, identity.identityId))
        .limit(1);
      if (versions.length > 0) {
        throw new Error(
          `cannot rename versioned Skill identity ${legacySkillId} to ${skillId}`
        );
      }
      await db
        .update(skillIdentities)
        .set({ skillId })
        .where(eq(skillIdentities.identityId, identity.identityId));
      identity = (
        await db
          .select()
          .from(skillIdentities)
          .where(eq(skillIdentities.identityId, identity.identityId))
          .limit(1)
      )[0];
    }
    if (!identity) {
      await db.insert(skillIdentities).values({
        identityId,
        skillId,
        maintainerType,
        maintainerUserId,
        organizationId,
        visibility: maintainerType === "system" ? "platform" : "organization",
        sourceOrigin: preferred[0]?.origin || "legacy",
        upstreamAuthor: preferred[0]?.author || null,
        upstreamLicense: preferred[0]?.license || null,
        displayName: preferred[0]?.name || skillId,
        description: preferred[0]?.description || null,
        category: preferred[0]?.category || "general",
        legacyPrimaryMarketId: preferred[0]?.id || null,
      });
      identity = (
        await db
          .select()
          .from(skillIdentities)
          .where(eq(skillIdentities.skillId, skillId))
          .limit(1)
      )[0];
      summary.identitiesCreated++;
    }

    const seenVersions = new Set<string>();
    const seenDigests = new Set<string>();
    for (const row of preferred) {
      const normalized = normalizeLegacySkillVersion(
        String(row.version || ""),
        row.id
      );
      if (seenVersions.has(normalized.version)) {
        summary.skipped++;
        continue;
      }
      const existingByMarket = (
        await db
          .select()
          .from(skillVersions)
          .where(eq(skillVersions.legacyMarketId, row.id))
          .limit(1)
      )[0];
      if (existingByMarket) {
        seenVersions.add(existingByMarket.version);
        seenDigests.add(existingByMarket.artifactSha256);
        summary.skipped++;
        continue;
      }
      const sourcePath = remapLegacySkillMarketPath(
        String(row.packagePath || "")
      );
      if (!sourcePath || !existsSync(sourcePath)) {
        console.warn(`[SKILL-MARKET-V2][SKIP] market=${row.id} source missing`);
        summary.failed++;
        continue;
      }
      try {
        const parsed = parseSkillSourceDirectory(sourcePath, skillId);
        if (parsed.skillId !== skillId) {
          console.warn(
            `[SKILL-MARKET-V2][SKIP] market=${row.id} package skillId ${parsed.skillId} does not match ${skillId}`
          );
          summary.failed++;
          continue;
        }
        const artifact = await materializeImmutableSkillArtifact({
          sourcePath,
          skillId,
          version: normalized.version,
        });
        if (seenDigests.has(artifact.sha256)) {
          summary.skipped++;
          continue;
        }
        const status = legacyStatus(row.status);
        const reviewed = status !== "pending";
        await db.insert(skillVersions).values({
          versionId: stableId(
            "skillver",
            `${identity.identityId}:${normalized.version}:${artifact.sha256}`
          ),
          skillIdentityId: identity.identityId,
          legacyMarketId: row.id,
          version: normalized.version,
          legacyOriginalVersion: normalized.originalVersion,
          artifactSha256: artifact.sha256,
          artifactSize: artifact.size,
          artifactPath: artifact.artifactPath,
          status,
          submittedBy: row.authorUserId || fallbackAdminId,
          submittedAt: row.createdAt,
          reviewedBy: reviewed ? fallbackAdminId : null,
          reviewedAt: reviewed ? row.updatedAt : null,
          reviewNote: row.reviewNote,
          scanPolicyFingerprint: fingerprint({
            policy: "ea.skill.legacy-import.v1",
          }),
          scanResultFingerprint: fingerprint({
            legacyMarketId: row.id,
            artifactSha256: artifact.sha256,
          }),
        });
        seenVersions.add(normalized.version);
        seenDigests.add(artifact.sha256);
        summary.versionsCreated++;
      } catch (error) {
        console.warn(
          `[SKILL-MARKET-V2][SKIP] market=${row.id} ${error instanceof Error ? error.message : String(error)}`
        );
        summary.failed++;
      }
    }

    const approved = await db
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillIdentityId, identity.identityId),
          eq(skillVersions.status, "approved")
        )
      )
      .orderBy(desc(skillVersions.submittedAt), desc(skillVersions.id));
    const latest = [...approved].sort((left, right) => {
      const leftValid = semver.valid(left.version);
      const rightValid = semver.valid(right.version);
      if (leftValid && rightValid)
        return semver.rcompare(left.version, right.version);
      return right.submittedAt.getTime() - left.submittedAt.getTime();
    })[0];
    if (latest && identity.latestApprovedVersionId !== latest.versionId) {
      await db
        .update(skillIdentities)
        .set({ latestApprovedVersionId: latest.versionId })
        .where(eq(skillIdentities.identityId, identity.identityId));
    }
  }

  const registryPath =
    process.env.SKILL_REGISTRY_PATH ||
    path.join(
      process.env.APP_ROOT || process.cwd(),
      "data",
      "skill-registry.json"
    );
  if (existsSync(registryPath)) {
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    const [identities, versions, adoptions] = await Promise.all([
      db.select().from(skillIdentities),
      db.select().from(skillVersions),
      db
        .select({
          adoptId: clawAdoptions.adoptId,
          userId: clawAdoptions.userId,
        })
        .from(clawAdoptions),
    ]);
    const identityBySkillId = new Map(
      identities.map(identity => [identity.skillId, identity])
    );
    const adoptionUser = new Map(
      adoptions.map(adoption => [adoption.adoptId, adoption.userId])
    );
    for (const item of registry) {
      const source =
        item.source && typeof item.source === "object"
          ? (item.source as Record<string, unknown>)
          : {};
      if (String(source.kind || "") !== "marketplace") continue;
      const adoptId = String(item.adoptId || "").trim();
      const skillId = String(item.id || source.skillId || "").trim();
      const identity = identityBySkillId.get(skillId);
      if (!adoptId || !identity) continue;
      const marketId = Number.parseInt(String(source.marketplaceId || ""), 10);
      const normalized = normalizeLegacySkillVersion(
        String(source.version || ""),
        marketId || 1
      ).version;
      let version = versions.find(
        candidate =>
          candidate.skillIdentityId === identity.identityId &&
          ((Number.isInteger(marketId) &&
            candidate.legacyMarketId === marketId) ||
            candidate.version === normalized)
      );
      if (!version && source.sourcePath) {
        const installedSourcePath = remapLegacySkillMarketPath(
          String(source.sourcePath)
        );
        if (existsSync(installedSourcePath)) {
          try {
            const installedDigest =
              digestSkillSourceTree(installedSourcePath).sha256;
            version = versions.find(
              candidate =>
                candidate.skillIdentityId === identity.identityId &&
                candidate.artifactSha256 === installedDigest
            );
          } catch {
            // Keep unverifiable legacy installations on the compatibility path.
          }
        }
      }
      if (!version) continue;
      const actorUserId = adoptionUser.get(adoptId) || fallbackAdminId;
      await db
        .insert(agentSkillInstallations)
        .values({
          adoptId,
          skillIdentityId: identity.identityId,
          activeVersionId: version.versionId,
          activeArtifactSha256: version.artifactSha256,
          installState: item.enabled === false ? "disabled" : "ready",
          enabled: item.enabled !== false,
          operationGeneration: 0,
          installedBy: actorUserId,
          installedAt: item.createdAt
            ? new Date(String(item.createdAt))
            : new Date(),
        })
        .onDuplicateKeyUpdate({
          set: {
            activeVersionId: version.versionId,
            activeArtifactSha256: version.artifactSha256,
            installState: item.enabled === false ? "disabled" : "ready",
            enabled: item.enabled !== false,
          },
        });
      await db
        .insert(agentSkillAssignments)
        .values({
          assignmentId: stableId(
            "skillassign",
            `${adoptId}:${identity.identityId}:personal`
          ),
          adoptId,
          skillIdentityId: identity.identityId,
          assignmentSource: "personal",
          assignmentRef: `user:${actorUserId}`,
          requestedVersionId: version.versionId,
          enabled: item.enabled !== false,
        })
        .onDuplicateKeyUpdate({
          set: {
            requestedVersionId: version.versionId,
            enabled: item.enabled !== false,
          },
        });
      summary.installationsBackfilled++;
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch(error => {
    console.error(
      `[SKILL-MARKET-V2-MIGRATE] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbConnection());
