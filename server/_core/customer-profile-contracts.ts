import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  CustomerProfileContractV1,
  CustomerProfileDomainReviewV1,
  CustomerProfileProjectionSetV1,
  CustomerProfileSourceMappingSetV1,
} from "../../shared/customer-profile-contract";
import {
  loadLogicalContextCatalog,
  logicalContextIndex,
  LOGICAL_CONTEXT_CATALOG_PATH,
} from "./logical-context-catalog";

export const CUSTOMER_PROFILE_CONTRACT_PATH =
  "examples/customer-profile-contract-v1/contract.v1.json";
export const CUSTOMER_PROFILE_PROJECTIONS_PATH =
  "examples/customer-profile-contract-v1/purpose-projections.v1.json";
export const CUSTOMER_PROFILE_SOURCE_MAPPINGS_PATH =
  "examples/customer-profile-contract-v1/source-mappings.v1.json";

const BUSINESS_CONTRACT_FILES = [
  LOGICAL_CONTEXT_CATALOG_PATH,
  CUSTOMER_PROFILE_CONTRACT_PATH,
  CUSTOMER_PROFILE_PROJECTIONS_PATH,
];
const SOURCE_MAPPING_FILES = [CUSTOMER_PROFILE_SOURCE_MAPPINGS_PATH];
const CONTRACT_FILES = [...BUSINESS_CONTRACT_FILES, ...SOURCE_MAPPING_FILES];

const EXPECTED_PROJECTIONS = new Map([
  [
    "WealthCustomerProfileV1",
    {
      rolePackId: "linggan-bank.wealth-manager",
      roleTemplate: "wealth-manager",
      access: "allow",
    },
  ],
  [
    "InsuranceCustomerProfileV1",
    {
      rolePackId: "linggan-insurance.insurance-advisor",
      roleTemplate: "insurance-advisor",
      access: "allow",
    },
  ],
  [
    "InvestmentResearchCustomerProfileDeniedV1",
    {
      rolePackId: "linggan-finance.investment-research",
      roleTemplate: "investment-researcher",
      access: "deny",
    },
  ],
  [
    "PostLoanRiskCustomerProfileDeniedV1",
    {
      rolePackId: "linggan-bank.post-loan-risk-control",
      roleTemplate: "post-loan-risk-control",
      access: "deny",
    },
  ],
  [
    "AuditCustomerSubjectProjectionV1",
    {
      rolePackId: "linggan-bank.smart-audit",
      roleTemplate: "credential-compliance",
      access: "conditional",
    },
  ],
]);

const FIELD_PATH_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/u;
const DATA_TYPES = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "string_array",
  "object_array",
]);
const SENSITIVITY = new Set(["internal", "sensitive", "restricted"]);
const EXPOSURES = new Set(["raw", "masked", "derived", "summary"]);
const REQUIRED_PROVENANCE = [
  "sourceSystem",
  "sourceRecordRef",
  "asOf",
  "observedAt",
  "mappingRuleVersion",
];

type CustomerProfileContractOptions = {
  requireDomainConfirmed?: boolean;
};

function readJson<T>(root: string, relativePath: string): T {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8")) as T;
}

function fingerprint(root: string, files: string[]): string {
  return createHash("sha256")
    .update(
      files
        .map(file => {
          const digest = createHash("sha256")
            .update(readFileSync(path.join(root, file)))
            .digest("hex");
          return `${file}:${digest}`;
        })
        .join("\n")
    )
    .digest("hex");
}

function validateReview(
  label: string,
  review: CustomerProfileDomainReviewV1,
  errors: string[]
) {
  if (review.status === "proposed") return;
  if (review.status === "domain_reviewing") {
    if (!review.reviewerId?.trim() || !review.reviewerRole?.trim())
      errors.push(
        `${label}: domain_reviewing requires reviewer identity and role`
      );
    return;
  }
  if (review.status === "needs_resolution") {
    if (
      !review.reviewerId?.trim() ||
      !review.reviewerRole?.trim() ||
      !review.reviewComment?.trim()
    ) {
      errors.push(
        `${label}: needs_resolution requires reviewer identity, role and comment`
      );
    }
    return;
  }
  if (review.status === "domain_confirmed") {
    if (
      !review.reviewerId?.trim() ||
      !review.reviewerRole?.trim() ||
      !review.reviewedAt?.trim() ||
      !review.reviewComment?.trim() ||
      !review.groundTruthVersion?.trim()
    ) {
      errors.push(
        `${label}: domain_confirmed requires reviewer identity, role, time, comment and ground-truth version`
      );
    } else if (Number.isNaN(Date.parse(review.reviewedAt))) {
      errors.push(`${label}: reviewedAt must be an ISO timestamp`);
    }
    return;
  }
  errors.push(`${label}: unsupported domain review status`);
}

export function loadCustomerProfileContracts(root = process.cwd()) {
  return {
    contract: readJson<CustomerProfileContractV1>(
      root,
      CUSTOMER_PROFILE_CONTRACT_PATH
    ),
    projections: readJson<CustomerProfileProjectionSetV1>(
      root,
      CUSTOMER_PROFILE_PROJECTIONS_PATH
    ),
    sourceMappings: readJson<CustomerProfileSourceMappingSetV1>(
      root,
      CUSTOMER_PROFILE_SOURCE_MAPPINGS_PATH
    ),
  };
}

export function runCustomerProfileContractChecks(
  root = process.cwd(),
  options: CustomerProfileContractOptions = {}
) {
  const errors: string[] = [];
  for (const file of CONTRACT_FILES) {
    if (!existsSync(path.join(root, file)))
      errors.push(`Contract asset is missing: ${file}`);
  }
  if (errors.length) {
    return {
      schema: "ea.customer-profile-contract-report.v1",
      status: "FAIL" as const,
      errors,
    };
  }

  const { contract, projections, sourceMappings } =
    loadCustomerProfileContracts(root);
  const catalog = loadLogicalContextCatalog(root);
  const catalogEntry = logicalContextIndex(catalog).get("customer_profile");

  if (contract.schemaVersion !== "ea.customer-profile-contract.v1")
    errors.push("Customer Profile contract schema is unsupported");
  if (
    projections.schemaVersion !== "ea.customer-profile-purpose-projections.v1"
  ) {
    errors.push("Customer Profile projection schema is unsupported");
  }
  if (
    sourceMappings.schemaVersion !== "ea.customer-profile-source-mappings.v1"
  ) {
    errors.push("Customer Profile source-mapping schema is unsupported");
  }
  for (const item of [contract, projections, sourceMappings]) {
    if (item.canonicalLogicalContextId !== "customer_profile")
      errors.push("All Customer Profile artifacts must bind customer_profile");
  }
  if (!catalogEntry || catalogEntry.canonicalId !== "customer_profile")
    errors.push(
      "customer_profile is not registered in the Logical Context Catalog"
    );
  else if (
    catalogEntry.contextType !== "business_data" ||
    catalogEntry.status !== "active"
  )
    errors.push("customer_profile must be an active business_data Context");

  if (
    contract.identityRule.stableSubjectIdRequired !== true ||
    contract.identityRule.heuristicIdentityMergeAllowed !== false ||
    contract.identityRule.displayNameIsIdentityProof !== false
  ) {
    errors.push("Customer identity must fail closed on a stable subject ID");
  }
  if (
    contract.conflictRule.modelMayResolveEnterpriseFacts !== false ||
    contract.conflictRule.newestValueAutomaticallyWins !== false ||
    contract.conflictRule.unresolvedConflictStatus !== "BLOCKED"
  ) {
    errors.push(
      "Customer Profile conflict handling must remain deterministic and BLOCKED"
    );
  }
  if (
    contract.missingDataRule.requiredFieldStatus !== "BLOCKED" ||
    contract.missingDataRule.optionalFieldStatus !== "DEGRADED" ||
    contract.missingDataRule.modelMayFillMissingFacts !== false
  ) {
    errors.push("Customer Profile missing-data semantics are invalid");
  }
  if (contract.provenanceRule.fieldLevelRequired !== true)
    errors.push("Customer Profile requires field-level provenance");
  for (const attribute of REQUIRED_PROVENANCE) {
    if (!contract.provenanceRule.requiredAttributes.includes(attribute))
      errors.push(`Customer Profile provenance is missing ${attribute}`);
  }

  const fieldPaths = new Set<string>();
  for (const field of contract.fields || []) {
    if (!FIELD_PATH_PATTERN.test(field.path))
      errors.push(`Invalid Customer Profile field path: ${field.path}`);
    if (fieldPaths.has(field.path))
      errors.push(`Duplicate Customer Profile field: ${field.path}`);
    fieldPaths.add(field.path);
    if (!DATA_TYPES.has(field.dataType))
      errors.push(`${field.path}: unsupported data type ${field.dataType}`);
    if (!SENSITIVITY.has(field.sensitivity))
      errors.push(
        `${field.path}: unsupported sensitivity ${field.sensitivity}`
      );
    if (!field.description?.trim() || field.provenanceRequired !== true)
      errors.push(`${field.path}: description and provenance are required`);
  }
  for (const required of [
    "subject.subjectId",
    "subject.subjectType",
    "subject.displayName",
    "subject.customerStatus",
    "serviceScope.inScope",
  ]) {
    if (!fieldPaths.has(required))
      errors.push(`Required canonical field is missing: ${required}`);
  }
  for (const forbidden of [
    "contact.phone",
    "contact.address",
    "wealth.exactBalance",
    "wealth.holdings",
    "wealth.recommendations",
  ]) {
    if (fieldPaths.has(forbidden))
      errors.push(
        `Broad raw field must not enter customer_profile: ${forbidden}`
      );
  }

  const projectionIds = new Set<string>();
  const rolePackIds = new Set<string>();
  for (const projection of projections.projections || []) {
    if (projectionIds.has(projection.projectionId))
      errors.push(`Duplicate projection ID: ${projection.projectionId}`);
    projectionIds.add(projection.projectionId);
    if (rolePackIds.has(projection.rolePackId))
      errors.push(`Duplicate Role Pack projection: ${projection.rolePackId}`);
    rolePackIds.add(projection.rolePackId);

    const expected = EXPECTED_PROJECTIONS.get(projection.projectionId);
    if (!expected) {
      errors.push(
        `Unexpected Customer Profile projection: ${projection.projectionId}`
      );
    } else if (
      projection.rolePackId !== expected.rolePackId ||
      projection.roleTemplate !== expected.roleTemplate ||
      projection.access !== expected.access
    ) {
      errors.push(
        `${projection.projectionId}: Role Pack projection identity drifted`
      );
    }

    const selected = new Set<string>();
    for (const field of projection.fields || []) {
      if (!fieldPaths.has(field.path))
        errors.push(`${projection.projectionId}: unknown field ${field.path}`);
      if (selected.has(field.path))
        errors.push(
          `${projection.projectionId}: duplicate field ${field.path}`
        );
      selected.add(field.path);
      if (!EXPOSURES.has(field.exposure))
        errors.push(
          `${projection.projectionId}: unsupported exposure ${field.exposure}`
        );
    }
    for (const required of projection.requiredCoreFields || []) {
      if (!selected.has(required))
        errors.push(
          `${projection.projectionId}: required field is not projected: ${required}`
        );
    }
    for (const requirement of projection.taskRequirements || []) {
      if (!requirement.taskIds?.length)
        errors.push(
          `${projection.projectionId}: task requirement has no task IDs`
        );
      for (const required of requirement.requiredFields || []) {
        if (!selected.has(required))
          errors.push(
            `${projection.projectionId}: task field is not projected: ${required}`
          );
      }
    }
    if (projection.access === "deny") {
      if (
        projection.fields.length ||
        projection.requiredCoreFields.length ||
        projection.taskRequirements.length
      ) {
        errors.push(
          `${projection.projectionId}: denied projection must expose no fields`
        );
      }
    } else if (!projection.conditions.length) {
      errors.push(
        `${projection.projectionId}: accessible projection requires conditions`
      );
    }
    if (!projection.purposeId?.trim() || !projection.decisionReason?.trim())
      errors.push(
        `${projection.projectionId}: purpose and decision reason are required`
      );
    validateReview(projection.projectionId, projection.review, errors);
  }
  for (const projectionId of EXPECTED_PROJECTIONS.keys()) {
    if (!projectionIds.has(projectionId))
      errors.push(
        `Required Customer Profile projection is missing: ${projectionId}`
      );
  }

  const sourceContractIds = new Set<string>();
  let productionReadySources = 0;
  for (const source of sourceMappings.sources || []) {
    if (sourceContractIds.has(source.sourceContractId))
      errors.push(`Duplicate source contract: ${source.sourceContractId}`);
    sourceContractIds.add(source.sourceContractId);
    if (!source.stableSubjectPaths?.length)
      errors.push(
        `${source.sourceContractId}: stable subject path is required`
      );
    if (!source.mappings?.length)
      errors.push(`${source.sourceContractId}: field mappings are required`);
    const mappedTargets = new Set<string>();
    for (const mapping of source.mappings || []) {
      if (!mapping.sourcePath?.trim() || !mapping.transform?.trim())
        errors.push(
          `${source.sourceContractId}: source path and transform are required`
        );
      if (!fieldPaths.has(mapping.targetPath))
        errors.push(
          `${source.sourceContractId}: unknown target field ${mapping.targetPath}`
        );
      if (mappedTargets.has(mapping.targetPath))
        errors.push(
          `${source.sourceContractId}: duplicate target mapping ${mapping.targetPath}`
        );
      mappedTargets.add(mapping.targetPath);
    }
    if (!source.providerGaps?.length)
      errors.push(`${source.sourceContractId}: provider gaps must be explicit`);
    if (source.productionReady) {
      productionReadySources += 1;
      if (source.providerGaps.length)
        errors.push(
          `${source.sourceContractId}: a production-ready source cannot retain provider gaps`
        );
    }
  }

  validateReview("CustomerProfileV1", contract.domainReview, errors);
  const confirmedReviews = [
    contract.domainReview,
    ...projections.projections.map(item => item.review),
  ].filter(review => review.status === "domain_confirmed").length;
  const reviewCount = 1 + projections.projections.length;
  if (options.requireDomainConfirmed) {
    if (
      contract.status !== "domain_confirmed" ||
      projections.status !== "domain_confirmed" ||
      confirmedReviews !== reviewCount
    ) {
      errors.push(
        `Domain confirmation gate requires all ${reviewCount} reviews and all contract artifacts; confirmed ${confirmedReviews}`
      );
    }
  }

  return {
    schema: "ea.customer-profile-contract-report.v1",
    status: errors.length ? ("FAIL" as const) : ("PASS" as const),
    contractVersion: contract.contractVersion,
    projectionSetVersion: projections.projectionSetVersion,
    sourceMappingSetVersion: sourceMappings.mappingSetVersion,
    canonicalLogicalContextId: contract.canonicalLogicalContextId,
    canonicalFieldCount: contract.fields.length,
    projectionCount: projections.projections.length,
    sourceContractCount: sourceMappings.sources.length,
    productionReadySourceCount: productionReadySources,
    domainReview: {
      confirmed: confirmedReviews,
      total: reviewCount,
    },
    businessContractFingerprint: fingerprint(root, BUSINESS_CONTRACT_FILES),
    sourceMappingFingerprint: fingerprint(root, SOURCE_MAPPING_FILES),
    evidenceFingerprint: fingerprint(root, CONTRACT_FILES),
    errors,
  };
}
