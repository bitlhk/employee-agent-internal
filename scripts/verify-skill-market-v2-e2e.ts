import "dotenv/config";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  agentSkillAssignments,
  agentSkillInstallEvents,
  agentSkillInstallations,
  skillIdentities,
  skillMarketplace,
  skillVersions,
  users,
} from "../drizzle/schema";
import { installApprovedSkillVersion } from "../server/_core/skills/skill-market-installation";
import { publishSkillVersionFromSource } from "../server/_core/skills/skill-market-v2-service";
import { skillRegistry } from "../server/_core/skills/skill-registry";
import { skillStorePath } from "../server/_core/skills/skill-store";
import {
  getSkillIdentityById,
  getSkillVersionById,
  resolveSkillPublisherOrganization,
  reviewSkillVersionByLegacyMarketId,
} from "../server/db";
import { closeDbConnection, getDb } from "../server/db/connection";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function writeFixture(
  root: string,
  skillId: string,
  label: string
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "SKILL.md"),
    [
      "---",
      `name: ${skillId}`,
      `description: Skill Market V2 ${label}`,
      "---",
      `# Skill Market V2 ${label}`,
      "",
      `This fixture proves ${label} activation.`,
      "",
    ].join("\n"),
    "utf8"
  );
}

async function main(): Promise<void> {
  if (!process.argv.includes("--allow-write")) {
    throw new Error("refusing to mutate the environment without --allow-write");
  }
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required");

  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const skillId = `skill-market-v2-e2e-${suffix}`;
  const adoptId = `lgc-skill-market-v2-e2e-${suffix}`;
  const fixtureRoot = path.join(os.tmpdir(), skillId);
  const v1Root = path.join(fixtureRoot, "v1");
  const v2Root = path.join(fixtureRoot, "v2");
  let identityId: string | undefined;

  try {
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .orderBy(users.id)
      .limit(1);
    const [publisher] = await db
      .select({ id: users.id })
      .from(users)
      .where(ne(users.role, "admin"))
      .orderBy(users.id)
      .limit(1);
    assert(admin?.id, "an administrator is required");
    assert(publisher?.id, "a non-administrator publisher is required");

    await writeFixture(v1Root, skillId, "v1");
    await writeFixture(v2Root, skillId, "v2");
    const organizationId = await resolveSkillPublisherOrganization(
      publisher.id
    );
    const v1 = await publishSkillVersionFromSource({
      action: "create_new_skill",
      sourcePath: v1Root,
      actorUserId: publisher.id,
      isPlatformAdmin: false,
      maintainerType: "user",
      organizationId,
      visibility: "organization",
      requestedVersion: "1.0.0",
      changelog: "initial E2E release",
      authorLabel: "Skill Market V2 E2E",
      sourceOrigin: "e2e",
      category: "general",
      license: "internal-test",
    });
    identityId = v1.identityId;
    await reviewSkillVersionByLegacyMarketId({
      legacyMarketId: v1.legacyMarketId,
      status: "approved",
      reviewedBy: admin.id,
      reviewNote: "E2E approved",
    });

    const v2 = await publishSkillVersionFromSource({
      action: "publish_new_version",
      sourcePath: v2Root,
      actorUserId: publisher.id,
      isPlatformAdmin: false,
      maintainerType: "user",
      organizationId,
      visibility: "organization",
      selectedIdentityId: v1.identityId,
      requestedVersion: "1.1.0",
      changelog: "E2E update",
      authorLabel: "Skill Market V2 E2E",
      sourceOrigin: "e2e",
      category: "general",
      license: "internal-test",
    });
    await reviewSkillVersionByLegacyMarketId({
      legacyMarketId: v2.legacyMarketId,
      status: "approved",
      reviewedBy: admin.id,
      reviewNote: "E2E approved",
    });

    const identity = await getSkillIdentityById(v1.identityId);
    assert(
      identity?.latestApprovedVersionId === v2.versionId,
      "latest approved version is not 1.1.0"
    );

    await installApprovedSkillVersion({
      adoptId,
      versionId: v1.versionId,
      actorUserId: publisher.id,
      organizationId: `${organizationId}-unauthorized`,
    }).then(
      () => {
        throw new Error("cross-organization install was not rejected");
      },
      error =>
        assert(
          error instanceof Error && error.message.includes("not visible"),
          "cross-organization install returned the wrong failure"
        )
    );

    const installed = await installApprovedSkillVersion({
      adoptId,
      versionId: v1.versionId,
      actorUserId: publisher.id,
      organizationId,
    });
    const updated = await installApprovedSkillVersion({
      adoptId,
      versionId: v2.versionId,
      actorUserId: publisher.id,
      organizationId,
    });
    const rolledBack = await installApprovedSkillVersion({
      adoptId,
      versionId: v1.versionId,
      actorUserId: publisher.id,
      organizationId,
    });
    assert(
      installed.operation === "install",
      "first activation was not recorded as install"
    );
    assert(
      updated.operation === "update",
      "newer activation was not recorded as update"
    );
    assert(
      rolledBack.operation === "rollback",
      "older activation was not recorded as rollback"
    );

    const active = await getSkillVersionById(v1.versionId);
    assert(
      active?.artifactSha256 === v1.artifactSha256,
      "rollback artifact digest changed"
    );
    const listed = await skillRegistry.listSkills(adoptId);
    assert(listed.ok, "runtime registry cannot be read");
    const runtime = listed.value.find(skill => skill.id === skillId);
    assert(
      runtime?.source.kind === "marketplace",
      "runtime marketplace Skill is missing"
    );
    assert(
      runtime.source.version === "1.0.0",
      "runtime did not return to 1.0.0"
    );
    assert(runtime.sync.runtimePath, "runtime path is missing");
    const runtimeText = await readFile(
      path.join(runtime.sync.runtimePath, "SKILL.md"),
      "utf8"
    );
    assert(
      runtimeText.includes("Skill Market V2 v1"),
      "runtime content does not match rollback version"
    );

    const events = await db
      .select()
      .from(agentSkillInstallEvents)
      .where(
        and(
          eq(agentSkillInstallEvents.adoptId, adoptId),
          eq(agentSkillInstallEvents.skillIdentityId, v1.identityId)
        )
      );
    assert(
      events.filter(event => event.status === "succeeded").length === 3,
      "execution ledger is incomplete"
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          maintainerType: identity.maintainerType,
          versions: [v1.version, v2.version],
          operations: [
            installed.operation,
            updated.operation,
            rolledBack.operation,
          ],
          immutableDigestsVerified: true,
          crossOrganizationInstallBlocked: true,
          succeededEvents: 3,
        },
        null,
        2
      )
    );
  } finally {
    await skillRegistry.uninstall(adoptId, skillId).catch(() => undefined);
    const identities = await db
      .select()
      .from(skillIdentities)
      .where(eq(skillIdentities.skillId, skillId));
    const identityIds = identities.map(identity => identity.identityId);
    if (identityIds.length > 0) {
      const releases = await db
        .select()
        .from(skillVersions)
        .where(inArray(skillVersions.skillIdentityId, identityIds));
      const legacyIds = releases
        .map(release => release.legacyMarketId)
        .filter((id): id is number => Number.isInteger(id));
      await db
        .delete(agentSkillInstallEvents)
        .where(inArray(agentSkillInstallEvents.skillIdentityId, identityIds));
      await db
        .delete(agentSkillAssignments)
        .where(inArray(agentSkillAssignments.skillIdentityId, identityIds));
      await db
        .delete(agentSkillInstallations)
        .where(inArray(agentSkillInstallations.skillIdentityId, identityIds));
      await db
        .delete(skillVersions)
        .where(inArray(skillVersions.skillIdentityId, identityIds));
      await db
        .delete(skillIdentities)
        .where(inArray(skillIdentities.identityId, identityIds));
      if (legacyIds.length > 0)
        await db
          .delete(skillMarketplace)
          .where(inArray(skillMarketplace.id, legacyIds));
    }
    if (identityId)
      await rm(skillStorePath("marketplace", "artifacts", skillId), {
        recursive: true,
        force: true,
      });
    await rm(fixtureRoot, { recursive: true, force: true });
    await closeDbConnection();
  }
}

main().catch(error => {
  console.error(
    `[SKILL-MARKET-V2-E2E] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
