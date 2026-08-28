import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { governanceFingerprint } from "./governance/contracts";
import { aggregateSkillQualityRuntimeSmokes } from "./skill-quality-evaluation-runtime-aggregate";

const arms = ["target_skill", "without_skill", "previous_version"] as const;

function report(executionArm: typeof arms[number]) {
  const expectedSkill = executionArm === "without_skill"
    ? null
    : {
        skillId: "wealth-manager-assistant",
        version: executionArm === "target_skill" ? "2.0.1" : "1.4.0",
        artifactSha256: executionArm === "target_skill" ? "a".repeat(64) : "b".repeat(64),
      };
  const adoptionId = `lgj-eval-wealth-${executionArm}`;
  const runtimeIdentity = {
    profileFingerprint: "c".repeat(64),
    adoptId: adoptionId,
    agentId: `jiuwen_${adoptionId}`,
    runtimeSkills: expectedSkill ? [expectedSkill] : [],
  };
  const body = {
    schema: "ea.skill-quality-phase-1b-runtime-report.v1",
    status: "RUNTIME_ARM_SMOKE_VERIFIED",
    smokeScope: "single_arm_diagnostic",
    requestedSmokeArm: executionArm,
    resultSemantics: "runtime_integration_non_certifying",
    profile: {
      profileId: "runtime-profile",
      profileFingerprint: "c".repeat(64),
      arms: [{
        executionArm,
        adoptionId,
        expectedAgentId: `jiuwen_${adoptionId}`,
        expectedSkill,
      }],
    },
    profileVerification: { status: "PASS", profileFingerprint: "c".repeat(64) },
    suiteId: "suite-v1",
    suiteFingerprint: "d".repeat(64),
    runtimeTurns: [{
      executionArm,
      adoptionId,
      conversationId: `conversation-${executionArm}`,
      status: "PASS",
      httpStatus: 200,
      elapsedMs: 10,
      assistantText: "output",
      assistantTextSha256: "e".repeat(64),
      rawSseSha256: "f".repeat(64),
      runtimeIdentityStatus: "VERIFIED",
      runtimeIdentity,
      runtimeIdentityFingerprint: governanceFingerprint(runtimeIdentity),
      run: { requestId: `request-${executionArm}`, sessionId: `session-${executionArm}` },
      events: [{ event: "message", data: { __run: { requestId: `request-${executionArm}` } } }],
    }],
  };
  return { ...body, reportFingerprint: governanceFingerprint(body) };
}

describe("Skill Quality Phase 1B Runtime smoke aggregate", () => {
  it("binds three verified arms to one profile and Suite", () => {
    const result = aggregateSkillQualityRuntimeSmokes(arms.map(report), "2026-08-28T12:00:00.000Z");
    expect(result.status).toBe("RUNTIME_THREE_ARM_SMOKE_VERIFIED");
    expect(result.arms.map(arm => arm.executionArm)).toEqual(arms);
    expect(result.aggregateFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a report whose evidence changed after fingerprinting", () => {
    const reports = arms.map(report);
    reports[0].runtimeTurns[0].assistantText = "tampered";
    expect(() => aggregateSkillQualityRuntimeSmokes(reports)).toThrow(/fingerprint/u);
  });

  it("keeps the committed non-certifying smoke baseline fingerprinted", () => {
    const filePath = path.join(
      process.cwd(),
      "examples",
      "skill-quality-evaluation-v1",
      "phase1b-runtime-smoke-baseline-v1.json"
    );
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const { aggregateFingerprint, ...body } = parsed;
    expect(aggregateFingerprint).toBe(governanceFingerprint(body));
    expect(parsed.resultSemantics).toBe("runtime_integration_non_certifying");
  });
});
