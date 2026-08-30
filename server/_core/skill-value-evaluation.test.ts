import { describe, expect, it } from "vitest";
import { curatedSkillValueSuiteMatchesVersion } from "./skill-value-evaluation";

describe("Skill value evaluation curated suites", () => {
  const selectedVersion = {
    version: "2.2.0",
    artifactSha256: "b".repeat(64),
  };

  it("keeps unversioned reusable suites", () => {
    expect(curatedSkillValueSuiteMatchesVersion({}, selectedVersion)).toBe(true);
  });

  it("accepts a suite frozen to the selected Artifact", () => {
    expect(curatedSkillValueSuiteMatchesVersion({
      targetVersion: "2.2.0",
      targetArtifactSha256: "b".repeat(64),
    }, selectedVersion)).toBe(true);
  });

  it("rejects a suite frozen to another Skill version", () => {
    expect(curatedSkillValueSuiteMatchesVersion({
      targetVersion: "1.0.1",
      targetArtifactSha256: "a".repeat(64),
    }, selectedVersion)).toBe(false);
  });
});
