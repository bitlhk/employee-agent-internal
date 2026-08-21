import { runWealthContextGovernanceContractChecks } from "../server/_core/context-governance-contracts";

const report = runWealthContextGovernanceContractChecks(process.cwd(), {
  requireExpertConfirmed: process.argv.includes("--require-expert-confirmed"),
});
// CLI report is the release evidence consumed by CI and reviewers.
// eslint-disable-next-line no-console
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
