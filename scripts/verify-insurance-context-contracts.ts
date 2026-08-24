import { runInsuranceContextContractChecks } from "../server/_core/insurance-context-contracts";

const report = runInsuranceContextContractChecks(process.cwd(), {
  requireExpertConfirmed: process.argv.includes("--require-expert-confirmed"),
});

// eslint-disable-next-line no-console
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
