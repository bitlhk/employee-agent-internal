import "dotenv/config";
import { runWealthRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { callEaAssistantModelWithConfig, resolveEaAssistantModelConfig } from "../server/_core/ea-assistant-model";
import { runWealthRolePackModelScenarios, runWealthRolePackMultiModelScenarios } from "../server/_core/wealth-role-pack-model-scenarios";

const { closeDbConnection } = await import("../server/db/connection");
try {
  const modelArg = process.argv.find(argument => argument.startsWith("--models="));
  const modelIds = modelArg?.slice("--models=".length).split(",").map(value => value.trim()).filter(Boolean) || [];
  const report = modelIds.length > 0
    ? await (async () => {
        const base = await resolveEaAssistantModelConfig();
        return runWealthRolePackMultiModelScenarios({
          models: modelIds.map(modelId => ({
            modelId,
            invokeModel: options => callEaAssistantModelWithConfig({
              ...base,
              model: modelId,
              tokenParam: /^openpangu-/i.test(modelId) ? "max_tokens" : "max_completion_tokens",
            }, options),
          })),
        });
      })()
    : await runWealthRolePackModelScenarios();
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
        ...("scenarioCount" in report ? {
          scenarioCount: report.scenarioCount,
          passedScenarioCount: report.passedScenarioCount,
          models: report.models,
          totalElapsedMs: report.totalElapsedMs,
        } : {
          modelCount: report.modelCount,
          passedModelCount: report.passedModelCount,
        }),
        errors: report.errors,
        persisted: persist,
      }
    : { ...report, persisted: persist };
  console.log(JSON.stringify(output, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
} finally {
  await closeDbConnection();
}
