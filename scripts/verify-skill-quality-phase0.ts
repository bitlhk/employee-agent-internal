import { runSkillQualityPhase0ContractChecks } from "../server/_core/skill-quality-evaluation-contracts";

const report = runSkillQualityPhase0ContractChecks(process.cwd(), {
  requireLocalArtifacts: process.argv.includes("--require-local-artifacts"),
});

// This report is the immutable Phase 0 evidence consumed by CI and reviewers.
// eslint-disable-next-line no-console
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
