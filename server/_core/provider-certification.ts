import type {
  ProviderCertificationCheckV1,
  ProviderCertificationProfileV1,
  ProviderCertificationReportV1,
  ProviderCertificationStatusV1,
} from "../../shared/provider-certification";
import { governanceFingerprint } from "./governance/contracts";

type RetrievalCertificationMetrics = {
  hitRate: number;
  documentRecall: number;
  versionAccuracy: number | null;
  forbiddenSourceRate: number | null;
  positionHitRate: number | null;
  mrr: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  errorRate: number;
  emptyResultRate: number;
  eligibility: {
    pushdownApplied: boolean;
    violations: string[];
  };
};

export type ProviderCertificationEvidenceV1 = {
  baselineFingerprint: string;
  expertConfirmed: boolean;
  providerConfigFingerprint: string;
  resourceRefFingerprint: string;
  indexVersion: string;
  parserVersion: string;
  retrieval: RetrievalCertificationMetrics;
  governance: {
    passed: boolean;
    scenarioCount: number;
    failedScenarios: string[];
  };
  contextContract: {
    completeness: number;
    normalizedItemCount: number;
    invalidItemCount: number;
    evidenceStagesSeparated: boolean;
  };
};

function check(
  layer: ProviderCertificationCheckV1["layer"],
  code: string,
  passed: boolean,
  actual: ProviderCertificationCheckV1["actual"],
  expected: ProviderCertificationCheckV1["expected"],
): ProviderCertificationCheckV1 {
  return { layer, code, passed, actual, expected };
}

export function evaluateProviderCertification(input: {
  profile: ProviderCertificationProfileV1;
  evidence: ProviderCertificationEvidenceV1;
  evaluatedAt?: string;
}): ProviderCertificationReportV1 {
  const { profile, evidence } = input;
  const thresholds = profile.thresholds;
  const checks: ProviderCertificationCheckV1[] = [
    check("baseline", "BASELINE_FINGERPRINT_MATCH", evidence.baselineFingerprint === profile.contextQualityBaselineFingerprint, evidence.baselineFingerprint, profile.contextQualityBaselineFingerprint),
    check("baseline", "EXPERT_CONFIRMATION_REQUIRED", evidence.expertConfirmed, evidence.expertConfirmed, true),
    check("retrieval", "HIT_RATE", evidence.retrieval.hitRate >= thresholds.minHitRate, evidence.retrieval.hitRate, thresholds.minHitRate),
    check("retrieval", "DOCUMENT_RECALL", evidence.retrieval.documentRecall >= thresholds.minDocumentRecall, evidence.retrieval.documentRecall, thresholds.minDocumentRecall),
    check("retrieval", "VERSION_ACCURACY", evidence.retrieval.versionAccuracy !== null && evidence.retrieval.versionAccuracy >= thresholds.minVersionAccuracy, evidence.retrieval.versionAccuracy, thresholds.minVersionAccuracy),
    check("retrieval", "FORBIDDEN_SOURCE_RATE", evidence.retrieval.forbiddenSourceRate !== null && evidence.retrieval.forbiddenSourceRate <= thresholds.maxForbiddenSourceRate, evidence.retrieval.forbiddenSourceRate, thresholds.maxForbiddenSourceRate),
    check("retrieval", "POSITION_HIT_RATE", evidence.retrieval.positionHitRate !== null && evidence.retrieval.positionHitRate >= thresholds.minPositionHitRate, evidence.retrieval.positionHitRate, thresholds.minPositionHitRate),
    check("retrieval", "MRR", evidence.retrieval.mrr >= thresholds.minMrr, evidence.retrieval.mrr, thresholds.minMrr),
    check("governance", "ELIGIBILITY_PUSHDOWN", evidence.retrieval.eligibility.pushdownApplied, evidence.retrieval.eligibility.pushdownApplied, true),
    check("governance", "ELIGIBILITY_VIOLATIONS", evidence.retrieval.eligibility.violations.length <= thresholds.maxEligibilityViolations, evidence.retrieval.eligibility.violations.length, thresholds.maxEligibilityViolations),
    check("governance", "GOVERNANCE_SCENARIOS", evidence.governance.passed, evidence.governance.failedScenarios.length, 0),
    check("context_contract", "CONTEXT_ITEM_COMPLETENESS", evidence.contextContract.completeness >= thresholds.minContextItemCompleteness, evidence.contextContract.completeness, thresholds.minContextItemCompleteness),
    check("context_contract", "EVIDENCE_STAGES_SEPARATED", evidence.contextContract.evidenceStagesSeparated, evidence.contextContract.evidenceStagesSeparated, true),
    check("operations", "ERROR_RATE", evidence.retrieval.errorRate <= thresholds.maxErrorRate, evidence.retrieval.errorRate, thresholds.maxErrorRate),
    check("operations", "EMPTY_RESULT_RATE", evidence.retrieval.emptyResultRate <= thresholds.maxEmptyResultRate, evidence.retrieval.emptyResultRate, thresholds.maxEmptyResultRate),
    check("operations", "LATENCY_P95", evidence.retrieval.latencyP95Ms <= thresholds.maxLatencyP95Ms, evidence.retrieval.latencyP95Ms, thresholds.maxLatencyP95Ms),
    check("operations", "LATENCY_P99", evidence.retrieval.latencyP99Ms <= thresholds.maxLatencyP99Ms, evidence.retrieval.latencyP99Ms, thresholds.maxLatencyP99Ms),
  ];
  const failureCodes = checks.filter(item => !item.passed).map(item => item.code);
  const body = {
    schema: "ea.provider-certification-report.v1" as const,
    certificationId: `pcert_${governanceFingerprint({
      profileId: profile.profileId,
      baseline: evidence.baselineFingerprint,
      providerConfig: evidence.providerConfigFingerprint,
    }).slice(0, 20)}`,
    status: failureCodes.length ? "evaluated" as const : "certified" as const,
    providerType: profile.providerType,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    certificationProfileFingerprint: governanceFingerprint(profile),
    contextQualityBaselineFingerprint: evidence.baselineFingerprint,
    providerConfigFingerprint: evidence.providerConfigFingerprint,
    resourceRefFingerprint: evidence.resourceRefFingerprint,
    indexVersion: evidence.indexVersion,
    parserVersion: evidence.parserVersion,
    evaluatedAt: input.evaluatedAt || new Date().toISOString(),
    checks,
    metrics: {
      retrieval: evidence.retrieval,
      governance: evidence.governance,
      contextContract: evidence.contextContract,
    },
    failureCodes,
  };
  return {
    ...body,
    certificationFingerprint: governanceFingerprint(body),
  };
}

export function certificationStatusAfterConfigChange(input: {
  status: ProviderCertificationStatusV1;
  certifiedConfigFingerprint: string;
  currentConfigFingerprint: string;
}): ProviderCertificationStatusV1 {
  if (input.status !== "certified") return input.status;
  return input.certifiedConfigFingerprint === input.currentConfigFingerprint
    ? "certified"
    : "suspended";
}
