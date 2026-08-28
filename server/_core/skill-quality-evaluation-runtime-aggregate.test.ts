import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { governanceFingerprint } from "./governance/contracts";
import { aggregateSkillQualityRuntimeSmokes } from "./skill-quality-evaluation-runtime-aggregate";

const arms = ["target_skill", "without_target_skill", "previous_version"] as const;

function adoptionFor(executionArm: typeof arms[number]): string {
  if (executionArm === "target_skill") return "lgj-eval-wealth-target";
  if (executionArm === "previous_version") return "lgj-eval-wealth-previous";
  return "lgj-eval-wealth-without";
}

function expectedSkill(executionArm: typeof arms[number]) {
  return executionArm === "without_target_skill"
    ? null
    : {
        skillId: "wealth-manager-assistant",
        skillVersionId: executionArm === "target_skill" ? "skill-version-target" : "skill-version-previous",
        version: executionArm === "target_skill" ? "2.0.1" : "1.4.0",
        artifactSha256: executionArm === "target_skill" ? "a".repeat(64) : "b".repeat(64),
        entrypointSha256: executionArm === "target_skill" ? "1".repeat(64) : "2".repeat(64),
      };
}

const profileBody = {
  schema: "ea.skill-quality-runtime-profile.v1" as const,
  profileId: "runtime-profile",
  evaluatedSkillId: "wealth-manager-assistant",
  baseUrl: "http://127.0.0.1:5180",
  chatEndpoint: "/api/claw/chat-stream" as const,
  internalAuthEnv: "INTERNAL_API_KEY" as const,
  arms: arms.map(executionArm => {
    const adoptionId = adoptionFor(executionArm);
    return {
      executionArm,
      adoptionId,
      expectedAgentId: `jiuwen_${adoptionId}`,
      roleTemplate: "wealth-manager" as const,
      expectedSkill: expectedSkill(executionArm),
    };
  }),
};
const profile = {
  ...profileBody,
  profileFingerprint: governanceFingerprint(profileBody),
};

function report(executionArm: typeof arms[number]) {
  const expected = expectedSkill(executionArm);
  const adoptionId = adoptionFor(executionArm);
  const preDispatchIdentity = {
    profileFingerprint: profile.profileFingerprint,
    adoptId: adoptionId,
    agentId: `jiuwen_${adoptionId}`,
    injectedSkills: expected ? [{
      skillId: expected.skillId,
      version: expected.version,
      artifactSha256: expected.artifactSha256,
    }] : [],
  };
  const nativeLoadedSkills = expected
    ? [{
        toolCallId: `call-${executionArm}`,
        requestedSkillId: expected.skillId,
        skillId: expected.skillId,
        version: expected.version,
        skillDirectory: `workspace/skills/${expected.skillId}`,
        entrypointSha256: expected.entrypointSha256,
      }]
    : [{
        toolCallId: "call-substitute",
        requestedSkillId: "privbank-previsit",
        skillId: "privbank-previsit",
        version: "1.3.0",
        skillDirectory: "workspace/skills/privbank-previsit",
        entrypointSha256: "3".repeat(64),
      }];
  const body = {
    schema: "ea.skill-quality-phase-1b-runtime-report.v1",
    status: "RUNTIME_ARM_SMOKE_VERIFIED",
    smokeScope: "single_arm_diagnostic",
    requestedSmokeArm: executionArm,
    resultSemantics: "runtime_integration_non_certifying",
    profile,
    profileVerification: { status: "PASS", profileFingerprint: profile.profileFingerprint },
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
      preDispatchIdentityStatus: "VERIFIED",
      preDispatchIdentity,
      preDispatchIdentityFingerprint: governanceFingerprint(preDispatchIdentity),
      nativeSkillIdentityStatus: "VERIFIED",
      nativeLoadedSkills,
      streamCompletionStatus: "VERIFIED",
      streamEndCount: 1,
      unpairedToolCallIds: [],
      run: { requestId: `request-${executionArm}`, sessionId: `session-${executionArm}` },
      events: [
        { event: "message", data: { __run: { requestId: `request-${executionArm}` } } },
        { event: "message", data: { __stream_end: true } },
      ],
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

  it("recomputes the Runtime Profile fingerprint during aggregation", () => {
    const reports = arms.map(report);
    reports[0].profile.profileId = "tampered-runtime-profile";
    const { reportFingerprint: _stored, ...body } = reports[0];
    reports[0].reportFingerprint = governanceFingerprint(body);
    expect(() => aggregateSkillQualityRuntimeSmokes(reports)).toThrow(
      /Runtime Profile fingerprint/u
    );
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
