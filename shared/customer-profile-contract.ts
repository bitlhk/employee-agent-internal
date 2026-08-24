export type CustomerProfileContractStatusV1 =
  | "engineering_proposed"
  | "domain_reviewing"
  | "domain_confirmed";

export type CustomerProfileFieldSensitivityV1 =
  | "internal"
  | "sensitive"
  | "restricted";

export type CustomerProfileFieldExposureV1 =
  | "raw"
  | "masked"
  | "derived"
  | "summary";

export type CustomerProfileProjectionAccessV1 =
  | "allow"
  | "conditional"
  | "deny";

export type CustomerProfileDomainReviewV1 = {
  status:
    | "proposed"
    | "domain_reviewing"
    | "domain_confirmed"
    | "needs_resolution";
  reviewerId?: string;
  reviewerRole?: string;
  reviewedAt?: string;
  reviewComment?: string;
  groundTruthVersion?: string;
};

export type CustomerProfileFieldDefinitionV1 = {
  path: string;
  dataType:
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "string_array"
    | "object_array";
  sensitivity: CustomerProfileFieldSensitivityV1;
  description: string;
  provenanceRequired: true;
};

export type CustomerProfileContractV1 = {
  schemaVersion: "ea.customer-profile-contract.v1";
  contractVersion: string;
  status: CustomerProfileContractStatusV1;
  canonicalLogicalContextId: "customer_profile";
  subjectType: "individual_customer";
  identityRule: {
    stableSubjectIdRequired: true;
    heuristicIdentityMergeAllowed: false;
    displayNameIsIdentityProof: false;
  };
  provenanceRule: {
    fieldLevelRequired: true;
    requiredAttributes: string[];
  };
  conflictRule: {
    modelMayResolveEnterpriseFacts: false;
    newestValueAutomaticallyWins: false;
    unresolvedConflictStatus: "BLOCKED";
  };
  missingDataRule: {
    requiredFieldStatus: "BLOCKED";
    optionalFieldStatus: "DEGRADED";
    modelMayFillMissingFacts: false;
  };
  fields: CustomerProfileFieldDefinitionV1[];
  domainReview: CustomerProfileDomainReviewV1;
};

export type CustomerProfileProjectionFieldV1 = {
  path: string;
  exposure: CustomerProfileFieldExposureV1;
};

export type CustomerProfileTaskRequirementV1 = {
  taskIds: string[];
  requiredFields: string[];
};

export type CustomerProfilePurposeProjectionV1 = {
  projectionId: string;
  projectionVersion: string;
  rolePackId: string;
  roleTemplate: string;
  purposeId: string;
  access: CustomerProfileProjectionAccessV1;
  fields: CustomerProfileProjectionFieldV1[];
  requiredCoreFields: string[];
  taskRequirements: CustomerProfileTaskRequirementV1[];
  conditions: string[];
  alternativeLogicalContextId?: string;
  decisionReason: string;
  review: CustomerProfileDomainReviewV1;
};

export type CustomerProfileProjectionSetV1 = {
  schemaVersion: "ea.customer-profile-purpose-projections.v1";
  projectionSetVersion: string;
  status: CustomerProfileContractStatusV1;
  canonicalLogicalContextId: "customer_profile";
  projections: CustomerProfilePurposeProjectionV1[];
};

export type CustomerProfileSourceMappingV1 = {
  sourcePath: string;
  targetPath: string;
  transform: string;
};

export type CustomerProfileSourceContractV1 = {
  sourceContractId: string;
  sourceSystem: string;
  sourceKind: "mcp";
  environment: "local_demo" | "remote_demo" | "production";
  productionReady: boolean;
  stableSubjectPaths: string[];
  mappings: CustomerProfileSourceMappingV1[];
  excludedSourceRoots: string[];
  providerGaps: string[];
};

export type CustomerProfileSourceMappingSetV1 = {
  schemaVersion: "ea.customer-profile-source-mappings.v1";
  mappingSetVersion: string;
  status: CustomerProfileContractStatusV1;
  canonicalLogicalContextId: "customer_profile";
  sources: CustomerProfileSourceContractV1[];
};

export type CustomerProfileSourceImplementationStatusV1 =
  | "engineering_candidate"
  | "environment_verified"
  | "production_approved";

export type CustomerProfileSourceImplementationContractV1 = {
  schemaVersion: "ea.customer-profile-source-implementation-contract.v1";
  contractVersion: string;
  status: CustomerProfileSourceImplementationStatusV1;
  sourceContractId: string;
  canonicalLogicalContextId: "customer_profile";
  baseline: {
    businessContractFingerprint: string;
    sourceRemediationPlanFingerprint: string;
  };
  invocation: {
    toolName: string;
    allowedArguments: ["subjectId"];
    forbiddenArguments: string[];
    sourceAuthorizationAttributes: string[];
    purposeProjectionOwner: "ea_customer_profile_provider";
  };
  response: {
    schemaPath: string;
    requiredRemediationFields: string[];
    stableSubjectRequired: true;
    fieldLevelProvenanceRequired: true;
    authoritativeBusinessAsOfRequired: true;
    rowAuthorizationEvidenceRequired: true;
    rawSourcePayloadAllowed: false;
  };
  activationPolicy: {
    runtimeActivationAllowed: false;
    autoAuthorize: false;
    activeSourceMappingMayChange: false;
    productionBindingMayChange: false;
    requiresEnvironmentEvidence: true;
    requiresNewAuthorizationFingerprint: true;
    requiresFullGateBRerun: true;
    requiresPromotionReview: true;
  };
};

export type CustomerProfileSourceAuthorizationEvidenceV1 = {
  organizationId: string;
  principalFingerprint: string;
  authorizationSnapshotId: string;
  authorizationFingerprint: string;
  subjectInScope: true;
  rowScopeApplied: true;
  evaluatedAt: string;
};

export type CustomerProfileSourceEnvelopeV1 = {
  schemaVersion: "ea.customer-profile-source-envelope.v1";
  sourceContractId: string;
  sourceContractVersion: string;
  sourceContractFingerprint: string;
  sourceSystem: string;
  subjectId: string;
  sourceRecordRef: string;
  businessAsOf: string;
  observedAt: string;
  authorizationEvidence: CustomerProfileSourceAuthorizationEvidenceV1;
  fields: Array<{
    path: string;
    value: unknown;
    provenance: CustomerProfileFieldProvenanceV1;
  }>;
  deniedFields: Array<{
    path: string;
    reasonCode: string;
  }>;
  sourceResultFingerprint: string;
};

export type CustomerProfileFieldProvenanceV1 = {
  sourceSystem: string;
  sourceRecordRef: string;
  asOf: string;
  observedAt: string;
  mappingRuleVersion: string;
};

export type CustomerProfileProjectedFieldV1 = {
  path: string;
  value: unknown;
  exposure: CustomerProfileFieldExposureV1;
  provenance: CustomerProfileFieldProvenanceV1;
};

export type CustomerProfileProjectionResultV1 = {
  schemaVersion: "ea.customer-profile-projection-result.v1";
  logicalContextId: "customer_profile";
  projectionId: string;
  projectionVersion: string;
  taskId?: string;
  subjectId: string;
  purposeId: string;
  status: "READY" | "DEGRADED" | "BLOCKED";
  reasonCodes: string[];
  fields: CustomerProfileProjectedFieldV1[];
  missingRequiredFields: string[];
  conflictingFields: string[];
  invalidFields: string[];
  invalidProvenanceFields: string[];
  appliedPurposeFilter: true;
  filteredFieldCount: number;
  sourceEvidence: Array<{
    sourceContractId: string;
    sourceSystem: string;
    sourceRecordRef: string;
    asOf: string;
    productionReady: boolean;
    assuranceLevel: "candidate" | "demo" | "production";
    providerGapCount: number;
    resultFingerprint: string;
  }>;
  businessContractFingerprint: string;
  principalFingerprint: string;
  generatedAt: string;
};
