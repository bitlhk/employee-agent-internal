import { persistRolePackRelease } from "../db/role-pack-releases";

type ContractReport = {
  status: string;
  rolePackId: string;
  evalSuiteVersion: string;
  releaseCandidateId: string;
  assetSetFingerprint: string;
};

type ScenarioReport = ContractReport & {
  executionLevel: "controlled_scenario" | "model_scenario";
};

export async function persistReferenceRolePackScenarioReport(
  report: ScenarioReport,
  contractReport: ContractReport,
): Promise<void> {
  if (report.rolePackId !== contractReport.rolePackId
    || report.evalSuiteVersion !== contractReport.evalSuiteVersion
    || report.assetSetFingerprint !== contractReport.assetSetFingerprint) {
    throw new Error("Role Pack scenario report does not match its contract report");
  }
  await persistRolePackRelease({
    releaseId: report.releaseCandidateId,
    rolePackId: report.rolePackId,
    evalSuiteVersion: report.evalSuiteVersion,
    assetSetFingerprint: report.assetSetFingerprint,
    verificationLevel: report.executionLevel,
    status: report.status === "PASS" && contractReport.status === "PASS" ? "verified" : "failed",
    contractReport: contractReport as unknown as Record<string, unknown>,
    scenarioReport: report as unknown as Record<string, unknown>,
  });
}
