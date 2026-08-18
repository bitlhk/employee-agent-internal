import "dotenv/config";
import { runWealthRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { persistReferenceRolePackScenarioReport } from "../server/_core/reference-role-pack-release";
import { runWealthRolePackControlledScenarios } from "../server/_core/wealth-role-pack-scenarios";

const report = await runWealthRolePackControlledScenarios();
const persist = process.argv.includes("--persist");
if (persist) {
  const { closeDbConnection } = await import("../server/db/connection");
  try {
    const contract = runWealthRolePackContractChecks();
    await persistReferenceRolePackScenarioReport(report, contract);
  } finally {
    await closeDbConnection();
  }
}
console.log(JSON.stringify({ ...report, persisted: persist }, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
