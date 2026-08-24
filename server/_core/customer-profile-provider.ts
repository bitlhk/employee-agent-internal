import type {
  CustomerProfileProjectedFieldV1,
  CustomerProfileProjectionResultV1,
  CustomerProfilePurposeProjectionV1,
} from "../../shared/customer-profile-contract";
import {
  loadCustomerProfileContracts,
  runCustomerProfileContractChecks,
} from "./customer-profile-contracts";
import {
  customerProfileSourceFingerprint,
  type NormalizedCustomerProfileSourceV1,
} from "./customer-profile-source-adapters";
import { governanceFingerprint } from "./governance/contracts";

export type CustomerProfileProviderReasonCodeV1 =
  | "ROLE_PROJECTION_NOT_DEFINED"
  | "ROLE_PROJECTION_DENIED"
  | "PRINCIPAL_NOT_AUTHORIZED"
  | "SUBJECT_OUT_OF_SCOPE"
  | "AUDIT_CASE_SCOPE_REQUIRED"
  | "CUSTOMER_PROFILE_SOURCE_MISSING"
  | "CUSTOMER_PROFILE_SUBJECT_UNRESOLVED"
  | "CUSTOMER_PROFILE_SUBJECT_MISMATCH"
  | "CUSTOMER_PROFILE_FIELD_CONFLICT"
  | "CUSTOMER_PROFILE_FIELD_TYPE_INVALID"
  | "CUSTOMER_PROFILE_PROVENANCE_MISSING"
  | "CUSTOMER_PROFILE_SOURCE_FINGERPRINT_INVALID"
  | "CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING"
  | "CUSTOMER_PROFILE_PROVIDER_NOT_PRODUCTION_READY"
  | "CUSTOMER_PROFILE_PROVIDER_NOT_DEMO_READY"
  | "CUSTOMER_PROFILE_OPTIONAL_FIELD_MISSING";

export type CustomerProfileProviderInputV1 = {
  roleTemplate: string;
  taskId?: string;
  requestedSubjectId: string;
  principalFingerprint: string;
  principalAuthorized: boolean;
  subjectInScope: boolean;
  auditCaseScopeVerified?: boolean;
  auditCaseSubjectMatches?: boolean;
  sources: NormalizedCustomerProfileSourceV1[];
  requiredAssuranceLevel?: "demo" | "production";
  now?: Date;
  root?: string;
};

function projectionForRole(
  roleTemplate: string,
  root: string
): CustomerProfilePurposeProjectionV1 | null {
  return (
    loadCustomerProfileContracts(root).projections.projections.find(
      item => item.roleTemplate === roleTemplate
    ) || null
  );
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function sameValue(left: unknown, right: unknown): boolean {
  return governanceFingerprint(left) === governanceFingerprint(right);
}

function valueMatches(dataType: string, value: unknown): boolean {
  if (dataType === "string") return typeof value === "string";
  if (dataType === "integer") return Number.isInteger(value);
  if (dataType === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (dataType === "boolean") return typeof value === "boolean";
  if (dataType === "string_array")
    return (
      Array.isArray(value) && value.every(item => typeof item === "string")
    );
  if (dataType === "object_array")
    return (
      Array.isArray(value) &&
      value.every(
        item =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    );
  return false;
}

function sourceEvidence(sources: NormalizedCustomerProfileSourceV1[]) {
  return sources.map(source => ({
    sourceContractId: source.sourceContractId,
    sourceSystem: source.sourceSystem,
    sourceRecordRef: source.sourceRecordRef,
    asOf: source.asOf,
    productionReady: source.productionReady,
    assuranceLevel:
      source.assuranceLevel ||
      (source.productionReady ? "production" : "candidate"),
    providerGapCount: source.providerGaps.length,
    resultFingerprint: source.resultFingerprint,
  }));
}

function blockedResult(input: {
  projection: CustomerProfilePurposeProjectionV1 | null;
  request: CustomerProfileProviderInputV1;
  reasonCodes: CustomerProfileProviderReasonCodeV1[];
  businessContractFingerprint: string;
  conflictingFields?: string[];
  invalidFields?: string[];
  invalidProvenanceFields?: string[];
  missingRequiredFields?: string[];
  filteredFieldCount?: number;
}): CustomerProfileProjectionResultV1 {
  return {
    schemaVersion: "ea.customer-profile-projection-result.v1",
    logicalContextId: "customer_profile",
    projectionId: input.projection?.projectionId || "unresolved",
    projectionVersion: input.projection?.projectionVersion || "0",
    ...(input.request.taskId ? { taskId: input.request.taskId } : {}),
    subjectId: input.request.requestedSubjectId,
    purposeId: input.projection?.purposeId || "unresolved",
    status: "BLOCKED",
    reasonCodes: unique(input.reasonCodes),
    fields: [],
    missingRequiredFields: unique(input.missingRequiredFields || []),
    conflictingFields: unique(input.conflictingFields || []),
    invalidFields: unique(input.invalidFields || []),
    invalidProvenanceFields: unique(input.invalidProvenanceFields || []),
    appliedPurposeFilter: true,
    filteredFieldCount: input.filteredFieldCount || 0,
    sourceEvidence: sourceEvidence(input.request.sources),
    businessContractFingerprint: input.businessContractFingerprint,
    principalFingerprint: input.request.principalFingerprint,
    generatedAt: (input.request.now || new Date()).toISOString(),
  };
}

export function projectCustomerProfile(
  input: CustomerProfileProviderInputV1
): CustomerProfileProjectionResultV1 {
  const root = input.root || process.cwd();
  const contractReport = runCustomerProfileContractChecks(root, {
    requireDomainConfirmed: true,
  });
  if (contractReport.status !== "PASS")
    throw new Error("CUSTOMER_PROFILE_CONTRACT_NOT_FROZEN");
  const businessContractFingerprint =
    contractReport.businessContractFingerprint;
  const contracts = loadCustomerProfileContracts(root);
  const projection = projectionForRole(input.roleTemplate, root);
  if (!projection) {
    return blockedResult({
      projection,
      request: input,
      reasonCodes: ["ROLE_PROJECTION_NOT_DEFINED"],
      businessContractFingerprint,
    });
  }
  if (projection.access === "deny") {
    return blockedResult({
      projection,
      request: input,
      reasonCodes: ["ROLE_PROJECTION_DENIED"],
      businessContractFingerprint,
    });
  }

  const conditionFailures: CustomerProfileProviderReasonCodeV1[] = [];
  if (!input.principalAuthorized)
    conditionFailures.push("PRINCIPAL_NOT_AUTHORIZED");
  if (!input.subjectInScope) conditionFailures.push("SUBJECT_OUT_OF_SCOPE");
  if (projection.access === "conditional") {
    if (!input.auditCaseScopeVerified)
      conditionFailures.push("AUDIT_CASE_SCOPE_REQUIRED");
    if (!input.auditCaseSubjectMatches)
      conditionFailures.push("SUBJECT_OUT_OF_SCOPE");
  }
  if (conditionFailures.length) {
    return blockedResult({
      projection,
      request: input,
      reasonCodes: conditionFailures,
      businessContractFingerprint,
    });
  }
  if (!input.sources.length) {
    return blockedResult({
      projection,
      request: input,
      reasonCodes: ["CUSTOMER_PROFILE_SOURCE_MISSING"],
      businessContractFingerprint,
    });
  }

  const requestedSubjectId = String(input.requestedSubjectId || "").trim();
  if (!requestedSubjectId || input.sources.some(source => !source.subjectId)) {
    return blockedResult({
      projection,
      request: input,
      reasonCodes: ["CUSTOMER_PROFILE_SUBJECT_UNRESOLVED"],
      businessContractFingerprint,
    });
  }
  if (input.sources.some(source => source.subjectId !== requestedSubjectId)) {
    return blockedResult({
      projection,
      request: input,
      reasonCodes: ["CUSTOMER_PROFILE_SUBJECT_MISMATCH"],
      businessContractFingerprint,
    });
  }

  const candidates = new Map<
    string,
    NormalizedCustomerProfileSourceV1["fields"]
  >();
  const invalidFields: string[] = [];
  const invalidProvenanceFields: string[] = [];
  const fieldDefinitions = new Map(
    contracts.contract.fields.map(field => [field.path, field])
  );
  for (const source of input.sources) {
    if (source.resultFingerprint !== customerProfileSourceFingerprint(source))
      invalidFields.push(`${source.sourceContractId}:resultFingerprint`);
    for (const field of source.fields) {
      const definition = fieldDefinitions.get(field.path);
      if (!definition || !valueMatches(definition.dataType, field.value))
        invalidFields.push(field.path);
      const provenance = field.provenance;
      if (
        !provenance.sourceSystem ||
        !provenance.sourceRecordRef ||
        !provenance.asOf ||
        !provenance.observedAt ||
        !provenance.mappingRuleVersion
      )
        invalidProvenanceFields.push(field.path);
      const rows = candidates.get(field.path) || [];
      rows.push(field);
      candidates.set(field.path, rows);
    }
  }
  const conflicts: string[] = [];
  const merged = new Map<
    string,
    NormalizedCustomerProfileSourceV1["fields"][number]
  >();
  for (const [fieldPath, rows] of candidates) {
    if (rows.some(row => !sameValue(row.value, rows[0]?.value))) {
      conflicts.push(fieldPath);
      continue;
    }
    if (rows[0]) merged.set(fieldPath, rows[0]);
  }

  const selectedPaths = new Set(projection.fields.map(field => field.path));
  const exposureByPath = new Map(
    projection.fields.map(field => [field.path, field.exposure])
  );
  const projectedFields: CustomerProfileProjectedFieldV1[] = [];
  for (const [fieldPath, field] of merged) {
    if (!selectedPaths.has(fieldPath) || conflicts.includes(fieldPath))
      continue;
    projectedFields.push({
      path: fieldPath,
      value: field.value,
      exposure: exposureByPath.get(fieldPath) || "summary",
      provenance: field.provenance,
    });
  }
  projectedFields.sort((left, right) => left.path.localeCompare(right.path));

  const taskRequired = projection.taskRequirements
    .filter(requirement =>
      input.taskId ? requirement.taskIds.includes(input.taskId) : false
    )
    .flatMap(requirement => requirement.requiredFields);
  const requiredPaths = unique([
    ...projection.requiredCoreFields,
    ...taskRequired,
  ]);
  const providedPaths = new Set(projectedFields.map(field => field.path));
  const missingRequiredFields = requiredPaths.filter(
    fieldPath => !providedPaths.has(fieldPath)
  );
  const optionalMissing = projection.fields
    .map(field => field.path)
    .filter(
      fieldPath =>
        !requiredPaths.includes(fieldPath) && !providedPaths.has(fieldPath)
    );
  const requiredAssuranceLevel = input.requiredAssuranceLevel || "production";
  const unreadySource = input.sources.some(source => {
    const assuranceLevel =
      source.assuranceLevel ||
      (source.productionReady ? "production" : "candidate");
    return requiredAssuranceLevel === "production"
      ? assuranceLevel !== "production" || !source.productionReady
      : !["demo", "production"].includes(assuranceLevel);
  });
  const reasonCodes: CustomerProfileProviderReasonCodeV1[] = [];
  if (conflicts.length) reasonCodes.push("CUSTOMER_PROFILE_FIELD_CONFLICT");
  if (invalidFields.some(field => field.endsWith(":resultFingerprint")))
    reasonCodes.push("CUSTOMER_PROFILE_SOURCE_FINGERPRINT_INVALID");
  if (invalidFields.some(field => !field.endsWith(":resultFingerprint")))
    reasonCodes.push("CUSTOMER_PROFILE_FIELD_TYPE_INVALID");
  if (invalidProvenanceFields.length)
    reasonCodes.push("CUSTOMER_PROFILE_PROVENANCE_MISSING");
  if (missingRequiredFields.length)
    reasonCodes.push("CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING");
  if (unreadySource)
    reasonCodes.push(
      requiredAssuranceLevel === "production"
        ? "CUSTOMER_PROFILE_PROVIDER_NOT_PRODUCTION_READY"
        : "CUSTOMER_PROFILE_PROVIDER_NOT_DEMO_READY"
    );

  const filteredFieldCount = Math.max(0, merged.size - projectedFields.length);
  if (reasonCodes.length) {
    return blockedResult({
      projection,
      request: input,
      reasonCodes,
      businessContractFingerprint,
      conflictingFields: conflicts,
      invalidFields,
      invalidProvenanceFields,
      missingRequiredFields,
      filteredFieldCount,
    });
  }
  if (optionalMissing.length)
    reasonCodes.push("CUSTOMER_PROFILE_OPTIONAL_FIELD_MISSING");

  return {
    schemaVersion: "ea.customer-profile-projection-result.v1",
    logicalContextId: "customer_profile",
    projectionId: projection.projectionId,
    projectionVersion: projection.projectionVersion,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    subjectId: requestedSubjectId,
    purposeId: projection.purposeId,
    status: optionalMissing.length ? "DEGRADED" : "READY",
    reasonCodes,
    fields: projectedFields,
    missingRequiredFields: [],
    conflictingFields: [],
    invalidFields: [],
    invalidProvenanceFields: [],
    appliedPurposeFilter: true,
    filteredFieldCount,
    sourceEvidence: sourceEvidence(input.sources),
    businessContractFingerprint,
    principalFingerprint: input.principalFingerprint,
    generatedAt: (input.now || new Date()).toISOString(),
  };
}
