import { readFileSync } from "node:fs";
import path from "node:path";
import type { ContextGoldenSetV1 } from "../shared/context-governance";
import type { ProviderCertificationProfileV1, ProviderCertificationReportV1 } from "../shared/provider-certification";
import { runWealthContextGovernanceContractChecks } from "../server/_core/context-governance-contracts";
import { governanceFingerprint } from "../server/_core/governance/contracts";
import { planKnowledgeQueries } from "../server/_core/knowledge-query-planner";

const PROFILE_PATH = "examples/wealth-manager-reference-role-pack/eval/llamaindex-provider-certification.v1.json";
const BASELINE_PATH = "examples/wealth-manager-reference-role-pack/eval/llamaindex-provider-certification-baseline.v1.json";

type BaselineRecord = {
  schema: "ea.provider-certification-baseline.v1";
  baselineId: string;
  status: "certified";
  providerType: "llamaindex";
  performanceScope: Record<string, unknown>;
  providerSnapshot: Record<string, unknown> & {
    indexVersion: string;
    parserVersion: string;
    queryPlanner?: { fingerprint?: string };
  };
  report: ProviderCertificationReportV1;
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.resolve(file), "utf8")) as T;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const baseline = readJson<BaselineRecord>(BASELINE_PATH);
  const profile = readJson<ProviderCertificationProfileV1>(PROFILE_PATH);
  const golden = readJson<ContextGoldenSetV1>(profile.datasetPath);
  const contracts = runWealthContextGovernanceContractChecks(process.cwd(), { requireExpertConfirmed: true });
  const plans = await Promise.all(golden.cases.map(async item => ({
    caseId: item.caseId,
    ...(await planKnowledgeQueries(item.query, { deterministicOnly: true })),
  })));
  const reportBody = { ...baseline.report } as Record<string, unknown>;
  delete reportBody.certificationFingerprint;

  invariant(baseline.schema === "ea.provider-certification-baseline.v1", "Unsupported Provider Certification baseline schema");
  invariant(baseline.status === "certified" && baseline.report.status === "certified", "Provider baseline is not certified");
  invariant(baseline.report.failureCodes.length === 0 && baseline.report.checks.every(item => item.passed), "Provider baseline contains failed gates");
  invariant(contracts.status === "PASS", `Context Quality contracts failed: ${contracts.errors.join("; ")}`);
  invariant(baseline.report.contextQualityBaselineFingerprint === contracts.contractFingerprint, "Context Quality Baseline fingerprint drifted");
  invariant(baseline.report.contextQualityBaselineFingerprint === profile.contextQualityBaselineFingerprint, "Profile targets a different Context Quality Baseline");
  invariant(baseline.report.certificationProfileFingerprint === governanceFingerprint(profile), "Certification profile fingerprint drifted");
  invariant(baseline.providerSnapshot.queryPlanner?.fingerprint === governanceFingerprint(plans), "Deterministic Query Plan fingerprint drifted");
  invariant(baseline.report.providerConfigFingerprint === governanceFingerprint(baseline.providerSnapshot), "Provider Snapshot fingerprint is inconsistent");
  invariant(baseline.report.certificationFingerprint === governanceFingerprint(reportBody), "Certification report fingerprint is inconsistent");
  invariant(baseline.report.indexVersion === baseline.providerSnapshot.indexVersion, "Certified index version is inconsistent");
  invariant(baseline.report.parserVersion === baseline.providerSnapshot.parserVersion, "Certified parser version is inconsistent");

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    schema: baseline.schema,
    status: "PASS",
    baselineId: baseline.baselineId,
    provider: baseline.providerType,
    certificationId: baseline.report.certificationId,
    evaluatedAt: baseline.report.evaluatedAt,
    contextQualityBaselineFingerprint: baseline.report.contextQualityBaselineFingerprint,
    providerConfigFingerprint: baseline.report.providerConfigFingerprint,
    certificationFingerprint: baseline.report.certificationFingerprint,
    performanceScope: baseline.performanceScope,
  }, null, 2));
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
