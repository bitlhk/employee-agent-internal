import { describe, expect, it } from "vitest";
import { assertRoleDefaultSkillReleaseEvidence } from "./role-default-skill-release";

const digest = "a".repeat(64);
const base = {
  operation: "release" as const,
  roleKey: "wealth-manager",
  skillId: "wealth-manager-assistant",
  skillIdentityId: "skill-identity",
  versionSkillIdentityId: "skill-identity",
  versionStatus: "approved",
  artifactSha256: digest,
  providedArtifactSha256: digest,
  defaultSkillIds: ["wealth-manager-assistant"],
  rolePackReleaseStatus: "verified",
};

describe("role-default Skill release evidence", () => {
  it("accepts an approved exact artifact covered by a verified Role Pack release", () => {
    expect(() => assertRoleDefaultSkillReleaseEvidence(base)).not.toThrow();
  });

  it("rejects a Golden Task run that did not provide the exact artifact", () => {
    expect(() =>
      assertRoleDefaultSkillReleaseEvidence({
        ...base,
        providedArtifactSha256: "b".repeat(64),
      })
    ).toThrow(/exact approved Skill artifact/);
  });

  it("rejects a non-default Skill and unverified release evidence", () => {
    expect(() =>
      assertRoleDefaultSkillReleaseEvidence({
        ...base,
        defaultSkillIds: [],
      })
    ).toThrow(/not a default Skill/);
    expect(() =>
      assertRoleDefaultSkillReleaseEvidence({
        ...base,
        rolePackReleaseStatus: "candidate",
      })
    ).toThrow(/verified Role Pack release/);
  });

  it("allows stale historical evidence only for an explicit rollback", () => {
    expect(() =>
      assertRoleDefaultSkillReleaseEvidence({
        ...base,
        operation: "rollback",
        rolePackReleaseStatus: "stale",
      })
    ).not.toThrow();
    expect(() =>
      assertRoleDefaultSkillReleaseEvidence({
        ...base,
        rolePackReleaseStatus: "stale",
      })
    ).toThrow(/verified Role Pack release/);
  });
});
