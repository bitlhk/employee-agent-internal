import { describe, expect, it } from "vitest";
import type { ProviderCertificationProfileV1 } from "../../shared/provider-certification";
import {
  certificationStatusAfterConfigChange,
  evaluateProviderCertification,
  type ProviderCertificationEvidenceV1,
} from "./provider-certification";

const profile: ProviderCertificationProfileV1 = {
  schema: "ea.provider-certification-profile.v1",
  profileId: "test",
  profileVersion: "1",
  providerType: "llamaindex",
  contextQualityBaselineFingerprint: "baseline",
  datasetPath: "golden.json",
  rolePackId: "wealth",
  roleTemplate: "wealth-manager",
  topK: 6,
  repeat: 3,
  warmup: 1,
  thresholds: {
    minHitRate: 0.9,
    minDocumentRecall: 0.9,
    minVersionAccuracy: 1,
    maxForbiddenSourceRate: 0,
    minPositionHitRate: 0.9,
    minMrr: 0.8,
    maxEligibilityViolations: 0,
    minContextItemCompleteness: 1,
    maxErrorRate: 0,
    maxEmptyResultRate: 0,
    maxLatencyP95Ms: 2000,
    maxLatencyP99Ms: 3000,
  },
};

const passingEvidence: ProviderCertificationEvidenceV1 = {
  baselineFingerprint: "baseline",
  expertConfirmed: true,
  providerConfigFingerprint: "config",
  resourceRefFingerprint: "resource",
  indexVersion: "index-v1",
  parserVersion: "2.1",
  retrieval: {
    hitRate: 1,
    documentRecall: 1,
    versionAccuracy: 1,
    forbiddenSourceRate: 0,
    positionHitRate: 1,
    mrr: 1,
    latencyP95Ms: 100,
    latencyP99Ms: 120,
    errorRate: 0,
    emptyResultRate: 0,
    eligibility: { pushdownApplied: true, violations: [] },
  },
  governance: { passed: true, scenarioCount: 6, failedScenarios: [] },
  contextContract: {
    completeness: 1,
    normalizedItemCount: 10,
    invalidItemCount: 0,
    evidenceStagesSeparated: true,
  },
};

describe("Provider Certification V1", () => {
  it("certifies only when every retrieval and governance gate passes", () => {
    const report = evaluateProviderCertification({ profile, evidence: passingEvidence });
    expect(report.status).toBe("certified");
    expect(report.failureCodes).toEqual([]);
  });

  it("does not lower the baseline when a provider misses the correct version", () => {
    const report = evaluateProviderCertification({
      profile,
      evidence: {
        ...passingEvidence,
        retrieval: { ...passingEvidence.retrieval, versionAccuracy: 0.85 },
      },
    });
    expect(report.status).toBe("evaluated");
    expect(report.failureCodes).toContain("VERSION_ACCURACY");
  });

  it("suspends an existing certification when provider configuration drifts", () => {
    expect(certificationStatusAfterConfigChange({
      status: "certified",
      certifiedConfigFingerprint: "old",
      currentConfigFingerprint: "new",
    })).toBe("suspended");
  });
});
