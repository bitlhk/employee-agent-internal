import type { CustomerProfileProjectionResultV1 } from "../../shared/customer-profile-contract";
import { loadCustomerProfileContracts } from "./customer-profile-contracts";
import {
  customerProfileSourceContract,
  type NormalizedCustomerProfileSourceV1,
} from "./customer-profile-source-adapters";
import {
  projectCustomerProfile,
  type CustomerProfileProviderInputV1,
} from "./customer-profile-provider";
import { governanceFingerprint } from "./governance/contracts";

export type CustomerProfileSourceReadinessStatusV1 =
  | "READY"
  | "REMEDIATION_REQUIRED"
  | "BLOCKED";

export type CustomerProfileSourceReadinessReportV1 = {
  schemaVersion: "ea.customer-profile-source-readiness.v1";
  roleTemplate: string;
  projectionId: string;
  purposeId: string;
  status: CustomerProfileSourceReadinessStatusV1;
  sourceContracts: Array<{
    sourceContractId: string;
    sourceSystem: string;
    productionReady: boolean;
    providerGaps: string[];
    declaredMappedFieldCount: number;
    observedFieldCount: number;
  }>;
  coverage: {
    projectionFieldCount: number;
    declaredMappedFieldCount: number;
    observedProjectedFieldCount: number;
    missingProjectionMappings: string[];
  };
  taskEvaluations: Array<{
    taskId: string;
    status: CustomerProfileProjectionResultV1["status"];
    reasonCodes: string[];
    requiredFields: string[];
    missingRequiredFields: string[];
    observedMissingRequiredFields: string[];
    declaredMissingRequiredFields: string[];
    projectedFieldCount: number;
    filteredFieldCount: number;
  }>;
  authorization: {
    principalAuthorized: boolean;
    subjectInScope: boolean;
  };
  containsCustomerValues: false;
  generatedAt: string;
  reportFingerprint: string;
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function withoutFingerprint(
  report: Omit<CustomerProfileSourceReadinessReportV1, "reportFingerprint">
) {
  return report;
}

export function assessCustomerProfileSourceReadiness(input: {
  roleTemplate: string;
  principalFingerprint: string;
  principalAuthorized: boolean;
  subjectInScope: boolean;
  requestedSubjectId: string;
  sources: NormalizedCustomerProfileSourceV1[];
  declaredSourceContractIds?: string[];
  taskIds?: string[];
  now?: Date;
  root?: string;
}): CustomerProfileSourceReadinessReportV1 {
  const root = input.root || process.cwd();
  const contracts = loadCustomerProfileContracts(root);
  const projection = contracts.projections.projections.find(
    item => item.roleTemplate === input.roleTemplate
  );
  if (!projection)
    throw new Error(
      `CUSTOMER_PROFILE_PROJECTION_MISSING:${input.roleTemplate}`
    );

  const sourceContractIds = unique([
    ...(input.declaredSourceContractIds || []),
    ...input.sources.map(source => source.sourceContractId),
  ]);
  const sourceByContract = new Map(
    input.sources.map(source => [source.sourceContractId, source])
  );
  const declaredPaths = new Set<string>();
  const sourceContracts = sourceContractIds.map(sourceContractId => {
    const contract = customerProfileSourceContract(sourceContractId, root);
    if (!contract)
      throw new Error(
        `CUSTOMER_PROFILE_SOURCE_CONTRACT_UNKNOWN:${sourceContractId}`
      );
    contract.mappings.forEach(mapping => declaredPaths.add(mapping.targetPath));
    const observed = sourceByContract.get(sourceContractId);
    return {
      sourceContractId,
      sourceSystem: contract.sourceSystem,
      productionReady: observed?.productionReady ?? contract.productionReady,
      providerGaps: [...(observed?.providerGaps ?? contract.providerGaps)],
      declaredMappedFieldCount: unique(
        contract.mappings.map(mapping => mapping.targetPath)
      ).length,
      observedFieldCount: observed?.fields.length || 0,
    };
  });

  const observedProjectedPaths = new Set(
    input.sources.flatMap(source =>
      source.fields
        .map(field => field.path)
        .filter(path => projection.fields.some(field => field.path === path))
    )
  );
  const projectionPaths = projection.fields.map(field => field.path);
  const taskIds = unique(
    input.taskIds ||
      projection.taskRequirements.flatMap(requirement => requirement.taskIds)
  );
  const taskEvaluations = taskIds.map(taskId => {
    const result = projectCustomerProfile({
      roleTemplate: input.roleTemplate,
      taskId,
      requestedSubjectId: input.requestedSubjectId,
      principalFingerprint: input.principalFingerprint,
      principalAuthorized: input.principalAuthorized,
      subjectInScope: input.subjectInScope,
      sources: input.sources,
      now: input.now,
      root,
    } satisfies CustomerProfileProviderInputV1);
    const taskRequired = projection.taskRequirements
      .filter(requirement => requirement.taskIds.includes(taskId))
      .flatMap(requirement => requirement.requiredFields);
    const requiredFields = unique([
      ...projection.requiredCoreFields,
      ...taskRequired,
    ]);
    return {
      taskId,
      status: result.status,
      reasonCodes: [...result.reasonCodes],
      requiredFields,
      missingRequiredFields: [...result.missingRequiredFields],
      observedMissingRequiredFields: requiredFields.filter(
        path => !observedProjectedPaths.has(path)
      ),
      declaredMissingRequiredFields: requiredFields.filter(
        path => !declaredPaths.has(path)
      ),
      projectedFieldCount: result.fields.length,
      filteredFieldCount: result.filteredFieldCount,
    };
  });

  const blocked = taskEvaluations.some(item => item.status === "BLOCKED");
  const degraded = taskEvaluations.some(item => item.status === "DEGRADED");
  const base = withoutFingerprint({
    schemaVersion: "ea.customer-profile-source-readiness.v1",
    roleTemplate: input.roleTemplate,
    projectionId: projection.projectionId,
    purposeId: projection.purposeId,
    status: blocked ? "BLOCKED" : degraded ? "REMEDIATION_REQUIRED" : "READY",
    sourceContracts,
    coverage: {
      projectionFieldCount: projectionPaths.length,
      declaredMappedFieldCount: projectionPaths.filter(path =>
        declaredPaths.has(path)
      ).length,
      observedProjectedFieldCount: observedProjectedPaths.size,
      missingProjectionMappings: projectionPaths.filter(
        path => !declaredPaths.has(path)
      ),
    },
    taskEvaluations,
    authorization: {
      principalAuthorized: input.principalAuthorized,
      subjectInScope: input.subjectInScope,
    },
    containsCustomerValues: false,
    generatedAt: (input.now || new Date()).toISOString(),
  });
  return {
    ...base,
    reportFingerprint: governanceFingerprint(base),
  };
}
