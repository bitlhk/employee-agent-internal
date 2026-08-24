import { existsSync } from "node:fs";
import type { Express } from "express";
import {
  getSkillIdentityBySkillId,
  listApprovedSkillMarketItems,
  listSkillInvocationCounts,
  listSkillIdentitiesForMaintainer,
  listSkillMarketV2Projection,
  listSkillVersionsByIdentity,
  resolveSkillPublisherOrganization,
} from "../../../db";
import { requireClawOwner } from "../../helpers";
import { logError } from "../../observability/logger";
import { toPublicSkillMarketItem } from "../skill-market-policy";
import { skillInstaller } from "../skill-installer";
import { skillRegistry } from "../skill-registry";
import { publishSkillVersionFromSource } from "../skill-market-v2-service";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function registryErrorStatus(kind?: string): number {
  if (kind === "not_found") return 404;
  if (kind === "permission_denied") return 403;
  if (kind === "validation_failed") return 400;
  return 500;
}

export function registerSkillMarketRoutes(app: Express): void {
  app.get("/api/claw/skill-market/list", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const roleTemplate = String(claw.roleTemplate || "general-assistant");
      const rows = await listApprovedSkillMarketItems();
      const skillIds = rows.map((item) => String(item.skillId || "").trim());
      const [invocationCounts, projection] = await Promise.all([
        listSkillInvocationCounts(skillIds).catch(() => ({} as Record<string, number>)),
        listSkillMarketV2Projection(skillIds, adoptId).catch(() => ({ identities: [], versions: [], installations: [] })),
      ]);
      const identityBySkillId = new Map(projection.identities.map(identity => [identity.skillId, identity]));
      const versionsByIdentity = new Map<string, typeof projection.versions>();
      for (const version of projection.versions) {
        const current = versionsByIdentity.get(version.skillIdentityId) || [];
        current.push(version);
        versionsByIdentity.set(version.skillIdentityId, current);
      }
      const installationByIdentity = new Map(projection.installations.map(installation => [installation.skillIdentityId, installation]));
      const organizationId = await resolveSkillPublisherOrganization(Number(claw.userId || 0));
      res.json({
        items: rows.flatMap((item) => {
          const skillId = String(item.skillId || "").trim();
          const identity = identityBySkillId.get(skillId);
          if (
            identity?.visibility === "organization"
            && identity.organizationId !== organizationId
          ) return [];
          const versions = identity ? versionsByIdentity.get(identity.identityId) || [] : [];
          const latest = identity
            ? versions.find(version => version.versionId === identity.latestApprovedVersionId)
            : undefined;
          const installation = identity ? installationByIdentity.get(identity.identityId) : undefined;
          return [{
            ...toPublicSkillMarketItem({
              ...item,
              version: latest?.version || item.version,
            }),
            invocationCount: invocationCounts[skillId] || 0,
            identityId: identity?.identityId,
            maintainerType: identity?.maintainerType,
            versionId: latest?.versionId,
            artifactSha256: latest?.artifactSha256,
            installedVersionId: installation?.activeVersionId,
            installedVersion: versions.find(version => version.versionId === installation?.activeVersionId)?.version,
            versions: versions.map(version => ({
              versionId: version.versionId,
              version: version.version,
              artifactSha256: version.artifactSha256,
              submittedAt: version.submittedAt,
            })),
          }];
        }),
        roleTemplate,
        filtered: false,
      });
    } catch (error) {
      logError("skill_market.list_failed", error);
      res.status(500).json({ error: "list skill market failed" });
    }
  });

  app.get("/api/claw/skill-market/publications", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const userId = Number(claw.userId || 0);
      const identities = await listSkillIdentitiesForMaintainer(userId, false);
      const items = await Promise.all(identities.map(async identity => ({
        identityId: identity.identityId,
        skillId: identity.skillId,
        displayName: identity.displayName,
        maintainerType: identity.maintainerType,
        latestApprovedVersionId: identity.latestApprovedVersionId,
        versions: (await listSkillVersionsByIdentity(identity.identityId)).map(version => ({
          versionId: version.versionId,
          version: version.version,
          status: version.status,
          artifactSha256: version.artifactSha256,
          submittedAt: version.submittedAt,
          reviewNote: version.reviewNote,
        })),
      })));
      res.json({ items });
    } catch (error) {
      logError("skill_market.publications_failed", error);
      res.status(500).json({ error: "list Skill publications failed" });
    }
  });

  app.post("/api/claw/skill-market/submit", async (req, res) => {
    try {
      const body = record(req.body);
      const adoptId = String(body.adoptId || "").trim();
      const skillId = String(body.skillId || "").trim();
      const version = String(body.version || "1.0.0").trim().slice(0, 32) || "1.0.0";
      const selectedIdentityId = String(body.selectedIdentityId || "").trim();
      const changelog = String(body.changelog || "").trim().slice(0, 8_000);
      if (!adoptId || !skillId) {
        res.status(400).json({ error: "adoptId and skillId required" });
        return;
      }

      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const listed = await skillRegistry.listSkills(adoptId);
      if (!listed.ok) {
        res.status(registryErrorStatus(listed.error.kind)).json({
          error: listed.error.detail,
          kind: listed.error.kind,
        });
        return;
      }
      const skill = listed.value.find((item) => item.id === skillId);
      if (!skill) {
        res.status(404).json({ error: "skill not found" });
        return;
      }
      if (!["uploaded", "generated", "runtime_imported"].includes(skill.source.kind)) {
        res.status(400).json({
          error: "only uploaded, generated or runtime-imported skills can be submitted",
        });
        return;
      }
      if (!skill.source.sourcePath || !existsSync(skill.source.sourcePath)) {
        res.status(404).json({ error: "skill source missing" });
        return;
      }
      if (!skillInstaller.canInstall(skill.source.sourcePath)) {
        res.status(400).json({ error: "unsupported skill source" });
        return;
      }

      const userId = Number(claw.userId || 0);
      const existingIdentity = await getSkillIdentityBySkillId(skill.id);
      if (selectedIdentityId && existingIdentity?.identityId !== selectedIdentityId) {
        res.status(400).json({ error: "selected Skill identity does not match the package skillId" });
        return;
      }
      const organizationId = await resolveSkillPublisherOrganization(userId);
      const release = await publishSkillVersionFromSource({
        action: selectedIdentityId ? "publish_new_version" : "create_new_skill",
        sourcePath: skill.source.sourcePath,
        actorUserId: userId,
        isPlatformAdmin: false,
        maintainerType: "user",
        organizationId,
        visibility: "organization",
        selectedIdentityId: selectedIdentityId || undefined,
        requestedVersion: version,
        changelog,
        authorLabel: "用户维护",
        sourceOrigin: "squad",
        category: "general",
        license: "内部共享",
      });

      res.json({
        ok: true,
        marketItemId: release.legacyMarketId,
        identityId: release.identityId,
        versionId: release.versionId,
        version: release.version,
        artifactSha256: release.artifactSha256,
        status: release.status,
      });
    } catch (error) {
      logError("skill_market.submit_failed", error);
      const code = String((error as { code?: string })?.code || "");
      const status = code.startsWith("SKILL_") ? 409 : 500;
      res.status(status).json({
        error: error instanceof Error ? error.message : "submit skill to market failed",
        code: code || undefined,
      });
    }
  });
}
