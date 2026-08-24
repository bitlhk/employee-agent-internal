import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CustomerProfileSourceEnvelopeV1,
  CustomerProfileSourceImplementationContractV1,
} from "../../shared/customer-profile-contract";
import {
  loadCustomerProfileContracts,
  runCustomerProfileContractChecks,
} from "./customer-profile-contracts";
import {
  customerProfileSourceFingerprint,
  type NormalizedCustomerProfileSourceV1,
} from "./customer-profile-source-adapters";
import {
  loadCustomerProfileSourceRemediationPlan,
  verifyCustomerProfileSourceRemediationPlan,
} from "./customer-profile-source-remediation";
import { governanceFingerprint } from "./governance/contracts";

export const CUSTOMER_PROFILE_SOURCE_IMPLEMENTATION_CONTRACT_PATH =
  "examples/customer-profile-contract-v1/source-implementation-contract.v1.json";

type JsonObject = Record<string, unknown>;

export type CustomerProfileSourceExpectedIdentityV1 = {
  organizationId: string;
  principalFingerprint: string;
  authorizationSnapshotId: string;
  authorizationFingerprint: string;
  requestedSubjectId: string;
};

export type CustomerProfileSourceConformanceReportV1 = {
  schemaVersion: "ea.customer-profile-source-conformance-report.v1";
  status: "PASS" | "FAIL";
  sourceContractId: string;
  sourceContractVersion: string;
  sourceContractStatus: CustomerProfileSourceImplementationContractV1["status"];
  sourceContractFingerprint: string;
  sourceResultFingerprint: string;
  subjectMatched: boolean;
  rowScopeApplied: boolean;
  fieldCount: number;
  fieldPaths: string[];
  deniedFieldCount: number;
  runtimeActivationAllowed: false;
  productionReady: false;
  containsCustomerValues: false;
  errors: string[];
  reportFingerprint: string;
};

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "sourceContractId",
  "sourceContractVersion",
  "sourceContractFingerprint",
  "sourceSystem",
  "subjectId",
  "sourceRecordRef",
  "businessAsOf",
  "observedAt",
  "authorizationEvidence",
  "fields",
  "deniedFields",
  "sourceResultFingerprint",
]);
const AUTHORIZATION_KEYS = new Set([
  "organizationId",
  "principalFingerprint",
  "authorizationSnapshotId",
  "authorizationFingerprint",
  "subjectInScope",
  "rowScopeApplied",
  "evaluatedAt",
]);
const FIELD_KEYS = new Set(["path", "value", "provenance"]);
const PROVENANCE_KEYS = new Set([
  "sourceSystem",
  "sourceRecordRef",
  "asOf",
  "observedAt",
  "mappingRuleVersion",
]);
const DENIED_FIELD_KEYS = new Set(["path", "reasonCode"]);
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function unknownKeys(value: unknown, allowed: Set<string>): string[] {
  return Object.keys(object(value)).filter(key => !allowed.has(key));
}

function sourceEnvelope(value: unknown): CustomerProfileSourceEnvelopeV1 {
  const raw = object(value);
  const authorization = object(raw.authorizationEvidence);
  const fields = Array.isArray(raw.fields) ? raw.fields : [];
  const deniedFields = Array.isArray(raw.deniedFields) ? raw.deniedFields : [];
  return {
    schemaVersion: String(
      raw.schemaVersion || ""
    ) as CustomerProfileSourceEnvelopeV1["schemaVersion"],
    sourceContractId: String(raw.sourceContractId || ""),
    sourceContractVersion: String(raw.sourceContractVersion || ""),
    sourceContractFingerprint: String(raw.sourceContractFingerprint || ""),
    sourceSystem: String(raw.sourceSystem || ""),
    subjectId: String(raw.subjectId || ""),
    sourceRecordRef: String(raw.sourceRecordRef || ""),
    businessAsOf: String(raw.businessAsOf || ""),
    observedAt: String(raw.observedAt || ""),
    authorizationEvidence: {
      organizationId: String(authorization.organizationId || ""),
      principalFingerprint: String(authorization.principalFingerprint || ""),
      authorizationSnapshotId: String(
        authorization.authorizationSnapshotId || ""
      ),
      authorizationFingerprint: String(
        authorization.authorizationFingerprint || ""
      ),
      subjectInScope: authorization.subjectInScope as true,
      rowScopeApplied: authorization.rowScopeApplied as true,
      evaluatedAt: String(authorization.evaluatedAt || ""),
    },
    fields: fields.map(item => {
      const field = object(item);
      const provenance = object(field.provenance);
      return {
        path: String(field.path || ""),
        value: field.value,
        provenance: {
          sourceSystem: String(provenance.sourceSystem || ""),
          sourceRecordRef: String(provenance.sourceRecordRef || ""),
          asOf: String(provenance.asOf || ""),
          observedAt: String(provenance.observedAt || ""),
          mappingRuleVersion: String(provenance.mappingRuleVersion || ""),
        },
      };
    }),
    deniedFields: deniedFields.map(item => {
      const denied = object(item);
      return {
        path: String(denied.path || ""),
        reasonCode: String(denied.reasonCode || ""),
      };
    }),
    sourceResultFingerprint: String(raw.sourceResultFingerprint || ""),
  };
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(Date.parse(value))
  );
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

function readJson<T>(root: string, relativePath: string): T {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8")) as T;
}

export function loadCustomerProfileSourceImplementationContract(
  root = process.cwd()
): CustomerProfileSourceImplementationContractV1 {
  return readJson<CustomerProfileSourceImplementationContractV1>(
    root,
    CUSTOMER_PROFILE_SOURCE_IMPLEMENTATION_CONTRACT_PATH
  );
}

export function customerProfileSourceImplementationFingerprint(
  root = process.cwd()
): string {
  const contract = loadCustomerProfileSourceImplementationContract(root);
  const schema = readJson<unknown>(root, contract.response.schemaPath);
  return governanceFingerprint({ contract, schema });
}

export function customerProfileSourceEnvelopeFingerprint(
  envelope: Omit<CustomerProfileSourceEnvelopeV1, "sourceResultFingerprint">
): string {
  return governanceFingerprint(envelope);
}

export function verifyCustomerProfileSourceImplementationContract(
  root = process.cwd()
) {
  const errors: string[] = [];
  if (
    !existsSync(
      resolve(root, CUSTOMER_PROFILE_SOURCE_IMPLEMENTATION_CONTRACT_PATH)
    )
  )
    errors.push("Source implementation contract is missing");
  if (errors.length)
    return {
      schemaVersion:
        "ea.customer-profile-source-implementation-contract-report.v1",
      status: "FAIL" as const,
      sourceContractFingerprint: "",
      runtimeActivationAllowed: false as const,
      errors,
    };

  const contract = loadCustomerProfileSourceImplementationContract(root);
  if (
    contract.schemaVersion !==
    "ea.customer-profile-source-implementation-contract.v1"
  )
    errors.push("Unsupported source implementation contract schema");
  if (contract.canonicalLogicalContextId !== "customer_profile")
    errors.push("Source implementation contract must target customer_profile");
  if (contract.status !== "engineering_candidate")
    errors.push("V1 source implementation contract must remain a candidate");
  if (!existsSync(resolve(root, contract.response.schemaPath)))
    errors.push("Source response schema is missing");

  const business = runCustomerProfileContractChecks(root, {
    requireDomainConfirmed: true,
  });
  if (
    business.status !== "PASS" ||
    business.businessContractFingerprint !==
      contract.baseline.businessContractFingerprint
  )
    errors.push("Business contract baseline fingerprint changed");
  const remediation = verifyCustomerProfileSourceRemediationPlan(
    loadCustomerProfileSourceRemediationPlan(root),
    root,
    { requireDomainConfirmed: true }
  );
  if (
    remediation.status !== "PASS" ||
    remediation.planFingerprint !==
      contract.baseline.sourceRemediationPlanFingerprint
  )
    errors.push("Source remediation baseline fingerprint changed");

  if (
    contract.invocation.allowedArguments.length !== 1 ||
    contract.invocation.allowedArguments[0] !== "subjectId"
  )
    errors.push("Only subjectId may be supplied as a tool argument");
  for (const forbidden of [
    "organizationId",
    "principalId",
    "roleTemplate",
    "purposeId",
    "authorizationFingerprint",
  ]) {
    if (!contract.invocation.forbiddenArguments.includes(forbidden))
      errors.push(
        `Trusted runtime input must be forbidden as argument: ${forbidden}`
      );
  }
  if (
    contract.invocation.purposeProjectionOwner !==
    "ea_customer_profile_provider"
  )
    errors.push("EA Customer Profile Provider must own purpose projection");

  const activeFields = new Set(
    loadCustomerProfileContracts(root).contract.fields.map(field => field.path)
  );
  for (const fieldPath of contract.response.requiredRemediationFields) {
    if (!activeFields.has(fieldPath))
      errors.push(`Unknown required remediation field: ${fieldPath}`);
  }
  const policy = contract.activationPolicy;
  if (
    policy.runtimeActivationAllowed !== false ||
    policy.autoAuthorize !== false ||
    policy.activeSourceMappingMayChange !== false ||
    policy.productionBindingMayChange !== false
  )
    errors.push("Implementation contract must not activate runtime state");
  if (
    !policy.requiresEnvironmentEvidence ||
    !policy.requiresNewAuthorizationFingerprint ||
    !policy.requiresFullGateBRerun ||
    !policy.requiresPromotionReview
  )
    errors.push("Implementation promotion gates are incomplete");

  return {
    schemaVersion:
      "ea.customer-profile-source-implementation-contract-report.v1",
    status: errors.length ? ("FAIL" as const) : ("PASS" as const),
    sourceContractId: contract.sourceContractId,
    sourceContractVersion: contract.contractVersion,
    sourceContractFingerprint: errors.some(
      error => error === "Source response schema is missing"
    )
      ? ""
      : customerProfileSourceImplementationFingerprint(root),
    requiredRemediationFieldCount:
      contract.response.requiredRemediationFields.length,
    runtimeActivationAllowed: false as const,
    errors,
  };
}

function envelopeWithoutFingerprint(
  envelope: CustomerProfileSourceEnvelopeV1
): Omit<CustomerProfileSourceEnvelopeV1, "sourceResultFingerprint"> {
  const { sourceResultFingerprint: _fingerprint, ...body } = envelope;
  return body;
}

export function validateCustomerProfileSourceEnvelope(input: {
  envelope: unknown;
  expectedIdentity: CustomerProfileSourceExpectedIdentityV1;
  root?: string;
}): CustomerProfileSourceConformanceReportV1 {
  const root = input.root || process.cwd();
  const rawEnvelope = object(input.envelope);
  const rawAuthorization = object(rawEnvelope.authorizationEvidence);
  const rawFields = Array.isArray(rawEnvelope.fields) ? rawEnvelope.fields : [];
  const rawDeniedFields = Array.isArray(rawEnvelope.deniedFields)
    ? rawEnvelope.deniedFields
    : [];
  const envelope = sourceEnvelope(input.envelope);
  const contractReport =
    verifyCustomerProfileSourceImplementationContract(root);
  const contract = loadCustomerProfileSourceImplementationContract(root);
  const expectedContractFingerprint =
    customerProfileSourceImplementationFingerprint(root);
  const errors = [...contractReport.errors];

  if (!Array.isArray(rawEnvelope.fields))
    errors.push("Envelope fields must be an array");
  if (!Array.isArray(rawEnvelope.deniedFields))
    errors.push("Envelope deniedFields must be an array");
  if (
    !rawEnvelope.authorizationEvidence ||
    typeof rawEnvelope.authorizationEvidence !== "object" ||
    Array.isArray(rawEnvelope.authorizationEvidence)
  )
    errors.push("Envelope authorizationEvidence must be an object");
  for (const key of unknownKeys(rawEnvelope, TOP_LEVEL_KEYS))
    errors.push(`Unexpected envelope property: ${key}`);
  for (const key of unknownKeys(rawAuthorization, AUTHORIZATION_KEYS))
    errors.push(`Unexpected authorization property: ${key}`);
  rawFields.forEach((field, index) => {
    const rawField = object(field);
    for (const key of unknownKeys(rawField, FIELD_KEYS))
      errors.push(`Unexpected field property at ${index}: ${key}`);
    for (const key of unknownKeys(rawField.provenance, PROVENANCE_KEYS))
      errors.push(
        `Unexpected provenance property at ${String(rawField.path || index)}: ${key}`
      );
  });
  rawDeniedFields.forEach((field, index) => {
    for (const key of unknownKeys(field, DENIED_FIELD_KEYS))
      errors.push(`Unexpected denied-field property at ${index}: ${key}`);
  });

  if (envelope.schemaVersion !== "ea.customer-profile-source-envelope.v1")
    errors.push("Unsupported source envelope schema");
  if (envelope.sourceContractId !== contract.sourceContractId)
    errors.push("Source contract id does not match implementation contract");
  if (envelope.sourceContractVersion !== contract.contractVersion)
    errors.push(
      "Source contract version does not match implementation contract"
    );
  if (envelope.sourceContractFingerprint !== expectedContractFingerprint)
    errors.push(
      "Source contract fingerprint does not match implementation contract"
    );
  if (!envelope.sourceSystem.trim()) errors.push("Source system is required");
  if (!envelope.sourceRecordRef.trim())
    errors.push("Opaque source record reference is required");
  if (!validTimestamp(envelope.businessAsOf))
    errors.push("Authoritative businessAsOf is required");
  if (!validTimestamp(envelope.observedAt))
    errors.push("Observed timestamp is invalid");
  if (
    validTimestamp(envelope.businessAsOf) &&
    validTimestamp(envelope.observedAt) &&
    Date.parse(envelope.businessAsOf) > Date.parse(envelope.observedAt)
  )
    errors.push("businessAsOf must not be later than observedAt");

  const expected = input.expectedIdentity;
  const authorization = envelope.authorizationEvidence;
  if (authorization.organizationId !== expected.organizationId)
    errors.push("Authorization organization does not match runtime principal");
  if (authorization.principalFingerprint !== expected.principalFingerprint)
    errors.push(
      "Authorization principal fingerprint does not match runtime principal"
    );
  if (
    authorization.authorizationSnapshotId !== expected.authorizationSnapshotId
  )
    errors.push("Authorization snapshot does not match runtime principal");
  if (
    authorization.authorizationFingerprint !== expected.authorizationFingerprint
  )
    errors.push("Authorization fingerprint does not match runtime principal");
  if (authorization.subjectInScope !== true)
    errors.push("Source did not attest subject scope");
  if (authorization.rowScopeApplied !== true)
    errors.push("Source did not apply row authorization");
  if (!validTimestamp(authorization.evaluatedAt))
    errors.push("Authorization evaluation timestamp is invalid");
  if (envelope.subjectId !== expected.requestedSubjectId)
    errors.push("Source subject does not match requested subject");

  const definitions = new Map(
    loadCustomerProfileContracts(root).contract.fields.map(field => [
      field.path,
      field,
    ])
  );
  const seenPaths = new Set<string>();
  for (const field of envelope.fields) {
    if (seenPaths.has(field.path))
      errors.push(`Duplicate canonical field: ${field.path}`);
    seenPaths.add(field.path);
    const definition = definitions.get(field.path);
    if (!definition) {
      errors.push(`Unknown canonical field: ${field.path}`);
      continue;
    }
    if (!valueMatches(definition.dataType, field.value))
      errors.push(`Canonical field type is invalid: ${field.path}`);
    const provenance = field.provenance;
    if (
      provenance.sourceSystem !== envelope.sourceSystem ||
      provenance.sourceRecordRef !== envelope.sourceRecordRef
    )
      errors.push(`Field provenance identity is inconsistent: ${field.path}`);
    if (!validTimestamp(provenance.asOf))
      errors.push(`Field provenance asOf is invalid: ${field.path}`);
    if (!validTimestamp(provenance.observedAt))
      errors.push(`Field provenance observedAt is invalid: ${field.path}`);
    if (!provenance.mappingRuleVersion.trim())
      errors.push(`Field mapping rule version is required: ${field.path}`);
  }
  const subjectField = envelope.fields.find(
    field => field.path === "subject.subjectId"
  );
  if (subjectField?.value !== envelope.subjectId)
    errors.push("Canonical subject field does not match envelope subject");
  const scopeField = envelope.fields.find(
    field => field.path === "serviceScope.inScope"
  );
  if (scopeField?.value !== true)
    errors.push("Canonical service scope must be true after row authorization");
  for (const fieldPath of contract.response.requiredRemediationFields) {
    if (!seenPaths.has(fieldPath))
      errors.push(`Required remediation field is missing: ${fieldPath}`);
  }

  for (const denied of envelope.deniedFields) {
    if (!denied.path.trim() || !denied.reasonCode.trim())
      errors.push("Denied fields require path and reason code");
  }
  const expectedResultFingerprint = customerProfileSourceEnvelopeFingerprint(
    envelopeWithoutFingerprint(envelope)
  );
  if (envelope.sourceResultFingerprint !== expectedResultFingerprint)
    errors.push("Source result fingerprint is invalid");

  const base = {
    schemaVersion: "ea.customer-profile-source-conformance-report.v1" as const,
    status: errors.length ? ("FAIL" as const) : ("PASS" as const),
    sourceContractId: envelope.sourceContractId,
    sourceContractVersion: envelope.sourceContractVersion,
    sourceContractStatus: contract.status,
    sourceContractFingerprint: expectedContractFingerprint,
    sourceResultFingerprint: envelope.sourceResultFingerprint,
    subjectMatched: envelope.subjectId === expected.requestedSubjectId,
    rowScopeApplied: authorization.rowScopeApplied === true,
    fieldCount: envelope.fields.length,
    fieldPaths: Array.from(seenPaths).sort(),
    deniedFieldCount: envelope.deniedFields.length,
    runtimeActivationAllowed: false as const,
    productionReady: false as const,
    containsCustomerValues: false as const,
    errors: Array.from(new Set(errors)),
  };
  return {
    ...base,
    reportFingerprint: governanceFingerprint(base),
  };
}

export function adaptCustomerProfileSourceEnvelopeCandidate(input: {
  envelope: CustomerProfileSourceEnvelopeV1;
  expectedIdentity: CustomerProfileSourceExpectedIdentityV1;
  root?: string;
}): NormalizedCustomerProfileSourceV1 {
  const report = validateCustomerProfileSourceEnvelope(input);
  if (report.status !== "PASS")
    throw new Error(
      `CUSTOMER_PROFILE_SOURCE_ENVELOPE_INVALID:${report.errors.join("|")}`
    );
  const envelope = input.envelope;
  const source: NormalizedCustomerProfileSourceV1 = {
    sourceContractId: envelope.sourceContractId,
    sourceSystem: envelope.sourceSystem,
    subjectId: envelope.subjectId,
    sourceRecordRef: envelope.sourceRecordRef,
    asOf: envelope.businessAsOf,
    observedAt: envelope.observedAt,
    productionReady: false,
    providerGaps: ["SOURCE_IMPLEMENTATION_CANDIDATE_NOT_PROMOTED"],
    fields: envelope.fields.map(field => ({
      path: field.path,
      value: field.value,
      provenance: { ...field.provenance },
    })),
    resultFingerprint: "",
  };
  source.resultFingerprint = customerProfileSourceFingerprint(source);
  return source;
}
