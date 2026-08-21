export const PROVIDER_CERTIFICATION_PROFILE_SCHEMA =
  "ea.provider-certification-profile.v1" as const;
export const PROVIDER_CERTIFICATION_REPORT_SCHEMA =
  "ea.provider-certification-report.v1" as const;

export type ProviderCertificationStatusV1 =
  | "candidate"
  | "evaluated"
  | "certified"
  | "suspended";

export type ProviderCertificationThresholdsV1 = {
  minHitRate: number;
  minDocumentRecall: number;
  minVersionAccuracy: number;
  maxForbiddenSourceRate: number;
  minPositionHitRate: number;
  minMrr: number;
  maxEligibilityViolations: number;
  minContextItemCompleteness: number;
  maxErrorRate: number;
  maxEmptyResultRate: number;
  maxLatencyP95Ms: number;
  maxLatencyP99Ms: number;
};

export type ProviderCertificationProfileV1 = {
  schema: typeof PROVIDER_CERTIFICATION_PROFILE_SCHEMA;
  profileId: string;
  profileVersion: string;
  providerType: "llamaindex";
  contextQualityBaselineFingerprint: string;
  datasetPath: string;
  rolePackId: string;
  roleTemplate: string;
  topK: number;
  repeat: number;
  warmup: number;
  thresholds: ProviderCertificationThresholdsV1;
};

export type ProviderCertificationCheckV1 = {
  layer: "baseline" | "retrieval" | "governance" | "context_contract" | "operations";
  code: string;
  passed: boolean;
  actual: string | number | boolean | null;
  expected: string | number | boolean;
};

export type ProviderCertificationReportV1 = {
  schema: typeof PROVIDER_CERTIFICATION_REPORT_SCHEMA;
  certificationId: string;
  status: ProviderCertificationStatusV1;
  providerType: "llamaindex";
  profileId: string;
  profileVersion: string;
  certificationProfileFingerprint: string;
  contextQualityBaselineFingerprint: string;
  providerConfigFingerprint: string;
  resourceRefFingerprint: string;
  indexVersion: string;
  parserVersion: string;
  evaluatedAt: string;
  checks: ProviderCertificationCheckV1[];
  metrics: Record<string, unknown>;
  failureCodes: string[];
  certificationFingerprint: string;
};
