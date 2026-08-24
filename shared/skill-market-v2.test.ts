import { describe, expect, it } from "vitest";
import {
  SKILL_MARKET_V2_SCHEMA_VERSION,
  agentSkillInstallationV2Schema,
  decideSkillPublication,
  latestStrictSemver,
  resolveLegacyCanonicalSkillId,
  resolveEffectiveSkillAssignment,
  roleSkillPreinstallV2Schema,
  skillIdentityV2Schema,
  strictSemverSchema,
  type AgentSkillAssignmentV2,
  type SkillIdentityV2,
} from "./skill-market-v2";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

function identity(overrides: Partial<SkillIdentityV2> = {}): SkillIdentityV2 {
  return {
    schemaVersion: SKILL_MARKET_V2_SCHEMA_VERSION,
    id: "skill-identity-1",
    skillId: "meeting-to-task",
    maintainerType: "user",
    maintainerUserId: 7,
    organizationId: "org-1",
    visibility: "organization",
    sourceOrigin: "user",
    upstreamAuthor: null,
    upstreamRepository: null,
    upstreamLicense: null,
    displayName: "Meeting to Task",
    category: "office",
    status: "active",
    latestApprovedVersionId: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("skill market v2 contracts", () => {
  it("accepts only strict release SemVer", () => {
    expect(strictSemverSchema.safeParse("1.2.3").success).toBe(true);
    expect(strictSemverSchema.safeParse("v1.2.3").success).toBe(false);
    expect(strictSemverSchema.safeParse("1.2").success).toBe(false);
    expect(strictSemverSchema.safeParse("1.2.3-beta.1").success).toBe(false);
  });

  it("selects the greatest approved SemVer independently of review order", () => {
    expect(
      latestStrictSemver([
        { version: "2.0.0", submittedAt: "2026-08-24T00:00:00.000Z" },
        { version: "1.9.0", submittedAt: "2026-08-24T01:00:00.000Z" },
        { version: "10.0.0", submittedAt: "2026-08-23T00:00:00.000Z" },
      ])?.version
    ).toBe("10.0.0");
  });

  it("normalizes only the known underscore-to-kebab legacy identity drift", () => {
    expect(
      resolveLegacyCanonicalSkillId(
        "major_announcement_impact_skill",
        "major-announcement-impact-skill"
      )
    ).toBe("major-announcement-impact-skill");
    expect(
      resolveLegacyCanonicalSkillId("alpha", "unrelated-skill")
    ).toBeNull();
  });

  it("requires organization scope only for organization-visible Skills", () => {
    expect(skillIdentityV2Schema.safeParse(identity()).success).toBe(true);
    expect(
      skillIdentityV2Schema.safeParse(identity({ organizationId: null }))
        .success
    ).toBe(false);
    expect(
      skillIdentityV2Schema.safeParse(
        identity({ organizationId: null, visibility: "platform" })
      ).success
    ).toBe(true);
  });

  it("treats an explicit owned identity and matching package ID as an upgrade", () => {
    expect(
      decideSkillPublication({
        action: "publish_new_version",
        actorUserId: 7,
        packageSkillId: "meeting-to-task",
        version: "1.1.0",
        artifactSha256: digestB,
        selectedIdentity: identity(),
        existingVersions: [{ version: "1.0.0", artifactSha256: digestA }],
      })
    ).toEqual({ ok: true, action: "publish_new_version" });
  });

  it("does not infer an upgrade from similar content or a reused display name", () => {
    expect(
      decideSkillPublication({
        action: "create_new_skill",
        actorUserId: 9,
        packageSkillId: "meeting-to-task",
        version: "1.0.0",
        artifactSha256: digestB,
        existingIdentityForSkillId: identity(),
      })
    ).toMatchObject({ ok: false, code: "SKILL_ID_RESERVED" });
  });

  it("rejects the wrong maintainer, mismatched ID, duplicate digest, and non-increasing versions", () => {
    const existingVersions = [{ version: "2.0.0", artifactSha256: digestA }];
    const base = {
      action: "publish_new_version" as const,
      actorUserId: 9,
      packageSkillId: "meeting-to-task",
      version: "2.1.0",
      artifactSha256: digestB,
      selectedIdentity: identity(),
      existingVersions,
    };
    expect(decideSkillPublication(base)).toMatchObject({
      ok: false,
      code: "SKILL_MAINTAINER_MISMATCH",
    });
    expect(
      decideSkillPublication({
        ...base,
        actorUserId: 7,
        packageSkillId: "other-skill",
      })
    ).toMatchObject({
      ok: false,
      code: "SKILL_ID_MISMATCH",
    });
    expect(
      decideSkillPublication({
        ...base,
        actorUserId: 7,
        artifactSha256: digestA,
      })
    ).toMatchObject({
      ok: false,
      code: "UNCHANGED_ARTIFACT",
    });
    expect(
      decideSkillPublication({ ...base, actorUserId: 7, version: "1.9.9" })
    ).toMatchObject({
      ok: false,
      code: "SKILL_VERSION_NOT_GREATER",
    });
  });

  it("allows only administrators to maintain system Skills", () => {
    const systemIdentity = identity({
      maintainerType: "system",
      maintainerUserId: null,
    });
    const base = {
      action: "publish_new_version" as const,
      actorUserId: 9,
      packageSkillId: "meeting-to-task",
      version: "1.1.0",
      artifactSha256: digestB,
      selectedIdentity: systemIdentity,
      existingVersions: [{ version: "1.0.0", artifactSha256: digestA }],
    };
    expect(decideSkillPublication(base)).toMatchObject({
      ok: false,
      code: "SKILL_MAINTAINER_MISMATCH",
    });
    expect(decideSkillPublication({ ...base, isPlatformAdmin: true })).toEqual({
      ok: true,
      action: "publish_new_version",
    });
    expect(
      decideSkillPublication({
        action: "create_new_skill",
        actorUserId: 9,
        maintainerType: "system",
        packageSkillId: "system-skill",
        version: "1.0.0",
        artifactSha256: digestA,
      })
    ).toMatchObject({ ok: false, code: "SKILL_MAINTAINER_MISMATCH" });
    expect(
      decideSkillPublication({
        action: "create_new_skill",
        actorUserId: 9,
        maintainerType: "system",
        isPlatformAdmin: true,
        packageSkillId: "system-skill",
        version: "1.0.0",
        artifactSha256: digestA,
      })
    ).toEqual({ ok: true, action: "create_new_skill" });
  });

  it("keeps active and desired installation facts paired", () => {
    const base = {
      schemaVersion: SKILL_MARKET_V2_SCHEMA_VERSION,
      adoptId: "lgj-demo",
      skillIdentityId: "skill-identity-1",
      activeVersionId: "version-1",
      activeArtifactSha256: digestA,
      desiredVersionId: "version-2",
      desiredArtifactSha256: digestB,
      state: "updating" as const,
      enabled: true,
      operationId: "operation-1",
      operationGeneration: 3,
      leaseExpiresAt: "2026-08-24T01:00:00.000Z",
      lastError: null,
      installedBy: 7,
      installedAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    expect(agentSkillInstallationV2Schema.safeParse(base).success).toBe(true);
    expect(
      agentSkillInstallationV2Schema.safeParse({
        ...base,
        desiredArtifactSha256: null,
      }).success
    ).toBe(false);
    expect(
      agentSkillInstallationV2Schema.safeParse({
        ...base,
        state: "disabled",
        enabled: false,
        operationId: null,
      }).success
    ).toBe(true);
  });

  it("requires exact provided digest evidence for role preinstallation", () => {
    const base = {
      schemaVersion: SKILL_MARKET_V2_SCHEMA_VERSION,
      roleKey: "wealth_manager",
      skillIdentityId: "skill-identity-1",
      versionId: "version-1",
      artifactSha256: digestA,
      rolePackReleaseId: "role-pack-release-1",
      goldenTaskRunId: "golden-task-run-1",
      providedArtifactSha256: digestA,
      enabled: true,
      updatedBy: 7,
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    expect(roleSkillPreinstallV2Schema.safeParse(base).success).toBe(true);
    expect(
      roleSkillPreinstallV2Schema.safeParse({
        ...base,
        providedArtifactSha256: digestB,
      }).success
    ).toBe(false);
  });

  it("lets a role preinstall override a personal assignment without losing personal intent", () => {
    const base: Omit<AgentSkillAssignmentV2, "id" | "source"> = {
      schemaVersion: SKILL_MARKET_V2_SCHEMA_VERSION,
      adoptId: "lgj-demo",
      skillIdentityId: "skill-identity-1",
      assignmentRef: "assignment-ref-1",
      requestedVersionId: "version-1",
      enabled: true,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const effective = resolveEffectiveSkillAssignment([
      { ...base, id: "role", source: "role_preinstall" },
      { ...base, id: "personal", source: "personal" },
    ]);
    expect(effective?.id).toBe("role");
  });
});
