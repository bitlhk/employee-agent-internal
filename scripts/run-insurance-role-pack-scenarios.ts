import "dotenv/config";
import { runInsuranceRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { persistReferenceRolePackScenarioReport } from "../server/_core/reference-role-pack-release";
import { runInsuranceRolePackControlledScenarios } from "../server/_core/insurance-role-pack-scenarios";

const report = await runInsuranceRolePackControlledScenarios();
const persist = process.argv.includes("--persist");
if (persist) {
  const { closeDbConnection } = await import("../server/db/connection");
  try {
    await persistReferenceRolePackScenarioReport(report, runInsuranceRolePackContractChecks());
  } finally {
    await closeDbConnection();
  }
}
console.log(JSON.stringify({ ...report, persisted: persist }, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
