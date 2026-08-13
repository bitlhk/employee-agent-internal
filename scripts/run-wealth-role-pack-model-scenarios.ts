import "dotenv/config";
import { runWealthRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { runWealthRolePackModelScenarios } from "../server/_core/wealth-role-pack-model-scenarios";

const { closeDbConnection } = await import("../server/db/connection");
try {
  const report = await runWealthRolePackModelScenarios();
  const persist = process.argv.includes("--persist");
  if (persist) {
    const { persistRolePackRelease } = await import("../server/db/role-pack-releases");
    await persistRolePackRelease({
      releaseId: report.releaseCandidateId,
      rolePackId: report.rolePackId,
      evalSuiteVersion: report.evalSuiteVersion,
      assetSetFingerprint: report.assetSetFingerprint,
      verificationLevel: "model_scenario",
      status: report.status === "PASS" ? "verified" : "failed",
      contractReport: runWealthRolePackContractChecks(),
      scenarioReport: report,
    });
  }
  const output = process.argv.includes("--summary")
    ? {
        status: report.status,
        releaseCandidateId: report.releaseCandidateId,
        evalSuiteVersion: report.evalSuiteVersion,
        scenarioCount: report.scenarioCount,
        passedScenarioCount: report.passedScenarioCount,
        models: report.models,
        totalElapsedMs: report.totalElapsedMs,
        errors: report.errors,
        persisted: persist,
      }
    : { ...report, persisted: persist };
  console.log(JSON.stringify(output, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
} finally {
  await closeDbConnection();
}
