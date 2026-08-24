import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadCustomerProfileContracts,
  runCustomerProfileContractChecks,
} from "./customer-profile-contracts";
import { governanceFingerprint } from "./governance/contracts";

export const CUSTOMER_PROFILE_SOURCE_REMEDIATION_PLAN_PATH =
  "examples/customer-profile-contract-v1/source-remediation-plan.v1.json";

type ReviewStatus =
  | "proposed"
  | "domain_reviewing"
  | "domain_confirmed"
  | "needs_resolution";

export type CustomerProfileSourceRemediationPlanV1 = {
  schemaVersion: "ea.customer-profile-source-remediation-plan.v1";
  planVersion: string;
  status: "proposed" | "domain_reviewing" | "domain_confirmed";
  baseline: {
    businessContractFingerprint: string;
    sourceMappingFingerprint: string;
    environmentEvidence: string;
  };
  activationPolicy: {
    autoActivate: false;
    autoAuthorize: false;
    activeSourceMappingMayChange: false;
    productionBindingMayChange: false;
    requiresDataOwnerReview: true;
    requiresNewSourceContractFingerprint: true;
    requiresNewAuthorizationFingerprint: true;
    requiresFullGateBRerun: true;
  };
  workItems: Array<{
    workItemId: string;
    sourceContractIds: string[];
    ownerRole: string;
    category: string;
    affectedFields: string[];
    observedSourcePaths: string[];
    proposedResolution: string;
    exitCriteria: string[];
    review: {
      status: ReviewStatus;
      reviewerId?: string;
      reviewerRole?: string;
      reviewedAt?: string;
      reviewComment?: string;
    };
  }>;
};

const REQUIRED_WORK_ITEMS = [
  "W-01-authoritative-customer-status",
  "W-02-governed-recent-contact-summary",
  "W-03-investment-preference-facts",
  "W-04-authoritative-time-and-provenance",
  "I-01-stable-subject-lookup",
  "I-02-runtime-row-purpose-authorization",
  "I-03-insurance-policy-facts",
  "I-04-authoritative-time-and-provenance",
  "X-01-enterprise-customer-identity-crosswalk",
] as const;

const REQUIRED_GAP_FIELDS = [
  "subject.customerStatus",
  "serviceScope.inScope",
  "relationship.recentContactSummary",
  "preferences.investmentHorizon",
  "preferences.liquidityNeeds",
  "insurance.renewalAt",
  "insurance.renewalStatus",
  "insurance.currentCoverageSummary",
  "insurance.claimsRiskSummary",
] as const;

function forbiddenKeyPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      forbiddenKeyPaths(item, `${prefix}[${index}]`)
    );
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, item]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      const own =
        /(?:password|secret|credential|accessToken|rawPayload|customerValue)/iu.test(
          key
        )
          ? [path]
          : [];
      return [...own, ...forbiddenKeyPaths(item, path)];
    }
  );
}

export function loadCustomerProfileSourceRemediationPlan(
  root = process.cwd()
): CustomerProfileSourceRemediationPlanV1 {
  return JSON.parse(
    readFileSync(
      resolve(root, CUSTOMER_PROFILE_SOURCE_REMEDIATION_PLAN_PATH),
      "utf8"
    )
  ) as CustomerProfileSourceRemediationPlanV1;
}

export function verifyCustomerProfileSourceRemediationPlan(
  plan: CustomerProfileSourceRemediationPlanV1,
  root = process.cwd()
) {
  const errors: string[] = [];
  if (plan.schemaVersion !== "ea.customer-profile-source-remediation-plan.v1")
    errors.push("Unsupported remediation plan schema");
  if (!plan.planVersion) errors.push("Plan version is required");
  if (
    !["proposed", "domain_reviewing", "domain_confirmed"].includes(plan.status)
  )
    errors.push("Unsupported remediation plan status");

  const contracts = loadCustomerProfileContracts(root);
  const contractReport = runCustomerProfileContractChecks(root, {
    requireDomainConfirmed: true,
  });
  if (
    plan.baseline.businessContractFingerprint !==
    contractReport.businessContractFingerprint
  )
    errors.push("Business contract baseline fingerprint changed");
  if (
    plan.baseline.sourceMappingFingerprint !==
    contractReport.sourceMappingFingerprint
  )
    errors.push("Source mapping baseline fingerprint changed");

  const policy = plan.activationPolicy;
  if (
    policy.autoActivate !== false ||
    policy.autoAuthorize !== false ||
    policy.activeSourceMappingMayChange !== false ||
    policy.productionBindingMayChange !== false
  )
    errors.push("Remediation plan must not activate runtime state");
  if (
    !policy.requiresDataOwnerReview ||
    !policy.requiresNewSourceContractFingerprint ||
    !policy.requiresNewAuthorizationFingerprint ||
    !policy.requiresFullGateBRerun
  )
    errors.push("Remediation promotion gates are incomplete");

  const ids = plan.workItems.map(item => item.workItemId);
  if (new Set(ids).size !== ids.length)
    errors.push("Work item ids must be unique");
  for (const requiredId of REQUIRED_WORK_ITEMS) {
    if (!ids.includes(requiredId))
      errors.push(`Missing work item: ${requiredId}`);
  }

  const contractFields = new Set(
    contracts.contract.fields.map(field => field.path)
  );
  const sourceContracts = new Set(
    contracts.sourceMappings.sources.map(source => source.sourceContractId)
  );
  const coveredFields = new Set<string>();
  for (const item of plan.workItems) {
    if (!item.ownerRole.trim())
      errors.push(`${item.workItemId}: ownerRole required`);
    if (!item.exitCriteria.length)
      errors.push(`${item.workItemId}: exit criteria required`);
    if (!item.proposedResolution.trim())
      errors.push(`${item.workItemId}: proposed resolution required`);
    if (
      ![
        "proposed",
        "domain_reviewing",
        "domain_confirmed",
        "needs_resolution",
      ].includes(item.review.status)
    )
      errors.push(`${item.workItemId}: unsupported review status`);
    for (const sourceContractId of item.sourceContractIds) {
      if (!sourceContracts.has(sourceContractId))
        errors.push(
          `${item.workItemId}: unknown source contract ${sourceContractId}`
        );
    }
    for (const field of item.affectedFields) {
      coveredFields.add(field);
      if (!contractFields.has(field))
        errors.push(`${item.workItemId}: unknown canonical field ${field}`);
    }
  }
  for (const field of REQUIRED_GAP_FIELDS) {
    if (!coveredFields.has(field))
      errors.push(`Unowned readiness gap: ${field}`);
  }
  for (const path of forbiddenKeyPaths(plan))
    errors.push(`Sensitive input is forbidden in remediation plan: ${path}`);

  const confirmed = plan.workItems.filter(
    item => item.review.status === "domain_confirmed"
  ).length;
  return {
    schemaVersion: "ea.customer-profile-source-remediation-report.v1",
    status: errors.length ? "FAIL" : "PASS",
    planVersion: plan.planVersion,
    planStatus: plan.status,
    workItemCount: plan.workItems.length,
    review: { confirmed, total: plan.workItems.length },
    runtimeActivationAllowed: false,
    planFingerprint: governanceFingerprint(plan),
    errors,
  };
}
