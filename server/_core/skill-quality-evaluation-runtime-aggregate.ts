import type { SkillEvaluationExecutionArm } from "../../shared/skill-quality-evaluation";
import { governanceFingerprint } from "./governance/contracts";

const REQUIRED_ARMS: SkillEvaluationExecutionArm[] = [
  "target_skill",
  "without_skill",
  "previous_version",
];
const SHA256 = /^[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function sha256(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!SHA256.test(normalized)) throw new Error(`${label} must be a SHA-256 digest`);
  return normalized;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export type SkillQualityRuntimeSmokeAggregate = {
  schema: "ea.skill-quality-phase-1b-runtime-smoke-aggregate.v1";
  generatedAt: string;
  status: "RUNTIME_THREE_ARM_SMOKE_VERIFIED";
  resultSemantics: "runtime_integration_non_certifying";
  profileId: string;
  profileFingerprint: string;
  suiteId: string;
  suiteFingerprint: string;
  arms: Array<{
    executionArm: SkillEvaluationExecutionArm;
    adoptionId: string;
    runtimeIdentityFingerprint: string;
    sourceReportFingerprint: string;
    conversationId: string;
    requestId: string;
    sessionId: string;
    elapsedMs: number;
    assistantTextSha256: string;
    rawSseSha256: string;
    eventCount: number;
  }>;
  aggregateFingerprint: string;
};

export function aggregateSkillQualityRuntimeSmokes(
  inputReports: unknown[],
  generatedAt = new Date().toISOString()
): SkillQualityRuntimeSmokeAggregate {
  if (inputReports.length !== REQUIRED_ARMS.length) {
    throw new Error(`Exactly ${REQUIRED_ARMS.length} single-arm reports are required`);
  }

  let expectedProfileId = "";
  let expectedProfileFingerprint = "";
  let expectedSuiteId = "";
  let expectedSuiteFingerprint = "";
  const seenArms = new Set<string>();
  const seenReports = new Set<string>();
  const seenConversations = new Set<string>();
  const summaries: SkillQualityRuntimeSmokeAggregate["arms"] = [];

  for (const [index, input] of inputReports.entries()) {
    const report = record(input, `report[${index}]`);
    if (report.schema !== "ea.skill-quality-phase-1b-runtime-report.v1") {
      throw new Error(`report[${index}] has an unsupported schema`);
    }
    if (
      report.status !== "RUNTIME_ARM_SMOKE_VERIFIED" ||
      report.smokeScope !== "single_arm_diagnostic" ||
      report.resultSemantics !== "runtime_integration_non_certifying"
    ) {
      throw new Error(`report[${index}] is not a verified single-arm Runtime smoke`);
    }
    const sourceReportFingerprint = sha256(
      report.reportFingerprint,
      `report[${index}].reportFingerprint`
    );
    const { reportFingerprint: _reportedFingerprint, ...reportBody } = report;
    if (governanceFingerprint(reportBody) !== sourceReportFingerprint) {
      throw new Error(`report[${index}] fingerprint does not match its evidence body`);
    }
    if (seenReports.has(sourceReportFingerprint)) {
      throw new Error("Each execution arm requires a distinct source report");
    }
    seenReports.add(sourceReportFingerprint);

    const executionArm = text(
      report.requestedSmokeArm,
      `report[${index}].requestedSmokeArm`
    ) as SkillEvaluationExecutionArm;
    if (!REQUIRED_ARMS.includes(executionArm) || seenArms.has(executionArm)) {
      throw new Error(`Duplicate or unsupported Runtime smoke arm: ${executionArm}`);
    }
    seenArms.add(executionArm);

    const profile = record(report.profile, `report[${index}].profile`);
    const profileId = text(profile.profileId, `report[${index}].profile.profileId`);
    const profileFingerprint = sha256(
      profile.profileFingerprint,
      `report[${index}].profile.profileFingerprint`
    );
    const suiteId = text(report.suiteId, `report[${index}].suiteId`);
    const suiteFingerprint = sha256(
      report.suiteFingerprint,
      `report[${index}].suiteFingerprint`
    );
    if (!expectedProfileFingerprint) {
      expectedProfileId = profileId;
      expectedProfileFingerprint = profileFingerprint;
      expectedSuiteId = suiteId;
      expectedSuiteFingerprint = suiteFingerprint;
    } else if (
      profileId !== expectedProfileId ||
      profileFingerprint !== expectedProfileFingerprint ||
      suiteId !== expectedSuiteId ||
      suiteFingerprint !== expectedSuiteFingerprint
    ) {
      throw new Error("All Runtime smoke reports must use the same profile and Suite");
    }

    const verification = record(
      report.profileVerification,
      `report[${index}].profileVerification`
    );
    if (
      verification.status !== "PASS" ||
      verification.profileFingerprint !== profileFingerprint
    ) {
      throw new Error(`report[${index}] Runtime profile verification is not valid`);
    }
    const armProfile = array(profile.arms, `report[${index}].profile.arms`)
      .map((value, armIndex) => record(value, `report[${index}].profile.arms[${armIndex}]`))
      .find(arm => arm.executionArm === executionArm);
    if (!armProfile) throw new Error(`report[${index}] is missing its Runtime arm profile`);

    const turns = array(report.runtimeTurns, `report[${index}].runtimeTurns`);
    if (turns.length !== 1) throw new Error(`report[${index}] must contain exactly one Runtime turn`);
    const turn = record(turns[0], `report[${index}].runtimeTurns[0]`);
    if (
      turn.executionArm !== executionArm ||
      turn.status !== "PASS" ||
      turn.httpStatus !== 200 ||
      turn.runtimeIdentityStatus !== "VERIFIED" ||
      Number(turn.elapsedMs) <= 0 ||
      !String(turn.assistantText || "").trim()
    ) {
      throw new Error(`report[${index}] Runtime turn is incomplete`);
    }
    const adoptionId = text(turn.adoptionId, `report[${index}].runtimeTurns[0].adoptionId`);
    if (adoptionId !== armProfile.adoptionId) {
      throw new Error(`report[${index}] Runtime turn adoption does not match its profile`);
    }
    const runtimeIdentity = record(
      turn.runtimeIdentity,
      `report[${index}].runtimeTurns[0].runtimeIdentity`
    );
    if (
      runtimeIdentity.profileFingerprint !== profileFingerprint ||
      runtimeIdentity.adoptId !== adoptionId ||
      runtimeIdentity.agentId !== armProfile.expectedAgentId
    ) {
      throw new Error(`report[${index}] Runtime identity does not match its frozen profile`);
    }
    const runtimeIdentityFingerprint = sha256(
      turn.runtimeIdentityFingerprint,
      `report[${index}].runtimeTurns[0].runtimeIdentityFingerprint`
    );
    if (governanceFingerprint(runtimeIdentity) !== runtimeIdentityFingerprint) {
      throw new Error(`report[${index}] Runtime identity fingerprint is invalid`);
    }
    const runtimeSkills = array(
      runtimeIdentity.runtimeSkills,
      `report[${index}].runtimeTurns[0].runtimeIdentity.runtimeSkills`
    );
    const expectedSkill = armProfile.expectedSkill;
    if (!expectedSkill && runtimeSkills.length !== 0) {
      throw new Error("without_skill Runtime identity must not include the evaluated Skill");
    }
    if (expectedSkill) {
      const expected = record(expectedSkill, `report[${index}].profile.expectedSkill`);
      const matched = runtimeSkills.some(value => {
        const skill = record(value, `report[${index}].runtimeIdentity.runtimeSkills[]`);
        return skill.skillId === expected.skillId &&
          skill.version === expected.version &&
          skill.artifactSha256 === expected.artifactSha256;
      });
      if (!matched) throw new Error(`report[${index}] did not execute the expected Skill artifact`);
    }

    const conversationId = text(
      turn.conversationId,
      `report[${index}].runtimeTurns[0].conversationId`
    );
    if (seenConversations.has(conversationId)) {
      throw new Error("Each Runtime smoke arm requires an isolated conversation");
    }
    seenConversations.add(conversationId);
    const run = record(turn.run, `report[${index}].runtimeTurns[0].run`);
    const events = array(turn.events, `report[${index}].runtimeTurns[0].events`);
    const hasNativeRunEvent = events.some(value => {
      const event = record(value, `report[${index}].runtimeTurns[0].events[]`);
      const data = record(event.data, `report[${index}].runtimeTurns[0].events[].data`);
      return Boolean(data.__run);
    });
    if (!hasNativeRunEvent) throw new Error(`report[${index}] has no native __run event`);

    summaries.push({
      executionArm,
      adoptionId,
      runtimeIdentityFingerprint,
      sourceReportFingerprint,
      conversationId,
      requestId: text(run.requestId || run.runId, `report[${index}].run.requestId`),
      sessionId: text(run.sessionId, `report[${index}].run.sessionId`),
      elapsedMs: Number(turn.elapsedMs),
      assistantTextSha256: sha256(turn.assistantTextSha256, `report[${index}].assistantTextSha256`),
      rawSseSha256: sha256(turn.rawSseSha256, `report[${index}].rawSseSha256`),
      eventCount: events.length,
    });
  }

  if (REQUIRED_ARMS.some(arm => !seenArms.has(arm))) {
    throw new Error("The Runtime smoke set does not cover all three execution arms");
  }
  const body = {
    schema: "ea.skill-quality-phase-1b-runtime-smoke-aggregate.v1" as const,
    generatedAt,
    status: "RUNTIME_THREE_ARM_SMOKE_VERIFIED" as const,
    resultSemantics: "runtime_integration_non_certifying" as const,
    profileId: expectedProfileId,
    profileFingerprint: expectedProfileFingerprint,
    suiteId: expectedSuiteId,
    suiteFingerprint: expectedSuiteFingerprint,
    arms: REQUIRED_ARMS.map(arm => summaries.find(item => item.executionArm === arm)!),
  };
  return { ...body, aggregateFingerprint: governanceFingerprint(body) };
}
