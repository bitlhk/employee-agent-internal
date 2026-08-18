import { runPostLoanRiskRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";

const report = runPostLoanRiskRolePackContractChecks();
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
