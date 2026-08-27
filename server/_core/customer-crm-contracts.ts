import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  CustomerCrmDomainProfileSchemaSetV1,
  CustomerCrmFieldAuthorityMatrixV1,
  CustomerCrmIdentityPolicyV1,
} from "../../shared/customer-crm-contract";

export const CUSTOMER_CRM_IDENTITY_POLICY_PATH =
  "examples/customer-crm-v1/customer-identity-policy.v1.json";
export const CUSTOMER_CRM_FIELD_AUTHORITY_PATH =
  "examples/customer-crm-v1/customer-field-authority-matrix.v1.json";
export const CUSTOMER_CRM_DOMAIN_SCHEMAS_PATH =
  "examples/customer-crm-v1/customer-domain-profile-schemas.v1.json";

const CONTRACT_FILES = [
  CUSTOMER_CRM_IDENTITY_POLICY_PATH,
  CUSTOMER_CRM_FIELD_AUTHORITY_PATH,
  CUSTOMER_CRM_DOMAIN_SCHEMAS_PATH,
];
const FIELD_PATH_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/u;

function readJson<T>(root: string, relativePath: string): T {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8")) as T;
}

function fingerprint(root: string): string {
  return createHash("sha256")
    .update(
      CONTRACT_FILES.map(file => {
        const digest = createHash("sha256")
          .update(readFileSync(path.join(root, file)))
          .digest("hex");
        return `${file}:${digest}`;
      }).join("\n")
    )
    .digest("hex");
}

export function loadCustomerCrmContracts(root = process.cwd()) {
  return {
    identity: readJson<CustomerCrmIdentityPolicyV1>(
      root,
      CUSTOMER_CRM_IDENTITY_POLICY_PATH
    ),
    authority: readJson<CustomerCrmFieldAuthorityMatrixV1>(
      root,
      CUSTOMER_CRM_FIELD_AUTHORITY_PATH
    ),
    domainSchemas: readJson<CustomerCrmDomainProfileSchemaSetV1>(
      root,
      CUSTOMER_CRM_DOMAIN_SCHEMAS_PATH
    ),
  };
}

export function runCustomerCrmContractChecks(root = process.cwd()) {
  const errors: string[] = [];
  for (const file of CONTRACT_FILES) {
    if (!existsSync(path.join(root, file)))
      errors.push(`CRM contract asset is missing: ${file}`);
  }
  if (errors.length) {
    return {
      schema: "ea.customer-crm-contract-report.v1",
      status: "FAIL" as const,
      errors,
    };
  }

  const { identity, authority, domainSchemas } = loadCustomerCrmContracts(root);

  if (identity.schemaVersion !== "ea.customer-crm-identity-policy.v1")
    errors.push("CRM identity policy schema is unsupported");
  if (authority.schemaVersion !== "ea.customer-crm-field-authority-matrix.v1")
    errors.push("CRM field-authority schema is unsupported");
  if (
    domainSchemas.schemaVersion !== "ea.customer-crm-domain-profile-schemas.v1"
  )
    errors.push("CRM domain-profile schema is unsupported");

  if (
    identity.globalCustomerId.required !== true ||
    identity.globalCustomerId.immutable !== true ||
    !identity.globalCustomerId.namespace.trim()
  ) {
    errors.push("CRM requires an immutable Global Customer ID");
  }
  if (
    identity.mergePolicy.automaticMergeAllowed !== false ||
    identity.mergePolicy.displayNameMayMatch !== false ||
    identity.mergePolicy.phoneMayMatch !== false ||
    identity.mergePolicy.modelMayMatch !== false ||
    identity.mergePolicy.unresolvedStatus !== "identity_review_required"
  ) {
    errors.push("CRM identity merge must fail closed without a Crosswalk");
  }

  const sourceSystems = new Set<string>();
  for (const source of identity.sources || []) {
    if (!source.sourceSystem.trim() || !source.sourceCustomerIdPath.trim())
      errors.push("CRM source identity requires a system and customer ID path");
    if (sourceSystems.has(source.sourceSystem))
      errors.push(`Duplicate CRM identity source: ${source.sourceSystem}`);
    sourceSystems.add(source.sourceSystem);
  }
  for (const source of [
    "wealth_assistant_customer",
    "insurance_customer_profile",
    "twenty_crm",
  ]) {
    if (!sourceSystems.has(source))
      errors.push(`Required CRM identity source is missing: ${source}`);
  }

  if (
    authority.canonicalLogicalContextId !== "customer_profile" ||
    authority.provenanceRequired !== true
  ) {
    errors.push(
      "CRM field authority must preserve customer_profile and provenance"
    );
  }
  const fieldPatterns = new Set<string>();
  for (const rule of authority.rules || []) {
    if (!rule.fieldPattern.trim() || !rule.authority.length)
      errors.push("CRM field-authority rule requires a pattern and authority");
    if (fieldPatterns.has(rule.fieldPattern))
      errors.push(`Duplicate CRM field-authority rule: ${rule.fieldPattern}`);
    fieldPatterns.add(rule.fieldPattern);
    if (!rule.notes.trim())
      errors.push(`${rule.fieldPattern}: authority rationale is required`);
  }
  const suggestions = authority.rules.find(
    rule => rule.fieldPattern === "suggestion.*"
  );
  if (
    suggestions?.crmWriteMode !== "derived" ||
    suggestions.confirmationRequired !== true ||
    suggestions.runtimeUse !== "denied"
  ) {
    errors.push("Unconfirmed suggestions must not become Runtime facts");
  }
  const products = authority.rules.find(
    rule => rule.fieldPattern === "product.*"
  );
  if (
    products?.crmWriteMode !== "reference_only" ||
    products.runtimeUse !== "denied"
  ) {
    errors.push("Product master data must remain outside Customer Profile");
  }

  if (
    domainSchemas.unknownProfilePolicy.storageAllowed !== true ||
    domainSchemas.unknownProfilePolicy.runtimeAllowed !== false ||
    domainSchemas.unknownProfilePolicy.reviewStatus !== "schema_review_required"
  ) {
    errors.push("Unknown CRM profile types must be quarantined from Runtime");
  }
  const profileTypes = new Set<string>();
  let runtimeApprovedFieldCount = 0;
  for (const schema of domainSchemas.schemas || []) {
    if (profileTypes.has(schema.profileType))
      errors.push(`Duplicate CRM profile type: ${schema.profileType}`);
    profileTypes.add(schema.profileType);
    if (!schema.detailSchemaVersion.trim())
      errors.push(`${schema.profileType}: detailSchemaVersion is required`);
    const paths = new Set<string>();
    for (const field of schema.fields || []) {
      if (!FIELD_PATH_PATTERN.test(field.path))
        errors.push(`${schema.profileType}: invalid field path ${field.path}`);
      if (!field.path.startsWith("detail."))
        errors.push(`${schema.profileType}: domain field must be under detail`);
      if (paths.has(field.path))
        errors.push(`${schema.profileType}: duplicate field ${field.path}`);
      paths.add(field.path);
      if (field.provenanceRequired !== true)
        errors.push(`${schema.profileType}.${field.path}: provenance required`);
      if (field.runtimeApproved) runtimeApprovedFieldCount += 1;
    }
  }
  for (const profileType of ["wealth", "auto_insurance", "life_insurance"]) {
    if (!profileTypes.has(profileType))
      errors.push(`Required CRM profile type is missing: ${profileType}`);
  }

  if (errors.length) {
    return {
      schema: "ea.customer-crm-contract-report.v1",
      status: "FAIL" as const,
      errors,
    };
  }
  return {
    schema: "ea.customer-crm-contract-report.v1",
    status: "PASS" as const,
    contractFingerprint: fingerprint(root),
    sourceCount: sourceSystems.size,
    authorityRuleCount: authority.rules.length,
    profileSchemaCount: domainSchemas.schemas.length,
    runtimeApprovedFieldCount,
    boundaries: {
      heuristicIdentityMergeAllowed: false,
      unconfirmedSuggestionsAreFacts: false,
      productMasterDataInCustomerProfile: false,
      unknownProfileRuntimeAllowed: false,
    },
  };
}
