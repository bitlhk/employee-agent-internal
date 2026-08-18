import "dotenv/config";
import { runSmartAuditRolePackControlledScenarios } from "../server/_core/smart-audit-role-pack-scenarios";
import { runSmartAuditRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { persistReferenceRolePackScenarioReport } from "../server/_core/reference-role-pack-release";

const report = await runSmartAuditRolePackControlledScenarios();
const persist = process.argv.includes("--persist");
if (persist) {
  const { closeDbConnection } = await import("../server/db/connection");
  try {
    await persistReferenceRolePackScenarioReport(report, runSmartAuditRolePackContractChecks());
  } finally {
    await closeDbConnection();
  }
}
console.log(JSON.stringify({ ...report, persisted: persist }, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
