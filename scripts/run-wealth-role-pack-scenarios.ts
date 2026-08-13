import "dotenv/config";
import { runWealthRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { runWealthRolePackControlledScenarios } from "../server/_core/wealth-role-pack-scenarios";

const report = await runWealthRolePackControlledScenarios();
const persist = process.argv.includes("--persist");
if (persist) {
  const { persistRolePackRelease } = await import("../server/db/role-pack-releases");
  const { closeDbConnection } = await import("../server/db/connection");
  try {
    const contract = runWealthRolePackContractChecks();
    await persistRolePackRelease({
      releaseId: report.releaseCandidateId,
      rolePackId: report.rolePackId,
      evalSuiteVersion: report.evalSuiteVersion,
      assetSetFingerprint: report.assetSetFingerprint,
      verificationLevel: "controlled_scenario",
      status: report.status === "PASS" ? "verified" : "failed",
      contractReport: contract,
      scenarioReport: report,
    });
  } finally {
    await closeDbConnection();
  }
}
console.log(JSON.stringify({ ...report, persisted: persist }, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
