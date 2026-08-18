import "dotenv/config";
import { runPostLoanRiskRolePackControlledScenarios } from "../server/_core/post-loan-risk-role-pack-scenarios";
import { runPostLoanRiskRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { persistReferenceRolePackScenarioReport } from "../server/_core/reference-role-pack-release";

const report = await runPostLoanRiskRolePackControlledScenarios();
const persist = process.argv.includes("--persist");
if (persist) {
  const { closeDbConnection } = await import("../server/db/connection");
  try {
    await persistReferenceRolePackScenarioReport(report, runPostLoanRiskRolePackContractChecks());
  } finally {
    await closeDbConnection();
  }
}
console.log(JSON.stringify({ ...report, persisted: persist }, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
