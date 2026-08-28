import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDbConnection } from "../server/db/connection";
import { governanceFingerprint } from "../server/_core/governance/contracts";
import {
  buildSkillEvaluationRuntimeProfile,
  executeSkillEvaluationRuntimeTurn,
  verifySkillEvaluationRuntimeProfile,
} from "../server/_core/skill-quality-evaluation-runtime";
import { loadSkillQualityPilotContracts } from "../server/_core/skill-quality-evaluation-contracts";
import type { SkillEvaluationExecutionArm } from "../shared/skill-quality-evaluation";

const executionArms: SkillEvaluationExecutionArm[] = [
  "target_skill",
  "without_target_skill",
  "previous_version",
];

function requestedSmokeArm(): SkillEvaluationExecutionArm | null {
  const argument = process.argv.find(value => value.startsWith("--smoke-arm="));
  if (!argument) return null;
  const value = argument.slice("--smoke-arm=".length) as SkillEvaluationExecutionArm;
  if (!executionArms.includes(value)) {
    throw new Error(`Unsupported Smoke arm: ${value}`);
  }
  return value;
}

type RuntimeReportMarkdownInput = {
  status: string;
  profile: { profileId: string; profileFingerprint: string };
  profileVerification: {
    arms: Array<{
      executionArm: string;
      adoptionId: string;
      status: string;
      runtimeSkill: { version: string; artifactSha256: string } | null;
    }>;
  };
  runtimeTurns: Array<{
    executionArm: string;
    status: string;
    preDispatchIdentityStatus: string;
    nativeSkillIdentityStatus: string;
    streamCompletionStatus: string;
    httpStatus: number;
    elapsedMs: number;
  }>;
};

function markdown(report: RuntimeReportMarkdownInput): string {
  const armLines = report.profileVerification.arms.map(arm =>
    `| ${arm.executionArm} | ${arm.adoptionId} | ${arm.status} | ${arm.runtimeSkill?.version || "none"} | ${arm.runtimeSkill?.artifactSha256?.slice(0, 12) || "-"} |`
  );
  const smokeLines = report.runtimeTurns.map(turn =>
    `| ${turn.executionArm} | ${turn.status} | ${turn.preDispatchIdentityStatus} | ${turn.nativeSkillIdentityStatus} | ${turn.streamCompletionStatus} | ${turn.httpStatus} | ${turn.elapsedMs} |`
  );
  return [
    "# Skill Quality Phase 1B EA Runtime Integration",
    "",
    `- Status: **${report.status}**`,
    `- Profile: \`${report.profile.profileId}\``,
    `- Profile fingerprint: \`${report.profile.profileFingerprint}\``,
    "- Result semantics: **runtime integration evidence / non-certifying**",
    "",
    "| Arm | Eval Adoption | Profile | Runtime version | Artifact SHA |",
    "|---|---|---:|---|---|",
    ...armLines,
    "",
    ...(smokeLines.length
      ? [
          "| Arm | Runtime turn | Pre-dispatch | Native Skill | SSE complete | HTTP | ms |",
          "|---|---:|---:|---:|---:|---:|---:|",
          ...smokeLines,
          "",
        ]
      : []),
    "This report proves only the configured EA Runtime profile and optional read-only smoke turn. Full Suite execution, native controlled MCP fixtures, confirmation execution, expert validation, formal scores and publication gates remain pending.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const executeSmoke = process.argv.includes("--execute-smoke");
  const smokeArm = requestedSmokeArm();
  if (smokeArm && !executeSmoke) {
    throw new Error("--smoke-arm requires --execute-smoke");
  }
  const profile = buildSkillEvaluationRuntimeProfile();
  const profileVerification = await verifySkillEvaluationRuntimeProfile(profile);
  const contracts = loadSkillQualityPilotContracts({
    skillId: "wealth-manager-assistant",
  });
  const runtimeTurns = [];
  if (profileVerification.status === "PASS" && executeSmoke) {
    const smokeCase = contracts.suite.cases.find(
      item => item.caseId === "WM-SKILL-EVAL-001"
    );
    if (!smokeCase) throw new Error("Read-only Runtime smoke case is missing");
    const selectedArms = smokeArm
      ? profile.arms.filter(arm => arm.executionArm === smokeArm)
      : profile.arms;
    for (const arm of selectedArms) {
      runtimeTurns.push(
        await executeSkillEvaluationRuntimeTurn({
          profile,
          arm,
          message: smokeCase.prompt,
        })
      );
    }
  }
  const body = {
    schema: "ea.skill-quality-phase-1b-runtime-report.v1",
    generatedAt: new Date().toISOString(),
    smokeScope: smokeArm ? "single_arm_diagnostic" : "all_arms",
    requestedSmokeArm: smokeArm,
    status:
      profileVerification.status !== "PASS"
        ? "RUNTIME_PROFILE_BLOCKED"
        : executeSmoke && runtimeTurns.every(turn => turn.status === "PASS")
          ? smokeArm
            ? "RUNTIME_ARM_SMOKE_VERIFIED"
            : "RUNTIME_SMOKE_VERIFIED"
          : executeSmoke
            ? smokeArm
              ? "RUNTIME_ARM_SMOKE_FAILED"
              : "RUNTIME_SMOKE_FAILED"
            : "RUNTIME_PROFILE_VERIFIED",
    resultSemantics: "runtime_integration_non_certifying",
    profile,
    profileVerification,
    suiteId: contracts.suite.suiteId,
    suiteFingerprint: contracts.suite.suiteFingerprint,
    runtimeTurns,
  };
  const report = {
    ...body,
    reportFingerprint: governanceFingerprint(body),
  };
  const outputRoot = path.resolve(
    process.env.EA_SKILL_EVAL_RUNTIME_REPORT_DIR ||
      path.join(
        process.cwd(),
        "reports",
        "skill-quality-evaluation-runtime",
        new Date().toISOString().replace(/[-:.]/gu, "")
      )
  );
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(
    path.join(outputRoot, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  writeFileSync(path.join(outputRoot, "report.md"), markdown(report));
  console.log(JSON.stringify({ status: report.status, outputRoot, reportFingerprint: report.reportFingerprint }, null, 2));
  if (!["RUNTIME_PROFILE_VERIFIED", "RUNTIME_SMOKE_VERIFIED", "RUNTIME_ARM_SMOKE_VERIFIED"].includes(report.status)) {
    process.exitCode = 1;
  }
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbConnection();
  });
